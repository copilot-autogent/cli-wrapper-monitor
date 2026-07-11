/**
 * Pure functions for the static HTML dashboard generator.
 * Extracted here so they can be unit-tested without filesystem access.
 */

import type { MetricSnapshot } from "./types.js";
import { extractTrendRow } from "./trend-report.js";
import { diffSnapshots } from "./diff.js";
import {
  buildDriftMagnitude,
  classifyDigestTier,
  type DigestTier,
} from "./digest-tier.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SummaryCardData {
  capturedAt: string;
  date: string;
  toolCount: number | null;
  hookCount: number | null;
  systemPromptChars: number | null;
  systemPromptTokens: number | null;
  headroomPct: number | null;
  model: string;
  sdkVersion: string;
}

export interface SparklinePoint {
  date: string;
  value: number | null;
}

export interface RegressionEntry {
  date: string;
  severity: "BREAKING" | "WARNING";
  description: string;
}

export interface ModelPoolEntry {
  id: string;
  state: string;
  contextWindow: number;
  /** Date when model first appeared in baselines, ISO date string */
  firstSeen: string;
  /** Date when model was last seen, or null if still present in latest */
  lastSeen: string | null;
}

// ---------------------------------------------------------------------------
// Summary card
// ---------------------------------------------------------------------------

/**
 * Extract a summary card data object from the most-recent snapshot.
 * Defensively sorts by capturedAt to guarantee the latest is selected
 * regardless of input ordering.
 */
export function extractSummaryCard(snapshots: MetricSnapshot[]): SummaryCardData | null {
  if (snapshots.length === 0) return null;

  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime()
  );
  const latest = sorted[sorted.length - 1];
  const row = extractTrendRow(latest);

  return {
    capturedAt: latest.capturedAt,
    date: row.date,
    toolCount: row.toolCount,
    hookCount: latest.hookCount ?? null,
    systemPromptChars: row.systemPromptChars,
    systemPromptTokens: row.systemPromptTokens,
    headroomPct: row.headroomPct,
    model: latest.model,
    sdkVersion: latest.sdkVersion,
  };
}

// ---------------------------------------------------------------------------
// Sparkline data transforms
// ---------------------------------------------------------------------------

/** Extract tool count series from snapshots, one point per snapshot. */
export function extractToolCountSeries(snapshots: MetricSnapshot[]): SparklinePoint[] {
  return snapshots.map((s) => {
    const row = extractTrendRow(s);
    return { date: row.date, value: row.toolCount };
  });
}

/** Extract system prompt tokens series from snapshots. */
export function extractSystemPromptTokensSeries(snapshots: MetricSnapshot[]): SparklinePoint[] {
  return snapshots.map((s) => {
    const row = extractTrendRow(s);
    return { date: row.date, value: row.systemPromptTokens };
  });
}

/** Extract system prompt char count series from snapshots. */
export function extractSystemPromptCharsSeries(snapshots: MetricSnapshot[]): SparklinePoint[] {
  return snapshots.map((s) => {
    const row = extractTrendRow(s);
    return { date: row.date, value: row.systemPromptChars };
  });
}

/** Extract injection refusal rate series from snapshots. */
export function extractInjectionRefusalSeries(snapshots: MetricSnapshot[]): SparklinePoint[] {
  return snapshots.map((s) => {
    const row = extractTrendRow(s);
    return { date: row.date, value: row.injectionRefusedRate };
  });
}

// ---------------------------------------------------------------------------
// Regression extractor
// ---------------------------------------------------------------------------

/**
 * Scan sequential snapshot pairs and extract BREAKING/WARNING changes.
 * Sorts snapshots by capturedAt before comparing to ensure correct order
 * regardless of input ordering.
 * Returns one entry per detected regression event.
 */
