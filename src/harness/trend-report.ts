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
  /** Average promptFillPct across enabled models; null when absent. */
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

  // headroomPct: average promptFillPct across enabled models with known context window
  let headroomPct: number | null = null;
  const headroom = snapshot.contextWindowHeadroom;
  if (headroom && headroom.length > 0) {
    const enabled = headroom.filter(
      (e) => e.state === "enabled" && e.contextWindow > 0
    );
    if (enabled.length > 0) {
      headroomPct =
        enabled.reduce((sum, e) => sum + e.promptFillPct, 0) / enabled.length;
    }
  }

  // injectionRefusedRate: search all experiments for a metric with that key
  let injectionRefusedRate: number | null = null;
  for (const exp of Object.values(snapshot.experiments ?? {})) {
    const metric = exp.metrics?.["injectionRefusedRate"];
    if (metric !== undefined) {
      injectionRefusedRate = metric.value;
      break;
    }
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
 */
export function generateTrendReport(snapshots: MetricSnapshot[]): string {
  const lines: string[] = [];

  lines.push("# CLI Wrapper Monitor — Trend Report");
  lines.push("");

  if (snapshots.length === 0) {
    lines.push("No baseline snapshots found in `baselines/`.");
    return lines.join("\n");
  }

  if (snapshots.length === 1) {
    lines.push(
      "> **Only one snapshot available.** Capture another baseline to see trends."
    );
    lines.push("");
  }

  const rows = snapshots.map(extractTrendRow);
  const first = rows[0];
  const firstDate = rows[0].date;
  const lastDate = rows[rows.length - 1].date;

  lines.push(
    `_${snapshots.length} snapshot${snapshots.length !== 1 ? "s" : ""} · ${firstDate} → ${lastDate}_`
  );
  lines.push("");

  // Table
  const header =
    "| Date | systemPromptChars | systemPromptTokens | toolCount | headroomPct | injectionRefusedRate | Δ chars |";
  const sep =
    "|------|-------------------|--------------------|-----------|-------------|----------------------|---------|";
  lines.push(header);
  lines.push(sep);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const d = i === 0 ? "baseline" : delta(first.systemPromptChars, r.systemPromptChars);
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
