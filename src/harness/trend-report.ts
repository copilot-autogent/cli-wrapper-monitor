/**
 * Core logic for the multi-baseline trend report.
 *
 * Pure functions extracted here so they can be unit-tested without filesystem access.
 */

import type { MetricSnapshot } from "./types.js";

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
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract a flat TrendRow from a MetricSnapshot.
 * All fields fall back to null when the source data is absent (older baselines).
 */
export function extractTrendRow(snapshot: MetricSnapshot): TrendRow {
  const contextTax = snapshot.experiments?.["context-tax"];

  const systemPromptChars =
    contextTax?.metrics?.["systemPromptChars"]?.value ?? null;
  const systemPromptTokens =
    contextTax?.metrics?.["systemPromptTokensEstimated"]?.value ?? null;
  const toolCount = contextTax?.metrics?.["toolCount"]?.value ?? null;

  // headroomPct: remaining context headroom %, weighted by context window capacity so
  // large-context models contribute proportionally more than small ones.
  // Formula: sum(headroomTokens) / sum(contextWindow) * 100
  let headroomPct: number | null = null;
  const headroom = snapshot.contextWindowHeadroom;
  if (headroom && headroom.length > 0) {
    const enabled = headroom.filter(
      (e) => e.state === "enabled" && e.contextWindow > 0
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

  const rows = sorted.map(extractTrendRow);
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
    "| Date | systemPromptChars | systemPromptTokens | toolCount | headroomPct | injectionRefusedRate | Δ chars |";
  const sep =
    "|------|-------------------|--------------------|-----------|-------------|----------------------|---------|";
  lines.push(header);
  lines.push(sep);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // Mark 'baseline' for the first row that has a non-null chars value
    const isBaseline = firstNonNullChars !== null && r === firstNonNullChars;
    const d =
      isBaseline
        ? "baseline"
        : delta(firstNonNullChars?.systemPromptChars ?? null, r.systemPromptChars);
    lines.push(
      `| ${r.date} | ${fmt(r.systemPromptChars)} | ${fmt(r.systemPromptTokens)} | ${fmt(r.toolCount)} | ${fmtPct(r.headroomPct)} | ${r.injectionRefusedRate !== null ? r.injectionRefusedRate.toFixed(3) : "—"} | ${d} |`
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