export function extractRegressions(snapshots: MetricSnapshot[]): RegressionEntry[] {
  if (snapshots.length < 2) return [];

  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime()
  );

  const entries: RegressionEntry[] = [];
  const BREAKING_THRESHOLD = 10; // >10% increase = BREAKING
  const WARNING_THRESHOLD = 5;   // >5% increase = WARNING

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const date = curr.capturedAt.slice(0, 10);

    const prevRow = extractTrendRow(prev);
    const currRow = extractTrendRow(curr);

    // Check system prompt chars INCREASES only (decreases are positive news, not regressions)
    if (prevRow.systemPromptChars !== null && currRow.systemPromptChars !== null && prevRow.systemPromptChars > 0) {
      const deltaPct = ((currRow.systemPromptChars - prevRow.systemPromptChars) / prevRow.systemPromptChars) * 100;
      if (deltaPct > BREAKING_THRESHOLD) {
        entries.push({
          date,
          severity: "BREAKING",
          description: `systemPromptChars +${deltaPct.toFixed(1)}% (${fmtNum(prevRow.systemPromptChars)} → ${fmtNum(currRow.systemPromptChars)})`,
        });
      } else if (deltaPct > WARNING_THRESHOLD) {
        entries.push({
          date,
          severity: "WARNING",
          description: `systemPromptChars +${deltaPct.toFixed(1)}% (${fmtNum(prevRow.systemPromptChars)} → ${fmtNum(currRow.systemPromptChars)})`,
        });
      }
    }

    // Check tool count changes: any drop is BREAKING (structural); increases are WARNING only
    // when > WARNING_THRESHOLD percent — avoids noise from trivial +1 additions.
    if (prevRow.toolCount !== null && currRow.toolCount !== null && prevRow.toolCount !== currRow.toolCount) {
      const delta = currRow.toolCount - prevRow.toolCount;
      if (delta < 0) {
        // Any tool loss is BREAKING, consistent with severity.ts structural-break rule
        entries.push({
          date,
          severity: "BREAKING",
          description: `toolCount ${delta} (${prevRow.toolCount} → ${currRow.toolCount})`,
        });
      } else if (prevRow.toolCount > 0) {
        const pct = (delta / prevRow.toolCount) * 100;
        if (pct > BREAKING_THRESHOLD) {
          entries.push({
            date,
            severity: "BREAKING",
            description: `toolCount +${delta} (+${pct.toFixed(1)}%) (${prevRow.toolCount} → ${currRow.toolCount})`,
          });
        } else if (pct > WARNING_THRESHOLD) {
          entries.push({
            date,
            severity: "WARNING",
            description: `toolCount +${delta} (+${pct.toFixed(1)}%) (${prevRow.toolCount} → ${currRow.toolCount})`,
          });
        }
      }
    }

    // Check hook count changes: any drop is BREAKING; increases only flagged when > threshold
    const prevHook = prev.hookCount ?? null;
    const currHook = curr.hookCount ?? null;
    if (prevHook !== null && currHook !== null && prevHook !== currHook) {
      const delta = currHook - prevHook;
      if (delta < 0) {
        entries.push({
          date,
          severity: "BREAKING",
          description: `hookCount ${delta} (${prevHook} → ${currHook})`,
        });
      } else if (prevHook > 0) {
        const pct = (delta / prevHook) * 100;
        if (pct > WARNING_THRESHOLD) {
          entries.push({
            date,
            severity: pct > BREAKING_THRESHOLD ? "BREAKING" : "WARNING",
            description: `hookCount +${delta} (+${pct.toFixed(1)}%) (${prevHook} → ${currHook})`,
          });
        }
      }
    }

    // Check injection refusal rate drop using absolute threshold to avoid
    // percentage blow-up when the baseline rate is near zero.
    if (prevRow.injectionRefusedRate !== null && currRow.injectionRefusedRate !== null) {
      const absDrop = prevRow.injectionRefusedRate - currRow.injectionRefusedRate; // positive = drop
      if (absDrop > 0.05) {
        // Use relative % only when baseline is large enough (>= 0.05) to be meaningful
        const deltaPct = prevRow.injectionRefusedRate >= 0.05
          ? -((absDrop / prevRow.injectionRefusedRate) * 100)
          : -(absDrop * 100); // express as absolute percentage-point drop
        entries.push({
          date,
          severity: absDrop > 0.1 ? "BREAKING" : "WARNING",
          description: `injectionRefusalRate ${deltaPct.toFixed(1)}% (${(prevRow.injectionRefusedRate * 100).toFixed(1)}% → ${(currRow.injectionRefusedRate * 100).toFixed(1)}%)`,
        });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Model pool tracker
// ---------------------------------------------------------------------------

/**
 * Track model pool evolution across snapshots.
 * Returns unique models with their first/last seen dates.
 *
 * A model's `lastSeen` is null when it appeared in the latest snapshot that
 * contains a modelPool. If the latest snapshot has no modelPool, active/retired
 * status is derived from the most recent snapshot that does.
 */
export function extractModelPoolHistory(snapshots: MetricSnapshot[]): ModelPoolEntry[] {
  const modelMap = new Map<string, ModelPoolEntry>();

  // Find the latest snapshot that actually has a modelPool field
  const latestWithPool = [...snapshots]
    .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime())
    .reverse()
    .find((s) => s.modelPool != null);

  const latestModelIds = new Set<string>();
  if (latestWithPool?.modelPool) {
    for (const m of latestWithPool.modelPool.models) {
      latestModelIds.add(m.id);
    }
  }

  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime()
  );

  for (const snap of sorted) {
    if (!snap.modelPool) continue;
    const date = snap.capturedAt.slice(0, 10);

    for (const m of snap.modelPool.models) {
      const existing = modelMap.get(m.id);
      if (!existing) {
        modelMap.set(m.id, {
          id: m.id,
          state: m.state,
          contextWindow: m.contextWindow,
          firstSeen: date,
          lastSeen: latestModelIds.has(m.id) ? null : date,
        });
      } else {
        // Update to latest state/contextWindow
        existing.state = m.state;
        existing.contextWindow = m.contextWindow;
        if (!latestModelIds.has(m.id)) {
          existing.lastSeen = date;
        } else {
          existing.lastSeen = null;
        }
      }
    }
  }

  return Array.from(modelMap.values()).sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Prompt section stacked bar chart
// ---------------------------------------------------------------------------

/** One bar entry in the section stacked bar chart. */
export interface PromptSectionBar {
  date: string;
  /** Sections in stable render order (Introduction, Safety, Tools, Other) */
  sections: Array<{ name: string; charCount: number }>;
  /** Total char count across all sections */
  totalChars: number;
}

/** Stable display order for section colours. */
const SECTION_ORDER = ['Introduction', 'Safety', 'Tools', 'Other'];

/** Colour palette for each section bucket. */
export const SECTION_COLORS: Record<string, string> = {
  Introduction: '#3498db',
  Safety: '#e74c3c',
  Tools: '#2ecc71',
  Other: '#95a5a6',
};

/**
 * Extract per-snapshot prompt section data for a stacked bar chart.
 * Snapshots without `promptSections` are skipped.
 */
export function extractPromptSectionBars(snapshots: MetricSnapshot[]): PromptSectionBar[] {
  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
  );

  const bars: PromptSectionBar[] = [];
  for (const snap of sorted) {
    if (!snap.promptSections || snap.promptSections.length === 0) continue;
    const sectionMap = new Map(snap.promptSections.map((s) => [s.name, s.charCount]));
    const sections = SECTION_ORDER.map((name) => ({
      name,
      charCount: sectionMap.get(name) ?? 0,
    }));
    bars.push({
      date: snap.capturedAt.slice(0, 10),
      sections,
      totalChars: snap.promptSections.reduce((sum, s) => sum + s.charCount, 0),
    });
  }
  return bars;
}

