#!/usr/bin/env -S npx tsx
/**
 * Export all captured baseline metrics as a flat CSV or JSON table.
 *
 * Usage:
 *   npm run export
 *   npm run export -- --format=json
 *   npm run export -- --output=my-export.csv
 *   npm run export -- --output=-       (writes to stdout)
 *   npm run export -- --help
 *
 * Default output: reports/metrics-export.csv
 *
 * CSV columns (one row per baseline snapshot):
 *   date, systemPromptChars, systemPromptTokens, toolCount, modelCount,
 *   hookCount, injectionRefusedRate, headroomMin, securityPostureScore, schemaVersion
 *
 * JSON output: array of objects with the same fields.
 * All numeric fields are numbers (not strings) in JSON; missing optional fields
 * are null for backward compatibility with pre-#76 / pre-#43 baselines.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, lstatSync, mkdirSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import type { MetricSnapshot } from "../src/harness/types.js";
import { diffSnapshots } from "../src/harness/diff.js";
import { migrate } from "../src/harness/baseline-migrator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single flat export row (one row per baseline snapshot). */
export interface ExportRow {
  /** ISO 8601 capture timestamp */
  date: string;
  /** System prompt length in characters */
  systemPromptChars: number | null;
  /** Estimated system prompt token count */
  systemPromptTokens: number | null;
  /** Number of registered tool definitions */
  toolCount: number | null;
  /** Number of models in the model pool (null when pool not captured) */
  modelCount: number | null;
  /** Number of hook handlers detected (null when not captured) */
  hookCount: number | null;
  /**
   * Injection refusal rate from any experiment that exposes an
   * `injectionRefusedRate` metric. Null when not captured.
   */
  injectionRefusedRate: number | null;
  /**
   * Minimum headroom (tokens) across all context-window entries.
   * Null when contextWindowHeadroom was not captured.
   */
  headroomMin: number | null;
  /**
   * Aggregate security regression score (0–100) vs the previous baseline.
   * Null for the first snapshot (no previous to compare against).
   */
  securityPostureScore: number | null;
  /** Schema version string ("1.0", "0.9", or null for pre-versioned) */
  schemaVersion: string | null;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract a flat ExportRow from a MetricSnapshot.
 *
 * @param snapshot     The snapshot to extract.
 * @param prevSnapshot The immediately preceding snapshot (sorted by date), if any.
 *                     Used to compute securityPostureScore.
 */
export function extractRow(
  snapshot: MetricSnapshot,
  prevSnapshot?: MetricSnapshot,
): ExportRow {
  const ctxMetrics = snapshot.experiments?.["context-tax"]?.metrics ?? {};

  const spCharsRaw = ctxMetrics["systemPromptChars"]?.value;
  const systemPromptChars = typeof spCharsRaw === "number" ? spCharsRaw : null;

  const spTokensRaw = ctxMetrics["systemPromptTokensEstimated"]?.value;
  const systemPromptTokens = typeof spTokensRaw === "number" ? spTokensRaw : null;

  const toolCountRaw = ctxMetrics["toolCount"]?.value;
  const toolCount = typeof toolCountRaw === "number" ? toolCountRaw : null;

  const modelCount = snapshot.modelPool?.models?.length ?? null;

  const hookCount = snapshot.hookCount ?? null;

  // Search all experiments for an injectionRefusedRate metric.
  let injectionRefusedRate: number | null = null;
  for (const exp of Object.values(snapshot.experiments ?? {})) {
    const rawValue = exp.metrics?.["injectionRefusedRate"]?.value;
    if (typeof rawValue === "number") {
      injectionRefusedRate = rawValue;
      break;
    }
  }

  // Minimum headroom across all model entries.
  const hwEntries = snapshot.contextWindowHeadroom;
  let headroomMin: number | null = null;
  if (hwEntries && hwEntries.length > 0) {
    const values = hwEntries
      .map((e) => e.headroomTokens)
      .filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
    headroomMin = values.length > 0 ? values.reduce((a, b) => Math.min(a, b), Infinity) : null;
  }

  // Security posture score: computed via diff against the previous snapshot.
  let securityPostureScore: number | null = null;
  if (prevSnapshot !== undefined) {
    const report = diffSnapshots(prevSnapshot, snapshot);
    const score = report.securityPostureScore;
    securityPostureScore = typeof score === "number" ? score : null;
  }

  const schemaVersion = snapshot.schemaVersion ?? null;

  return {
    date: snapshot.capturedAt,
    systemPromptChars,
    systemPromptTokens,
    toolCount,
    modelCount,
    hookCount,
    injectionRefusedRate,
    headroomMin,
    securityPostureScore,
    schemaVersion,
  };
}

// ---------------------------------------------------------------------------
// Serialisers
// ---------------------------------------------------------------------------

/** Column order for CSV output. */
const CSV_COLUMNS: (keyof ExportRow)[] = [
  "date",
  "systemPromptChars",
  "systemPromptTokens",
  "toolCount",
  "modelCount",
  "hookCount",
  "injectionRefusedRate",
  "headroomMin",
  "securityPostureScore",
  "schemaVersion",
];

/** Escape a value for CSV: wrap in double-quotes if it contains commas, newlines (LF/CR), or quotes. */
function csvField(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Serialise rows as CSV (headers + one data row per entry). */
export function serializeCSV(rows: ExportRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const dataRows = rows.map((row) =>
    CSV_COLUMNS.map((col) => csvField(row[col] as string | number | null)).join(","),
  );
  return [header, ...dataRows].join("\n") + "\n";
}

/** Serialise rows as a pretty-printed JSON array. */
export function serializeJSON(rows: ExportRow[]): string {
  return JSON.stringify(rows, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Baseline loader
// ---------------------------------------------------------------------------

/** Collect all non-schema, non-latest baseline JSON paths, sorted by filename. */
function collectBaselinePaths(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) continue; // skip sub-directories (archive/, weekly/)
    if (
      entry.endsWith(".json") &&
      entry !== "schema.json" &&
      entry !== "latest.json"
    ) {
      results.push(full);
    }
  }
  return results;
}

function loadSnapshot(path: string): MetricSnapshot {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  return migrate(raw) as MetricSnapshot;
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  format: "csv" | "json";
  output: string;
  baselinesDir: string;
  help: boolean;
}

const HELP_TEXT = `
Usage: npm run export [-- [options]]

Options:
  --format=csv|json   Output format (default: csv)
  --output=<path>     Destination file path (default: reports/metrics-export.csv or .json)
  --output=-          Write to stdout
  --baselines=<dir>   Baselines directory to read (default: baselines)
  --help              Show this help text

Examples:
  npm run export
  npm run export -- --format=json
  npm run export -- --format=csv --output=out.csv
  npm run export -- --output=-
`.trim();

function parseArgs(argv: string[]): CliArgs {
  let format: "csv" | "json" = "csv";
  let output = "";
  let baselinesDir = "baselines";
  let help = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg.startsWith("--format=")) {
      const val = arg.slice("--format=".length);
      if (val === "json") format = "json";
      else if (val === "csv") format = "csv";
      else {
        console.error(`Unknown format "${val}". Use csv or json.`);
        process.exit(1);
      }
    } else if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length);
    } else if (arg.startsWith("--baselines=")) {
      baselinesDir = arg.slice("--baselines=".length);
    } else if (!arg.startsWith("--")) {
      // positional — ignore
    } else {
      console.warn(`Warning: unrecognized flag "${arg}" — ignored.`);
    }
  }

  if (!output) {
    output = format === "json" ? "reports/metrics-export.json" : "reports/metrics-export.csv";
  }

  return { format, output, baselinesDir, help };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Build and return all export rows from the given baselines directory. */
export function buildExportRows(baselinesDir: string): ExportRow[] {
  const paths = collectBaselinePaths(baselinesDir);
  const snapshots: MetricSnapshot[] = paths.map(loadSnapshot);
  // Sort by capturedAt (ascending) so securityPostureScore diffs adjacent snapshots correctly,
  // even if filenames diverge from capture timestamps. Use Date.parse for robust ISO comparison.
  snapshots.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

  return snapshots.map((snap, i) => extractRow(snap, i > 0 ? snapshots[i - 1] : undefined));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const rows = buildExportRows(args.baselinesDir);

  const content =
    args.format === "json" ? serializeJSON(rows) : serializeCSV(rows);

  if (args.output === "-") {
    process.stdout.write(content);
  } else {
    const outPath = resolve(args.output);
    const outDir = dirname(outPath);
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }
    writeFileSync(outPath, content, "utf-8");
    console.log(`✅ Exported ${rows.length} row(s) to ${outPath}`);
  }
}

// Only run when invoked directly (not when imported by tests or other modules).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
