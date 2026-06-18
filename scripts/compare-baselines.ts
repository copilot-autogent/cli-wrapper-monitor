#!/usr/bin/env npx ts-node --esm
/**
 * Compare two baseline JSON snapshots and output a structured diff report.
 *
 * Usage:
 *   npx ts-node --esm scripts/compare-baselines.ts <baseline-a> <baseline-b> [options]
 *   npx ts-node --esm scripts/compare-baselines.ts --a <path> --b <path> [options]
 *
 * Options:
 *   --json          Output raw DiffReport as JSON instead of Markdown
 *   --output <path> Write report to file instead of stdout
 *
 * Examples:
 *   npm run compare -- baselines/2026-05-20.json baselines/2026-06-03.json
 *   npm run compare -- baselines/2026-06-03.json baselines/latest.json --output reports/jun3-to-latest.md
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { MetricSnapshot } from "../src/harness/types.js";
import { diffSnapshots } from "../src/harness/diff.js";

interface CliArgs {
  a: string;
  b: string;
  json: boolean;
  output: string | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let a = "";
  let b = "";
  let jsonMode = false;
  let output: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--a" && args[i + 1] && !args[i + 1].startsWith("--")) {
      a = args[++i];
    } else if (
      args[i] === "--b" &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    ) {
      b = args[++i];
    } else if (args[i] === "--json") {
      jsonMode = true;
    } else if (
      args[i] === "--output" &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    ) {
      output = args[++i];
    } else if (args[i].startsWith("--")) {
      // Unknown flag: warn and skip its value if it looks like a value arg
      const hasValue =
        args[i + 1] !== undefined && !args[i + 1].startsWith("--");
      console.warn(`Warning: unrecognized flag "${args[i]}" — ignored.`);
      if (hasValue) i++;
    } else {
      positional.push(args[i]);
    }
  }

  if (!a && positional[0]) a = positional[0];
  if (!b && positional[1]) b = positional[1];

  if (!a || !b) {
    console.error(
      "Usage: compare-baselines <file-a> <file-b> [--json] [--output <path>]\n" +
        "  file-a           Path to the older (reference) baseline JSON\n" +
        "  file-b           Path to the newer baseline JSON\n" +
        "  --json           Output raw DiffReport JSON instead of Markdown\n" +
        "  --output <path>  Write report to file"
    );
    process.exit(1);
  }

  return { a, b, json: jsonMode, output };
}

function loadSnapshot(path: string): MetricSnapshot {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`Snapshot not found: ${abs}`);
  }
  let raw: string;
  try {
    raw = readFileSync(abs, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read ${abs}: ${String(err)}`);
  }
  try {
    return JSON.parse(raw) as MetricSnapshot;
  } catch (err) {
    throw new Error(`Invalid JSON in ${abs}: ${String(err)}`);
  }
}

/** Format a short date label from a capturedAt field (ISO or fallback). */
function shortDate(capturedAt: unknown): string {
  if (typeof capturedAt === "string" && capturedAt.length >= 10) {
    return capturedAt.slice(0, 10);
  }
  return "unknown-date";
}

/** Abbreviate a sha256:<hex> hash for display. */
function shortHash(hash: string | undefined): string {
  if (!hash || hash === "unknown") return "unknown";
  const hex = hash.replace(/^sha256:/, "");
  return hex.slice(0, 15) + "…";
}