/**
 * Generate a stacked bar chart SVG showing prompt section breakdown over time.
 * Returns an SVG string suitable for inline embedding, or an "No data" placeholder.
 */
export function generatePromptSectionStackedBarSVG(
  bars: PromptSectionBar[],
  opts: {
    width?: number;
    height?: number;
    label?: string;
  } = {},
): string {
  const { width = 700, height = 180, label = 'System Prompt Section Breakdown (chars)' } = opts;

  if (bars.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="11" fill="#999">No section data available</text></svg>`;
  }

  const PAD = { top: 20, right: 20, bottom: 50, left: 60 };
  const pw = width - PAD.left - PAD.right;
  const ph = height - PAD.top - PAD.bottom;

  const maxTotal = bars.reduce((m, b) => Math.max(m, b.totalChars), 0) || 1;
  const barW = Math.max(4, Math.floor(pw / bars.length) - 2);

  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui,-apple-system,sans-serif">`,
    `<rect width="${width}" height="${height}" fill="#f8f9fa" rx="6"/>`,
    `<rect x="${PAD.left}" y="${PAD.top}" width="${pw}" height="${ph}" fill="#ffffff" rx="3" stroke="#dee2e6" stroke-width="1"/>`,
  ];

  // Y-axis: max label
  const fmtK = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v);
  lines.push(
    `<text x="${PAD.left - 4}" y="${PAD.top + 9}" text-anchor="end" font-size="9" fill="#666">${fmtK(maxTotal)}</text>`,
    `<text x="${PAD.left - 4}" y="${PAD.top + ph}" text-anchor="end" font-size="9" fill="#666">0</text>`,
  );

  // Bars — accumulate exact fractional heights and use floor to emit integer
  // pixel segments. This ensures the total rendered height never exceeds `ph`.
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const x = PAD.left + Math.round((i / bars.length) * pw) + 1;
    let yBase = PAD.top + ph;
    let heightAccum = 0;

    for (const sec of bar.sections) {
      if (sec.charCount === 0) continue;
      const exactH = (sec.charCount / maxTotal) * ph;
      heightAccum += exactH;
      const segH = Math.floor(heightAccum);
      heightAccum -= segH;
      if (segH <= 0) continue; // skip sub-pixel segments
      yBase -= segH;
      const colour = SECTION_COLORS[sec.name] ?? '#bdc3c7';
      lines.push(
        `<rect x="${x}" y="${yBase}" width="${barW}" height="${segH}" fill="${colour}"><title>${bar.date} – ${sec.name}: ${sec.charCount.toLocaleString()} chars</title></rect>`,
      );
    }

    // X-axis date label (every bar or thinned when many bars)
    if (bars.length <= 10 || i % Math.ceil(bars.length / 10) === 0) {
      lines.push(
        `<text x="${x + barW / 2}" y="${PAD.top + ph + 14}" text-anchor="middle" font-size="8" fill="#666" transform="rotate(-35 ${x + barW / 2} ${PAD.top + ph + 14})">${bar.date}</text>`,
      );
    }
  }

  // Legend
  let lx = PAD.left;
  const ly = height - 10;
  for (const name of SECTION_ORDER) {
    const colour = SECTION_COLORS[name] ?? '#bdc3c7';
    lines.push(
      `<rect x="${lx}" y="${ly - 8}" width="10" height="10" fill="${colour}"/>`,
      `<text x="${lx + 13}" y="${ly}" font-size="9" fill="#555">${name}</text>`,
    );
    lx += 80;
  }

  // Title label
  if (label) {
    lines.push(
      `<text x="${width / 2}" y="${height - 35}" text-anchor="middle" font-size="10" fill="#555" font-weight="600">${label}</text>`,
    );
  }

  lines.push('</svg>');
  return lines.join('\n');
}



