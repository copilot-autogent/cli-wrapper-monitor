/**
 * Core logic for the multi-baseline trend report.
 *
 * Pure functions extracted here so they can be unit-tested without filesystem access.
 */

import type { MetricSnapshot } from "./types.js";
import { diffSnapshots } from "./diff.js";

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

export interface TrendRow {
  date: string;
  systemPromptChars: number | null;
  systemPromptTokens: number | null;
  toolCount: number | null;
  /** Remaining context headroom %, capacity-weighted across enabled models; null when absent. */
  headroomPct: number | null;
  /** Average injectionRefusedRate across all experiments; null when absent. */
  injectionRefusedRate: number | null;
  /**
   * Security posture score (0–100) comparing this snapshot to the previous one.
   * Null for the first snapshot (no previous to compare against).
   */
  securityPostureScore: number | null;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract a flat TrendRow from a MetricSnapshot.
 * All fields fall back to null when the source data is absent (older baselines).
 *
 * @param snapshot - The snapshot to extract a row from.
 * @param previous - Optional previous snapshot; when provided, the security posture
 *                   score is computed as a diff between previous and snapshot.
 */
export function extractTrendRow(snapshot: MetricSnapshot, previous?: MetricSnapshot): TrendRow {
  const contextTax = snapshot.experiments?.["context-tax"];

  const systemPromptChars =
    contextTax?.metrics?.["systemPromptChars"]?.value ?? null;
  const systemPromptTokens =
    contextTax?.metrics?.["systemPromptTokensEstimated"]?.value ?? null;
  const toolCount = contextTax?.metrics?.["toolCount"]?.value ?? null;

  // headroomPct: remaining context headroom %, capacity-weighted across enabled models
  // with known context windows. Excludes 'unknown' status entries (unavailable SDK data).
  // Formula: sum(headroomTokens) / sum(contextWindow) * 100
  let headroomPct: number | null = null;
  const headroom = snapshot.contextWindowHeadroom;
  if (headroom && headroom.length > 0) {
    const enabled = headroom.filter(
      (e) => e.state === "enabled" && e.contextWindow > 0 && e.status !== "unknown"
    );
    if (enabled.length > 0) {
      const totalHeadroom = enabled.reduce((sum, e) => sum + e.headroomTokens, 0);
      const totalWindow = enabled.reduce((sum, e) => sum + e.contextWindow, 0);
      headroomPct = (totalHeadroom / totalWindow) * 100;
    }
  }

  // injectionRefusedRate: average across all experiments that expose this metric
  let injectionRefusedRate: number | null = null;
  const injectionValues: number[] = [];
  for (const exp of Object.values(snapshot.experiments ?? {})) {
    const metric = exp.metrics?.["injectionRefusedRate"];
    if (metric !== undefined) {
      injectionValues.push(metric.value);
    }
  }
  if (injectionValues.length > 0) {
    injectionRefusedRate =
      injectionValues.reduce((sum, v) => sum + v, 0) / injectionValues.length;
  }

  return {
    date: new Date(snapshot.capturedAt).toISOString().slice(0, 10),
    systemPromptChars,
    systemPromptTokens,
    toolCount,
    headroomPct,
    injectionRefusedRate,
    securityPostureScore: previous !== undefined ? diffSnapshots(previous, snapshot).securityPostureScore : null,
  };
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

const SPARKLINE_BLOCKS = "▁▂▃▄▅▆▇█";

/**
 * Build a sparkline string from a series of values.
 * null values are rendered as "·".
 * Returns an empty string when fewer than 2 non-null values are provided.
 */
export function buildSparkline(values: (number | null)[]): string {
  const nonNull = values.filter((v): v is number => v !== null);
  if (nonNull.length < 2) return "";

  const min = Math.min(...nonNull);
  const max = Math.max(...nonNull);

  return values
    .map((v) => {
      if (v === null) return "·";
      if (max === min) return SPARKLINE_BLOCKS[0];
      const idx = Math.round(
        ((v - min) / (max - min)) * (SPARKLINE_BLOCKS.length - 1)
      );
      return SPARKLINE_BLOCKS[idx];
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Table formatter
// ---------------------------------------------------------------------------

function fmt(v: number | null, decimals = 0): string {
  if (v === null) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: decimals });
}

function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return v.toFixed(1) + "%";
}

function delta(base: number | null, current: number | null): string {
  if (base === null || current === null) return "—";
  if (base === 0) return "—";
  const change = ((current - base) / base) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Trend matrix
// ---------------------------------------------------------------------------

/** A single lookback window for the trend matrix. */
export interface TrendWindow {
  /** Human-readable label, e.g. "Week", "Month". */
  label: string;
  /** Lookback period in days. */
  days: number;
}

/** Default window set (7d / 30d / 90d / 180d). Frozen to prevent accidental mutation. */
export const DEFAULT_TREND_WINDOWS: readonly TrendWindow[] = Object.freeze([
  Object.freeze({ label: "Week",    days: 7   }),
  Object.freeze({ label: "Month",   days: 30  }),
  Object.freeze({ label: "3-month", days: 90  }),
  Object.freeze({ label: "6-month", days: 180 }),
]);

/** Formatted cell value for a single metric × window intersection. */
export interface TrendMatrixCell {
  /** The formatted string to display, e.g. "+800", "87.5%", "—". */
  formatted: string;
  /** ISO date of the reference snapshot used for this window; null when no data. */
  referenceDate: string | null;
}

/** A single metric row in the trend matrix. */
export interface TrendMatrixRow {
  metric: string;
  cells: TrendMatrixCell[];
}

/** Full trend matrix result. */
export interface TrendMatrix {
  windows: readonly TrendWindow[];
  rows: TrendMatrixRow[];
  /** ISO date string of the current (most-recent) snapshot. */
  currentDate: string;
}

/**
 * Given an ordered list of snapshots and a reference time, find the latest
 * snapshot whose capturedAt is on or before (referenceMs).
 * Returns null when no qualifying snapshot exists.
 */
function findReferenceSnapshot(
  sorted: MetricSnapshot[],
  referenceMs: number
): MetricSnapshot | null {
  let best: MetricSnapshot | null = null;
  for (const snap of sorted) {
    const t = new Date(snap.capturedAt).getTime();
    if (t <= referenceMs) best = snap;
    else break; // sorted ascending — no need to continue
  }
  return best;
}

function fmtDeltaAbsolute(delta: number): string {
  const sign = delta >= 0 ? "+" : "−";
  return `${sign}${Math.abs(delta).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtDeltaPct(current: number, reference: number): string {
  if (reference === 0) return "—";
  const pct = ((current - reference) / reference) * 100;
  const sign = pct >= 0 ? "+" : "−";
  return `${sign}${Math.abs(pct).toFixed(0)}%`;
}

/**
 * Build a pairwise delta matrix across the supplied lookback windows.
 *
 * - The most-recent snapshot is treated as "current".
 * - For each window, the reference snapshot is the latest capture whose
 *   capturedAt ≤ (currentTime − window.days * 86_400_000 ms).
 * - systemPromptChars and toolCount show absolute deltas (current − reference).
 *   systemPromptChars switches to a percentage-only display when |Δ%| ≥ 10,
 *   because the absolute number becomes less informative at large scales.
 * - injectionRefusedRate shows the reference value as a percentage.
 * - securityPostureScore shows the reference snapshot's score (using diffSnapshots).
 * - Any metric absent from the reference snapshot renders as "—".
 *
 * Gracefully returns an empty matrix when fewer than 2 snapshots are provided.
 */
export function buildTrendMatrix(
  snapshots: MetricSnapshot[],
  windows: readonly TrendWindow[] = DEFAULT_TREND_WINDOWS
): TrendMatrix {
  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime()
  );

  const currentSnap = sorted[sorted.length - 1];
  const currentDate = currentSnap
    ? new Date(currentSnap.capturedAt).toISOString().slice(0, 10)
    : "";

  if (sorted.length < 2) {
    return {
      windows,
      rows: [],
      currentDate,
    };
  }

  const currentRow = extractTrendRow(currentSnap);
  const currentMs = new Date(currentSnap.capturedAt).getTime();

  // Resolve reference snapshots for each window (excluding currentSnap itself)
  const snapshotsWithoutCurrent = sorted.slice(0, sorted.length - 1);

  const refs = windows.map((w) => {
    const refMs = currentMs - w.days * 86_400_000;
    return findReferenceSnapshot(snapshotsWithoutCurrent, refMs);
  });

  function makeCell(
    build: (ref: MetricSnapshot, refRow: TrendRow) => string,
    ref: MetricSnapshot | null
  ): TrendMatrixCell {
    if (ref === null) {
      return { formatted: "—", referenceDate: null };
    }
    const refRow = extractTrendRow(ref);
    return {
      formatted: build(ref, refRow),
      referenceDate: new Date(ref.capturedAt).toISOString().slice(0, 10),
    };
  }

  // --- systemPromptChars row ---
  const charsRow: TrendMatrixRow = {
    metric: "System prompt chars",
    cells: refs.map((ref) =>
      makeCell((_ref, refRow) => {
        if (currentRow.systemPromptChars === null || refRow.systemPromptChars === null) return "—";
        const delta = currentRow.systemPromptChars - refRow.systemPromptChars;
        const absDelta = fmtDeltaAbsolute(delta);
        if (refRow.systemPromptChars !== 0) {
          const pct = Math.abs(((delta) / refRow.systemPromptChars) * 100);
          if (pct >= 10) return fmtDeltaPct(currentRow.systemPromptChars, refRow.systemPromptChars);
        }
        return absDelta;
      }, ref)
    ),
  };

  // --- toolCount row ---
  const toolRow: TrendMatrixRow = {
    metric: "Tool count",
    cells: refs.map((ref) =>
      makeCell((_ref, refRow) => {
        if (currentRow.toolCount === null || refRow.toolCount === null) return "—";
        return fmtDeltaAbsolute(currentRow.toolCount - refRow.toolCount);
      }, ref)
    ),
  };

  // --- injectionRefusedRate row ---
  // Shows the rate AT the reference snapshot (so you can see historical drift).
  const injectionRow: TrendMatrixRow = {
    metric: "Injection refusal rate",
    cells: refs.map((ref) =>
      makeCell((_ref, refRow) => {
        if (refRow.injectionRefusedRate === null) return "—";
        return `${(refRow.injectionRefusedRate * 100).toFixed(1)}%`;
      }, ref)
    ),
  };

  // --- securityPostureScore row ---
  // Shows the score at the reference snapshot (computed from its previous snapshot).
  // For simplicity we use the snapshot immediately before each reference.
  const securityRow: TrendMatrixRow = {
    metric: "Security posture score",
    cells: refs.map((ref) => {
      if (ref === null) return { formatted: "—", referenceDate: null };
      const refIdx = snapshotsWithoutCurrent.indexOf(ref);
      const prev = refIdx > 0 ? snapshotsWithoutCurrent[refIdx - 1] : undefined;
      const refRow = extractTrendRow(ref, prev);
      const score = refRow.securityPostureScore;
      return {
        formatted: score !== null ? String(score) : "—",
        referenceDate: new Date(ref.capturedAt).toISOString().slice(0, 10),
      };
    }),
  };

  return {
    windows,
    rows: [charsRow, toolRow, injectionRow, securityRow],
    currentDate,
  };
}

/**
 * Render a TrendMatrix as a Markdown table string.
 *
 * Example output:
 *   | Metric                 | Week | Month | 3-month | 6-month |
 *   |------------------------|------|-------|---------|---------|
 *   | System prompt chars    | +0   | +800  | +1,200  | +54%    |
 *   ...
 */
export function buildTrendMatrixMarkdown(matrix: TrendMatrix): string {
  if (matrix.rows.length === 0) {
    return "> **Not enough snapshots to build a trend matrix.** Capture at least 2 baselines.";
  }

  const windowLabels = matrix.windows.map((w) => w.label);
  const header = `| Metric | ${windowLabels.join(" | ")} |`;
  const sep = `|--------|${windowLabels.map(() => "------").join("|")}|`;
  const lines: string[] = [header, sep];

  for (const row of matrix.rows) {
    const cells = row.cells.map((c) => c.formatted);
    lines.push(`| ${row.metric} | ${cells.join(" | ")} |`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Report generator
// ---------------------------------------------------------------------------

/**
 * Generate the full trend report markdown string from an ordered list of snapshots.
 * Gracefully handles 0 or 1 snapshots.
 * Input is sorted chronologically before processing so callers need not pre-sort.
 */
export function generateTrendReport(snapshots: MetricSnapshot[]): string {
  const lines: string[] = [];

  lines.push("# CLI Wrapper Monitor — Trend Report");
  lines.push("");

  if (snapshots.length === 0) {
    lines.push("No baseline snapshots found in `baselines/`.");
    return lines.join("\n");
  }

  // Defensive sort: ensure chronological order regardless of call-site ordering
  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime()
  );

  if (sorted.length === 1) {
    lines.push(
      "> **Only one snapshot available.** Capture another baseline to see trends."
    );
    lines.push("");
  }

  const rows = sorted.map((snap, i) => extractTrendRow(snap, i > 0 ? sorted[i - 1] : undefined));
  const firstDate = rows[0].date;
  const lastDate = rows[rows.length - 1].date;

  lines.push(
    `_${snapshots.length} snapshot${snapshots.length !== 1 ? "s" : ""} · ${firstDate} → ${lastDate}_`
  );
  lines.push("");

  // Find the first non-null systemPromptChars as the delta baseline (older baselines
  // may lack the metric; using the first non-null avoids all-`—` delta columns).
  const firstNonNullChars = rows.find((r) => r.systemPromptChars !== null) ?? null;

  // Table
  const header =
    "| Date | systemPromptChars | systemPromptTokens | toolCount | headroomPct | injectionRefusedRate | securityPostureScore | Δ chars |";
  const sep =
    "|------|-------------------|--------------------|-----------|-------------|----------------------|----------------------|---------|";
  lines.push(header);
  lines.push(sep);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // Mark 'baseline' for the first row with a non-null chars value.
    // Use date comparison (not reference equality) to be robust against array rebuilds.
    const isBaseline = firstNonNullChars !== null && r.date === firstNonNullChars.date;
    const d =
      isBaseline
        ? "baseline"
        : delta(firstNonNullChars?.systemPromptChars ?? null, r.systemPromptChars);
    // injectionRefusedRate is stored as a 0–1 fraction; display as percentage for readability
    const injDisplay =
      r.injectionRefusedRate !== null
        ? `${(r.injectionRefusedRate * 100).toFixed(1)}%`
        : "—";
    // securityPostureScore: null for first row (no previous snapshot to diff against)
    const scoreDisplay =
      r.securityPostureScore !== null
        ? `${r.securityPostureScore}/100`
        : "—";
    lines.push(
      `| ${r.date} | ${fmt(r.systemPromptChars)} | ${fmt(r.systemPromptTokens)} | ${fmt(r.toolCount)} | ${fmtPct(r.headroomPct)} | ${injDisplay} | ${scoreDisplay} | ${d} |`
    );
  }

  lines.push("");

  // Sparkline (≥3 data points)
  const charValues = rows.map((r) => r.systemPromptChars);
  const nonNull = charValues.filter((v): v is number => v !== null);
  if (nonNull.length >= 3) {
    const sparkline = buildSparkline(charValues);
    lines.push("### systemPromptChars sparkline");
    lines.push("");
    lines.push(`\`${sparkline}\` (${firstDate} → ${lastDate})`);
    lines.push("");
  }

  // Footer
  lines.push("---");
  lines.push("");
  lines.push(
    "*Generated by [cli-wrapper-monitor](https://github.com/copilot-autogent/cli-wrapper-monitor)*"
  );

  return lines.join("\n");
}
