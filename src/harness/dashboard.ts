/**
 * Pure functions for the static HTML dashboard generator.
 * Extracted here so they can be unit-tested without filesystem access.
 */

import type { MetricSnapshot } from "./types.js";
import { extractTrendRow, type TrendRow } from "./trend-report.js";

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
 * Extract a summary card data object from the most-recent (last) snapshot.
 */
export function extractSummaryCard(snapshots: MetricSnapshot[]): SummaryCardData | null {
  if (snapshots.length === 0) return null;

  const latest = snapshots[snapshots.length - 1];
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
 * Returns one entry per detected regression event.
 */
export function extractRegressions(snapshots: MetricSnapshot[]): RegressionEntry[] {
  if (snapshots.length < 2) return [];

  const entries: RegressionEntry[] = [];
  const BREAKING_THRESHOLD = 10; // >10% change = BREAKING
  const WARNING_THRESHOLD = 5;   // >5% change = WARNING

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    const date = curr.capturedAt.slice(0, 10);

    const prevRow = extractTrendRow(prev);
    const currRow = extractTrendRow(curr);

    // Check system prompt chars change
    if (prevRow.systemPromptChars !== null && currRow.systemPromptChars !== null && prevRow.systemPromptChars > 0) {
      const deltaPct = ((currRow.systemPromptChars - prevRow.systemPromptChars) / prevRow.systemPromptChars) * 100;
      const absDelta = Math.abs(deltaPct);
      if (absDelta > BREAKING_THRESHOLD) {
        const sign = deltaPct > 0 ? "+" : "";
        entries.push({
          date,
          severity: "BREAKING",
          description: `systemPromptChars ${sign}${deltaPct.toFixed(1)}% (${fmtNum(prevRow.systemPromptChars)} → ${fmtNum(currRow.systemPromptChars)})`,
        });
      } else if (absDelta > WARNING_THRESHOLD) {
        const sign = deltaPct > 0 ? "+" : "";
        entries.push({
          date,
          severity: "WARNING",
          description: `systemPromptChars ${sign}${deltaPct.toFixed(1)}% (${fmtNum(prevRow.systemPromptChars)} → ${fmtNum(currRow.systemPromptChars)})`,
        });
      }
    }

    // Check tool count drop (any drop is BREAKING)
    if (prevRow.toolCount !== null && currRow.toolCount !== null && prevRow.toolCount !== currRow.toolCount) {
      const delta = currRow.toolCount - prevRow.toolCount;
      const severity: "BREAKING" | "WARNING" = delta < 0 ? "BREAKING" : "WARNING";
      const sign = delta > 0 ? "+" : "";
      entries.push({
        date,
        severity,
        description: `toolCount ${sign}${delta} (${prevRow.toolCount} → ${currRow.toolCount})`,
      });
    }

    // Check hook count changes
    const prevHook = prev.hookCount ?? null;
    const currHook = curr.hookCount ?? null;
    if (prevHook !== null && currHook !== null && prevHook !== currHook) {
      const delta = currHook - prevHook;
      const severity: "BREAKING" | "WARNING" = delta < 0 ? "BREAKING" : "WARNING";
      const sign = delta > 0 ? "+" : "";
      entries.push({
        date,
        severity,
        description: `hookCount ${sign}${delta} (${prevHook} → ${currHook})`,
      });
    }

    // Check injection refusal rate drop
    if (prevRow.injectionRefusedRate !== null && currRow.injectionRefusedRate !== null) {
      const deltaPct = ((currRow.injectionRefusedRate - prevRow.injectionRefusedRate) / Math.max(prevRow.injectionRefusedRate, 0.001)) * 100;
      if (deltaPct < -WARNING_THRESHOLD) {
        entries.push({
          date,
          severity: deltaPct < -BREAKING_THRESHOLD ? "BREAKING" : "WARNING",
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
 */
export function extractModelPoolHistory(snapshots: MetricSnapshot[]): ModelPoolEntry[] {
  const modelMap = new Map<string, ModelPoolEntry>();

  const latestModelIds = new Set<string>();
  const latest = snapshots[snapshots.length - 1];
  if (latest?.modelPool) {
    for (const m of latest.modelPool.models) {
      latestModelIds.add(m.id);
    }
  }

  for (const snap of snapshots) {
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
// SVG sparkline generator
// ---------------------------------------------------------------------------

/**
 * Generate a compact SVG sparkline for a series of data points.
 * Returns an SVG string suitable for inline embedding.
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
  } = {}
): string {
  const {
    width = 600,
    height = 120,
    strokeColor = "#2980b9",
    label = "",
    yUnit = "",
    formatValue = (v: number) => fmtNum(v),
  } = opts;

  const PAD = { top: 20, right: 20, bottom: 30, left: 60 };
  const pw = width - PAD.left - PAD.right;
  const ph = height - PAD.top - PAD.bottom;

  const valid = points.filter((p): p is SparklinePoint & { value: number } => p.value !== null);
  if (valid.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="11" fill="#999">No data</text></svg>`;
  }

  const minVal = Math.min(...valid.map((p) => p.value));
  const maxVal = Math.max(...valid.map((p) => p.value));
  const valRange = maxVal - minVal || 1;

  const dates = valid.map((p) => new Date(p.date).getTime());
  const minDate = Math.min(...dates);
  const maxDate = Math.max(...dates);
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