/**
 * Generate a compact SVG sparkline for a series of data points.
 * Returns an SVG string suitable for inline embedding.
 *
 * @param points - Data points to render.
 * @param opts.milestones - Optional map of ISO date (YYYY-MM-DD) → annotation text.
 *   Annotated dates are rendered as vertical dashed milestone markers with tooltips.
 */
export function generateSparklineSVG(
  points: SparklinePoint[],
  opts: {
    width?: number;
    height?: number;
    strokeColor?: string;
    label?: string;
    yUnit?: string;
    formatValue?: (v: number) => string;
    /** Annotated dates: date → note text. Rendered as milestone markers on the sparkline. */
    milestones?: Record<string, string>;
  } = {}
): string {
  const {
    width = 600,
    height = 120,
    strokeColor = "#2980b9",
    label = "",
    yUnit = "",
    formatValue = (v: number) => fmtNum(v),
    milestones = {},
  } = opts;

  const PAD = { top: 20, right: 20, bottom: 30, left: 60 };
  const pw = width - PAD.left - PAD.right;
  const ph = height - PAD.top - PAD.bottom;

  // Sort valid points by date to ensure monotonic x-axis rendering
  const valid = points
    .filter((p): p is SparklinePoint & { value: number } => p.value !== null)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  if (valid.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="11" fill="#999">No data</text></svg>`;
  }
  if (valid.length < 3) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="11" fill="#aaa">Not enough data (${valid.length} point${valid.length !== 1 ? "s" : ""} — need ≥3)</text></svg>`;
  }

  // Use reduce instead of spread to avoid call-stack overflow on large arrays
  const minVal = valid.reduce((m, p) => Math.min(m, p.value), Infinity);
  const maxVal = valid.reduce((m, p) => Math.max(m, p.value), -Infinity);
  const valRange = maxVal - minVal || 1;

  const timestamps = valid.map((p) => new Date(p.date).getTime());
  const minDate = timestamps.reduce((m, t) => Math.min(m, t), Infinity);
  const maxDate = timestamps.reduce((m, t) => Math.max(m, t), -Infinity);
  const dateRange = maxDate - minDate || 1;

  const xOf = (d: string) => PAD.left + ((new Date(d).getTime() - minDate) / dateRange) * pw;
  const yOf = (v: number) => PAD.top + ph - ((v - minVal) / valRange) * ph;

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui,-apple-system,sans-serif">`
  );

  // Background
  lines.push(`<rect width="${width}" height="${height}" fill="#f8f9fa" rx="6"/>`);
  lines.push(
    `<rect x="${PAD.left}" y="${PAD.top}" width="${pw}" height="${ph}" fill="#ffffff" rx="3" stroke="#dee2e6" stroke-width="1"/>`
  );

  // Y-axis labels (min/max)
  lines.push(
    `<text x="${PAD.left - 5}" y="${PAD.top + ph}" text-anchor="end" font-size="9" fill="#666">${formatValue(minVal)}${yUnit}</text>`,
    `<text x="${PAD.left - 5}" y="${PAD.top + 9}" text-anchor="end" font-size="9" fill="#666">${formatValue(maxVal)}${yUnit}</text>`
  );

  // X-axis date labels
  if (valid.length >= 2) {
    const first = valid[0];
    const last = valid[valid.length - 1];
    lines.push(
      `<text x="${xOf(first.date)}" y="${PAD.top + ph + 14}" text-anchor="middle" font-size="9" fill="#666">${first.date}</text>`,
      `<text x="${xOf(last.date)}" y="${PAD.top + ph + 14}" text-anchor="middle" font-size="9" fill="#666">${last.date}</text>`
    );
  }

  // Area fill
  const pathD = valid
    .map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.date).toFixed(1)},${yOf(p.value).toFixed(1)}`)
    .join(" ");
  lines.push(
    `<path d="${pathD} L${xOf(valid[valid.length - 1].date).toFixed(1)},${(PAD.top + ph).toFixed(1)} L${PAD.left},${(PAD.top + ph).toFixed(1)} Z" fill="${strokeColor}" fill-opacity="0.1"/>`
  );

  // Line
  lines.push(
    `<path d="${pathD}" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
  );

  // Dots with tooltips
  for (const p of valid) {
    lines.push(
      `<circle cx="${xOf(p.date).toFixed(1)}" cy="${yOf(p.value).toFixed(1)}" r="3.5" fill="${strokeColor}" stroke="#fff" stroke-width="1.5"><title>${p.date}: ${formatValue(p.value)}${yUnit}</title></circle>`
    );
  }

  // Milestone markers — vertical dashed lines for annotated dates within the chart range
  const milestoneDates = Object.keys(milestones).filter((date) => {
    const t = new Date(date).getTime();
    return t >= minDate && t <= maxDate;
  });
  for (const date of milestoneDates) {
    const x = xOf(date).toFixed(1);
    const noteText = xmlEscape(milestones[date]);
    lines.push(
      `<line x1="${x}" y1="${PAD.top}" x2="${x}" y2="${PAD.top + ph}" stroke="#e67e22" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.8"><title>✎ ${noteText}</title></line>`,
      `<text x="${x}" y="${PAD.top - 4}" text-anchor="middle" font-size="9" fill="#e67e22" font-weight="600">✎<title>✎ ${noteText}</title></text>`
    );
  }

  // Label
  if (label) {
    lines.push(
      `<text x="${width / 2}" y="${height - 2}" text-anchor="middle" font-size="10" fill="#555" font-weight="600">${xmlEscape(label)}</text>`
    );
  }

  lines.push(`</svg>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Status hero
// ---------------------------------------------------------------------------

/**
 * Data model for the top-of-page status hero section.
 * Computed from the two most-recent snapshots via buildDriftMagnitude /
 * classifyDigestTier.  When fewer than two snapshots are available,
 * `tier` is null and the hero renders an "Insufficient data" message.
 */
export interface StatusHeroData {
  /** Total number of snapshots available. */
  snapshotCount: number;
  /**
   * Classified tier for the most-recent comparison, or null when there are
   * fewer than two snapshots (insufficient data for a comparison).
   */
  tier: DigestTier | null;
  /**
   * Signed percentage change of the system prompt char count.
   * Positive = grew, negative = shrank.  0 when metrics are absent.
   */
  systemPromptDeltaPct: number;
  /** Net tool-count delta (positive = added, negative = removed). */
  toolCountDelta: number;
  /**
   * Signed probe-refusal rate delta in percentage points.
   * Positive = rate improved (more probes refused), negative = rate dropped.
   * When multiple probe experiments exist, the worst-case (most negative)
   * delta is reported so that a regression is never masked by an improvement.
   * 0 when no probe experiment is present in both snapshots.
   */
  probeRefusalDeltaPp: number;
  /** ISO date string (YYYY-MM-DD) of the previous (baseline) snapshot. */
  previousDate: string | null;
  /** ISO date string (YYYY-MM-DD) of the most-recent (current) snapshot. */
  latestDate: string | null;
}

/**
 * Build a StatusHeroData object from all available snapshots.
 * Uses the two most-recent snapshots (by capturedAt) as the comparison pair.
 * Tier classification delegates to buildDriftMagnitude + classifyDigestTier
 * (same logic as the weekly digest).  Signed deltas are computed directly
 * from the snapshot metrics so the hero can communicate direction of change.
 */
export function buildStatusHero(snapshots: MetricSnapshot[]): StatusHeroData {
  if (snapshots.length < 2) {
    const latestDate =
      snapshots.length === 1 ? snapshots[0].capturedAt.slice(0, 10) : null;
    return {
      snapshotCount: snapshots.length,
      tier: null,
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      previousDate: null,
      latestDate,
    };
  }

  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
  );
  const previous = sorted[sorted.length - 2];
  const latest = sorted[sorted.length - 1];

  const diffReport = diffSnapshots(previous, latest);
  const magnitude = buildDriftMagnitude(diffReport);
  const tier = classifyDigestTier(magnitude);

  // Compute signed system-prompt delta directly (DriftMagnitude is always absolute).
  let systemPromptDeltaPct = 0;
  const prevSysChars =
    previous.experiments['context-tax']?.metrics?.['systemPromptChars']?.value;
  const latestSysChars =
    latest.experiments['context-tax']?.metrics?.['systemPromptChars']?.value;
  if (prevSysChars !== undefined && latestSysChars !== undefined && prevSysChars > 0) {
    systemPromptDeltaPct = ((latestSysChars - prevSysChars) / prevSysChars) * 100;
  }

  // Compute signed probe-refusal delta: positive = improvement, negative = regression.
  // Reports the worst-case (most negative) delta across all probe experiments so
  // that a regression is never masked by a simultaneous improvement in another.
  // When all probes improved, reports the smallest improvement (most conservative)
  // rather than 0, so that improvements are visible too.
  let probeRefusalDeltaPp = 0;
  let hasProbeData = false;
  for (const [expName, prevExp] of Object.entries(previous.experiments ?? {})) {
    const currExp = latest.experiments?.[expName];
    if (!currExp) continue;
    const prevRate = prevExp.metrics?.['injectionRefusedRate']?.value;
    const currRate = currExp.metrics?.['injectionRefusedRate']?.value;
    if (prevRate !== undefined && currRate !== undefined) {
      const delta = (currRate - prevRate) * 100;
      if (!hasProbeData || delta < probeRefusalDeltaPp) {
        probeRefusalDeltaPp = delta;
      }
      hasProbeData = true;
    }
  }
  // probeRefusalDeltaPp stays 0 when hasProbeData is false (no probe data available).

  return {
    snapshotCount: snapshots.length,
    tier,
    systemPromptDeltaPct,
    toolCountDelta: magnitude.toolCountDelta,
    probeRefusalDeltaPp,
    previousDate: previous.capturedAt.slice(0, 10),
    latestDate: latest.capturedAt.slice(0, 10),
  };
}

/**
 * Generate the HTML for the status hero section.
 *
 * @param hero        - Data computed by buildStatusHero().
 * @param generatedAt - UTC ISO timestamp (e.g. `new Date().toISOString()`) to
 *   display as the "Dashboard generated" line.  When omitted, that line is not
 *   rendered.  The value is truncated to minute precision and labelled Z, so
 *   callers MUST pass a UTC ISO string to avoid incorrect timezone labelling.
 */
export function generateStatusHeroHTML(
  hero: StatusHeroData,
  generatedAt?: string,
): string {
  const generatedLine = generatedAt
    ? `\n  <div class="hero-generated">Dashboard generated: ${xmlEscape(
        generatedAt.slice(0, 16).replace("T", " "),
      )}Z</div>`
    : "";

  if (hero.tier === null) {
    return `<section class="section status-hero status-hero-insufficient">
  <div class="hero-badge hero-badge-insufficient">⚠️ INSUFFICIENT DATA</div>
  <div class="hero-insufficient-msg">Insufficient data — ${hero.snapshotCount} baseline${hero.snapshotCount !== 1 ? "s" : ""} captured</div>${generatedLine}
</section>`;
  }

  const TIER_META: Record<DigestTier, { badge: string; cssClass: string }> = {
    stable: { badge: "✅ STABLE", cssClass: "hero-badge-stable" },
    change: { badge: "🔄 CHANGE", cssClass: "hero-badge-change" },
    alert:  { badge: "🚨 ALERT",  cssClass: "hero-badge-alert"  },
  };

  const { badge, cssClass } = TIER_META[hero.tier];

  // Format a signed number with explicit +/- prefix to show direction.
  const fmtSigned = (n: number, decimals = 1): string =>
    (n > 0 ? "+" : "") + n.toFixed(decimals);

  const signedInt = (n: number): string => (n > 0 ? `+${n}` : String(n));

  const deltaItems = [
    `<div class="hero-delta"><span class="hero-delta-label">System Prompt Δ</span><span class="hero-delta-value">${fmtSigned(hero.systemPromptDeltaPct)}%</span></div>`,
    `<div class="hero-delta"><span class="hero-delta-label">Tool Count Δ</span><span class="hero-delta-value">${signedInt(hero.toolCountDelta)}</span></div>`,
    `<div class="hero-delta"><span class="hero-delta-label">Probe Refusal Δ</span><span class="hero-delta-value">${fmtSigned(hero.probeRefusalDeltaPp)} pp</span></div>`,
  ].join("\n    ");

  const window = `Latest vs Previous: ${xmlEscape(hero.previousDate!)} → ${xmlEscape(hero.latestDate!)}`;

  return `<section class="section status-hero status-hero-${hero.tier}">
  <div class="hero-badge ${cssClass}">${badge}</div>
  <div class="hero-deltas">
    ${deltaItems}
  </div>
  <div class="hero-window">${window}</div>${generatedLine}
</section>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtNum(v: number): string {
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