/** Percent-change string, e.g. "+12.3%" or "-5.0%". */
function pctStr(a: number, b: number): string {
  if (a === 0) return b === 0 ? "0%" : "N/A";
  const pct = ((b - a) / a) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

/** Delta string with sign and percent, e.g. "-27,303 (-14.9%)". */
function deltaStr(a: number, b: number): string {
  const d = b - a;
  const sign = d >= 0 ? "+" : "";
  return `${sign}${d.toLocaleString()} (${pctStr(a, b)})`;
}

/** Severity emoji appended to delta based on percent magnitude. */
function severityIcon(a: number, b: number): string {
  if (a === 0) return "";
  const pct = Math.abs(((b - a) / a) * 100);
  if (pct >= 10) return " 🔴";
  if (pct >= 5) return " 🟡";
  return "";
}

/**
 * Build a Markdown table row for a numeric metric.
 * Returns the row string regardless of whether values are defined.
 */
function numRow(
  label: string,
  valA: number | undefined,
  valB: number | undefined,
  unit = ""
): string {
  const na = "—";
  const fmtVal = (v: number) =>
    v.toLocaleString() + (unit ? ` ${unit}` : "");
  const aStr = valA !== undefined ? fmtVal(valA) : na;
  const bStr = valB !== undefined ? fmtVal(valB) : na;

  let delta: string;
  if (valA !== undefined && valB !== undefined) {
    delta = deltaStr(valA, valB) + severityIcon(valA, valB);
  } else if (valA === undefined && valB !== undefined) {
    delta = `+${fmtVal(valB)} (new)`;
  } else if (valA !== undefined && valB === undefined) {
    delta = `${na} (removed)`;
  } else {
    delta = na;
  }

  return `| ${label} | ${aStr} | ${bStr} | ${delta} |`;
}

/**
 * Build a Markdown table row for a hash fingerprint field.
 * Treats undefined and missing as equivalent; "unknown" sentinel is preserved.
 */
function hashRow(
  label: string,
  hA: string | undefined,
  hB: string | undefined
): string {
  const sA = shortHash(hA);
  const sB = shortHash(hB);
  let delta: string;
  const knownA = hA && hA !== "unknown";
  const knownB = hB && hB !== "unknown";
  if (knownA && knownB) {
    delta = hA === hB ? "✅ unchanged" : "⚠️ changed";
  } else if (!knownA && knownB) {
    delta = "new";
  } else if (knownA && !knownB) {
    delta = "removed";
  } else {
    delta = "—";
  }
  return `| ${label} | \`${sA}\` | \`${sB}\` | ${delta} |`;
}

interface PerToolEntry {
  name: string;
  chars: number;
}

function extractPerTool(snap: MetricSnapshot): PerToolEntry[] {
  const raw = snap.experiments["context-tax"]?.rawData as
    | { perToolChars?: unknown[] }
    | undefined;
  if (!Array.isArray(raw?.perToolChars)) return [];
  return raw.perToolChars.filter(
    (e): e is PerToolEntry =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as Record<string, unknown>)["name"] === "string" &&
      typeof (e as Record<string, unknown>)["chars"] === "number"
  );
}

/**
 * Generate a human-readable Markdown comparison report.
 */
function generateMarkdownReport(
  snapA: MetricSnapshot,
  snapB: MetricSnapshot
): string {
  const report = diffSnapshots(snapA, snapB);
  const dateA = shortDate(snapA.capturedAt);
  const dateB = shortDate(snapB.capturedAt);
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────
  lines.push(`## Baseline Comparison: ${dateA} vs ${dateB}`);
  lines.push("");
  lines.push(`| | ${dateA} | ${dateB} |`);
  lines.push(`|---|---|---|`);
  lines.push(
    `| Monitor version | \`${snapA.monitorVersion}\` | \`${snapB.monitorVersion}\` |`
  );
  lines.push(`| SDK version | ${snapA.sdkVersion} | ${snapB.sdkVersion} |`);
  lines.push(`| Model | ${snapA.model} | ${snapB.model} |`);
  lines.push("");

  // ── Summary metric table ─────────────────────────────────────────────────
  lines.push(`## Metric Summary`);
  lines.push("");
  lines.push(`| Metric | ${dateA} | ${dateB} | Delta |`);
  lines.push(
    `|--------|${"-".repeat(dateA.length + 2)}|${"-".repeat(dateB.length + 2)}|-------|`
  );

  const ctxA = snapA.experiments["context-tax"]?.metrics;
  const ctxB = snapB.experiments["context-tax"]?.metrics;

  lines.push(
    numRow(
      "System prompt (chars)",
      ctxA?.["systemPromptChars"]?.value,
      ctxB?.["systemPromptChars"]?.value,
      "chars"
    )
  );
  lines.push(
    numRow(
      "System prompt (tokens est.)",
      ctxA?.["systemPromptTokensEstimated"]?.value,
      ctxB?.["systemPromptTokensEstimated"]?.value,
      "tokens"
    )
  );
  lines.push(
    numRow(
      "Tool count",
      ctxA?.["toolCount"]?.value,
      ctxB?.["toolCount"]?.value,
      "tools"
    )
  );
  lines.push(
    numRow(
      "Tool defs (chars)",
      ctxA?.["toolDefinitionsChars"]?.value,
      ctxB?.["toolDefinitionsChars"]?.value,
      "chars"
    )
  );
  lines.push(
    numRow(
      "Total overhead (chars)",
      ctxA?.["totalOverheadChars"]?.value,
      ctxB?.["totalOverheadChars"]?.value,
      "chars"
    )
  );
  lines.push(numRow("Hook count", snapA.hookCount, snapB.hookCount, "hooks"));
  lines.push(hashRow("Binary hash", snapA.binaryHash, snapB.binaryHash));
  lines.push(
    hashRow("System prompt hash", snapA.systemPromptHash, snapB.systemPromptHash)
  );
  lines.push(
    hashRow("Hook source hash", snapA.hookSourceHash, snapB.hookSourceHash)
  );
  lines.push("");

  // ── Tool additions / removals ────────────────────────────────────────────
  const perToolA = extractPerTool(snapA);
  const perToolB = extractPerTool(snapB);

  if (perToolA.length > 0 || perToolB.length > 0) {
    const namesA = new Set(perToolA.map((t) => t.name));
    const namesB = new Set(perToolB.map((t) => t.name));
    const added = [...namesB].filter((n) => !namesA.has(n)).sort();
    const removed = [...namesA].filter((n) => !namesB.has(n)).sort();

    if (added.length > 0) {
      lines.push(`## Added Tools (+${added.length})`);
      lines.push("");
      for (const name of added) {
        const chars = perToolB.find((t) => t.name === name)?.chars ?? 0;
        lines.push(`- \`${name}\` (${chars} chars)`);
      }
      lines.push("");
    }

    if (removed.length > 0) {
      lines.push(`## Removed Tools (-${removed.length})`);
      lines.push("");
      for (const name of removed) {
        const chars = perToolA.find((t) => t.name === name)?.chars ?? 0;
        lines.push(`- \`${name}\` (was ${chars} chars)`);
      }
      lines.push("");
    }

    if (added.length === 0 && removed.length === 0) {
      lines.push(`## Tool Changes`);
      lines.push("");
      lines.push(`> Tool set unchanged (${namesA.size} tools).`);
      lines.push("");
    }
  }

  // ── Model pool changes ───────────────────────────────────────────────────
  if (report.modelPoolChanges.length > 0) {
    lines.push(`## Model Pool Changes`);
    lines.push("");
    for (const change of report.modelPoolChanges) {
      if (change.type === "added" && change.after) {
        const m = change.after;
        lines.push(
          `- ✅ **Added**: \`${m.id}\` — state: ${m.state}, ctx: ${m.contextWindow.toLocaleString()} tokens`
        );
      } else if (change.type === "removed" && change.before) {
        const m = change.before;
        lines.push(`- ❌ **Removed**: \`${m.id}\` — was state: ${m.state}`);
      } else if (
        change.type === "state_changed" &&
        change.before &&
        change.after
      ) {
        lines.push(
          `- ⚠️ **State changed**: \`${change.modelId}\` — ${change.before.state} → ${change.after.state}`
        );
      } else if (
        change.type === "context_window_changed" &&
        change.before &&
        change.after
      ) {
        lines.push(
          `- ⚠️ **Context window**: \`${change.modelId}\` — ${change.before.contextWindow.toLocaleString()} → ${change.after.contextWindow.toLocaleString()} tokens`
        );
      }
    }
    lines.push("");
  } else if (snapA.modelPool || snapB.modelPool) {
    lines.push(`## Model Pool Changes`);
    lines.push("");
    lines.push(`> No model pool changes detected.`);
    lines.push("");
  }

  // ── Per-experiment full metric table (experiments and metrics sorted for
  //    stable, deterministic output regardless of JSON key insertion order) ──
  const experimentNames = [
    ...new Set([
      ...Object.keys(snapA.experiments),
      ...Object.keys(snapB.experiments),
    ]),
  ].sort();

  lines.push(`## Experiment Metrics`);
  lines.push("");

  for (const expName of experimentNames) {
    const expA = snapA.experiments[expName];
    const expB = snapB.experiments[expName];

    lines.push(`### ${expName}`);
    lines.push("");

    if (!expA) {
      lines.push(`> ⚠️ **New experiment** — no baseline to compare.`);
      lines.push("");
      continue;
    }
    if (!expB) {
      lines.push(`> ⚠️ **Experiment removed** — no current data.`);
      lines.push("");
      continue;
    }

    lines.push(`| Metric | ${dateA} | ${dateB} | Delta |`);
    lines.push(
      `|--------|${"-".repeat(dateA.length + 2)}|${"-".repeat(dateB.length + 2)}|-------|`
    );

    // Sort metric keys for stable output
    const metricKeys = [
      ...new Set([
        ...Object.keys(expA.metrics),
        ...Object.keys(expB.metrics),
      ]),
    ].sort();

    for (const key of metricKeys) {
      const mA = expA.metrics[key];
      const mB = expB.metrics[key];
      if (mA && !mB) {
        lines.push(
          `| ${key} | ${mA.value.toLocaleString()} ${mA.unit} | — | removed |`
        );
      } else if (!mA && mB) {
        lines.push(
          `| ${key} | — | ${mB.value.toLocaleString()} ${mB.unit} | new |`
        );
      } else if (mA && mB) {
        const delta =
          deltaStr(mA.value, mB.value) + severityIcon(mA.value, mB.value);
        lines.push(
          `| ${key} | ${mA.value.toLocaleString()} ${mA.unit} | ${mB.value.toLocaleString()} ${mB.unit} | ${delta} |`
        );
      }
    }

    lines.push("");
  }

  // ── Overall assessment ───────────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  if (report.hasRegressions) {
    lines.push(
      "🔴 **Regression detected** — one or more metrics changed by >10%."
    );
  } else if (report.changes.some((c) => c.severity === "warning")) {
    lines.push("🟡 **Warning** — one or more metrics changed by 5–10%.");
  } else {
    lines.push(
      "✅ **No regression** — all metric changes within the 5% info threshold."
    );
  }
  lines.push("");
  lines.push("| Severity | Threshold |");
  lines.push("|----------|-----------|");
  lines.push("| ⚪ Info | < 5% change |");
  lines.push("| 🟡 Warning | 5–10% change |");
  lines.push("| 🔴 Regression | > 10% change |");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    `*Generated by [cli-wrapper-monitor](https://github.com/copilot-autogent/cli-wrapper-monitor) — compare-baselines*`
  );

  return lines.join("\n");
}

function main(): void {
  const { a, b, json: jsonMode, output } = parseArgs();

  const snapA = loadSnapshot(a);
  const snapB = loadSnapshot(b);

  let content: string;
  if (jsonMode) {
    const report = diffSnapshots(snapA, snapB);
    content = JSON.stringify(report, null, 2);
  } else {
    content = generateMarkdownReport(snapA, snapB);
  }

  if (output) {
    writeFileSync(resolve(output), content, "utf-8");
    console.log(`Report written to: ${output}`);
  } else {
    console.log(content);
  }
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
