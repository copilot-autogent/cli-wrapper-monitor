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
 *
 * Note: possibleCauses in the report reflects the window captured at snapshot B's
 * creation time. For non-consecutive comparisons, the provenance section is
 * best-effort and may not cover the full A→B window.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { MetricSnapshot } from "../src/harness/types.js";
import { diffSnapshots } from "../src/harness/diff.js";
import { validateBaselineFile } from "../src/harness/validator.js";
import {
  BREAKING_THRESHOLD_PCT,
  WARNING_THRESHOLD_PCT,
  SEVERITY_EMOJI,
  classifyDeltaPct,
  sendSeveritySummaryWebhook,
  sendToolRemovedWebhook,
  sendModelRemovedWebhook,
  type SeverityLevel,
} from "../src/severity.js";

interface CliArgs { a: string; b: string; json: boolean; output: string | null; }

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let a = "", b = "", jsonMode = false;
  let output: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--a" && args[i + 1] && !args[i + 1].startsWith("--")) { a = args[++i]; }
    else if (args[i] === "--b" && args[i + 1] && !args[i + 1].startsWith("--")) { b = args[++i]; }
    else if (args[i] === "--json") { jsonMode = true; }
    else if (args[i] === "--output" && args[i + 1] && !args[i + 1].startsWith("--")) { output = args[++i]; }
    else if (args[i].startsWith("--")) {
      const hasValue = args[i + 1] !== undefined && !args[i + 1].startsWith("--");
      console.warn(`Warning: unrecognized flag "${args[i]}" — ignored.`);
      if (hasValue) i++;
    } else { positional.push(args[i]); }
  }
  if (!a && positional[0]) a = positional[0];
  if (!b && positional[1]) b = positional[1];
  if (!a || !b) {
    console.error("Usage: compare-baselines <file-a> <file-b> [--json] [--output <path>]\n" +
      "  file-a           Path to the older (reference) baseline JSON\n" +
      "  file-b           Path to the newer baseline JSON\n" +
      "  --json           Output raw DiffReport JSON instead of Markdown\n" +
      "  --output <path>  Write report to file");
    process.exit(1);
  }
  return { a, b, json: jsonMode, output };
}

function loadSnapshot(path: string): MetricSnapshot {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`Snapshot not found: ${abs}`);
  try {
    return JSON.parse(readFileSync(abs, "utf-8")) as MetricSnapshot;
  } catch (err) {
    throw new Error(`Invalid JSON in ${abs}: ${String(err)}`);
  }
}

function shortDate(capturedAt: unknown): string {
  if (typeof capturedAt === "string" && capturedAt.length >= 10) return capturedAt.slice(0, 10);
  return "unknown-date";
}

function shortHash(hash: string | undefined): string {
  if (!hash || hash === "unknown") return "unknown";
  return hash.replace(/^sha256:/, "").slice(0, 15) + "…";
}

function pctStr(a: number, b: number): string {
  if (a === 0) return b === 0 ? "0%" : "N/A";
  const pct = ((b - a) / a) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function deltaStr(a: number, b: number): string {
  const d = b - a;
  return `${d >= 0 ? "+" : ""}${d.toLocaleString()} (${pctStr(a, b)})`;
}

function severityEmoji(a: number, b: number): string {
  if (a === 0) return "";
  const pct = Math.abs(((b - a) / a) * 100);
  const level: SeverityLevel = classifyDeltaPct(pct);
  if (level === 'INFO') return "";
  return " " + SEVERITY_EMOJI[level];
}

function numRow(label: string, valA: number | undefined, valB: number | undefined, unit = ""): string {
  const na = "—";
  const fmt = (v: number) => v.toLocaleString() + (unit ? ` ${unit}` : "");
  const aStr = valA !== undefined ? fmt(valA) : na;
  const bStr = valB !== undefined ? fmt(valB) : na;
  let delta: string;
  if (valA !== undefined && valB !== undefined) delta = deltaStr(valA, valB) + severityEmoji(valA, valB);
  else if (valA === undefined && valB !== undefined) delta = `+${fmt(valB)} (new)`;
  else if (valA !== undefined && valB === undefined) delta = `${na} (removed)`;
  else delta = na;
  return `| ${label} | ${aStr} | ${bStr} | ${delta} |`;
}

function hashRow(label: string, hA: string | undefined, hB: string | undefined): string {
  const sA = shortHash(hA), sB = shortHash(hB);
  let delta: string;
  const knownA = hA && hA !== "unknown", knownB = hB && hB !== "unknown";
  if (knownA && knownB) delta = hA === hB ? "✅ unchanged" : "⚠️ changed";
  else if (!knownA && knownB) delta = "new";
  else if (knownA && !knownB) delta = "removed";
  else delta = "—";
  return "| " + label + " | `" + sA + "` | `" + sB + "` | " + delta + " |";
}

interface PerToolEntry { name: string; chars: number; }

function extractPerTool(snap: MetricSnapshot): PerToolEntry[] {
  const raw = snap.experiments["context-tax"]?.rawData as { perToolChars?: unknown[] } | undefined;
  if (!Array.isArray(raw?.perToolChars)) return [];
  return raw.perToolChars.filter((e): e is PerToolEntry =>
    typeof e === "object" && e !== null &&
    typeof (e as Record<string, unknown>)["name"] === "string" &&
    typeof (e as Record<string, unknown>)["chars"] === "number"
  );
}

function generateMarkdownReport(snapA: MetricSnapshot, snapB: MetricSnapshot): string {
  const report = diffSnapshots(snapA, snapB);
  const dateA = shortDate(snapA.capturedAt);
  const dateB = shortDate(snapB.capturedAt);
  const lines: string[] = [];
  const sep = (n: number) => "-".repeat(n);

  lines.push(`## Baseline Comparison: ${dateA} vs ${dateB}`, "",
    `| | ${dateA} | ${dateB} |`, "|---|---|---|",
    `| Monitor version | \`${snapA.monitorVersion}\` | \`${snapB.monitorVersion}\` |`,
    `| SDK version | ${snapA.sdkVersion} | ${snapB.sdkVersion} |`,
    `| Model | ${snapA.model} | ${snapB.model} |`, "");

  lines.push(`## Metric Summary`, "",
    `| Metric | ${dateA} | ${dateB} | Delta |`,
    `|--------|${sep(dateA.length + 2)}|${sep(dateB.length + 2)}|-------|`);

  const ctxA = snapA.experiments["context-tax"]?.metrics;
  const ctxB = snapB.experiments["context-tax"]?.metrics;
  lines.push(
    numRow("System prompt (chars)", ctxA?.["systemPromptChars"]?.value, ctxB?.["systemPromptChars"]?.value, "chars"),
    numRow("System prompt (tokens est.)", ctxA?.["systemPromptTokensEstimated"]?.value, ctxB?.["systemPromptTokensEstimated"]?.value, "tokens"),
    numRow("Tool count", ctxA?.["toolCount"]?.value, ctxB?.["toolCount"]?.value, "tools"),
    numRow("Tool defs (chars)", ctxA?.["toolDefinitionsChars"]?.value, ctxB?.["toolDefinitionsChars"]?.value, "chars"),
    numRow("Total overhead (chars)", ctxA?.["totalOverheadChars"]?.value, ctxB?.["totalOverheadChars"]?.value, "chars"),
    numRow("Hook count", snapA.hookCount, snapB.hookCount, "hooks"),
    hashRow("Binary hash", snapA.binaryHash, snapB.binaryHash),
    hashRow("System prompt hash", snapA.systemPromptHash, snapB.systemPromptHash),
    hashRow("Hook source hash", snapA.hookSourceHash, snapB.hookSourceHash),
    hashRow("Tool schema hash", snapA.toolSchemaHash, snapB.toolSchemaHash),
    "");

  const perToolA = extractPerTool(snapA), perToolB = extractPerTool(snapB);
  if (perToolA.length > 0 || perToolB.length > 0) {
    const namesA = new Set(perToolA.map((t) => t.name));
    const namesB = new Set(perToolB.map((t) => t.name));
    const added = [...namesB].filter((n) => !namesA.has(n)).sort();
    const removed = [...namesA].filter((n) => !namesB.has(n)).sort();
    if (added.length > 0) {
      lines.push(`## Added Tools (+${added.length})`, "");
      added.forEach((name) => { const chars = perToolB.find((t) => t.name === name)?.chars ?? 0; lines.push(`- \`${name}\` (${chars} chars)`); });
      lines.push("");
    }
    if (removed.length > 0) {
      lines.push(`## Removed Tools (-${removed.length})`, "");
      removed.forEach((name) => { const chars = perToolA.find((t) => t.name === name)?.chars ?? 0; lines.push(`- \`${name}\` (was ${chars} chars)`); });
      lines.push("");
    }
    if (added.length === 0 && removed.length === 0) lines.push(`## Tool Changes`, "", `> Tool set unchanged (${namesA.size} tools).`, "");
  }

  // Tool schema changes (parameter-level diffs)
  if (report.toolSchemaChanges.length > 0) {
    lines.push(`## Tool Schema Changes`, "");
    for (const change of report.toolSchemaChanges) {
      if (change.type === "added") {
        const s = change.after!;
        lines.push(`- ✅ **Added tool**: \`${change.toolName}\` — ${s.parameterCount} params (required: [${s.requiredParams.join(", ")}])`);
      } else if (change.type === "removed") {
        const s = change.before!;
        lines.push(`- ❌ **Removed tool**: \`${change.toolName}\` — was ${s.parameterCount} params (required: [${s.requiredParams.join(", ")}])`);
      } else if (change.type === "params_changed") {
        const addedP = (change.addedParams ?? []).map((p) => `+ \`${p}\``).join(", ");
        const removedP = (change.removedParams ?? []).map((p) => `- \`${p}\``).join(", ");
        lines.push(`- ⚠️ **Params changed**: \`${change.toolName}\` — ${[addedP, removedP].filter(Boolean).join("; ")}`);
      } else if (change.type === "description_changed") {
        const prev = change.before!.descriptionHash.slice(0, 8);
        const curr = change.after!.descriptionHash.slice(0, 8);
        lines.push(`- ⚠️ **Description changed**: \`${change.toolName}\` — hash: \`${prev}…\` → \`${curr}…\``);
      }
    }
    lines.push("");
  } else if (snapA.toolSchemas !== undefined && snapB.toolSchemas !== undefined) {
    lines.push(`## Tool Schema Changes`, "", "> No tool schema changes detected.", "");
  }

  if (report.modelPoolChanges.length > 0) {
    lines.push(`## Model Pool Changes`, "");
    for (const change of report.modelPoolChanges) {
      if (change.type === "added" && change.after) lines.push(`- ✅ **Added**: \`${change.after.id}\` — state: ${change.after.state}, ctx: ${change.after.contextWindow.toLocaleString()} tokens`);
      else if (change.type === "removed" && change.before) lines.push(`- ❌ **Removed**: \`${change.before.id}\` — was state: ${change.before.state}`);
      else if (change.type === "state_changed" && change.before && change.after) lines.push(`- ⚠️ **State changed**: \`${change.modelId}\` — ${change.before.state} → ${change.after.state}`);
      else if (change.type === "context_window_changed" && change.before && change.after) lines.push(`- ⚠️ **Context window**: \`${change.modelId}\` — ${change.before.contextWindow.toLocaleString()} → ${change.after.contextWindow.toLocaleString()} tokens`);
    }
    lines.push("");
  } else if (snapA.modelPool || snapB.modelPool) lines.push(`## Model Pool Changes`, "", "> No model pool changes detected.", "");

  const experimentNames = [...new Set([...Object.keys(snapA.experiments), ...Object.keys(snapB.experiments)])].sort();
  lines.push(`## Experiment Metrics`, "");
  for (const expName of experimentNames) {
    const expA = snapA.experiments[expName], expB = snapB.experiments[expName];
    lines.push(`### ${expName}`, "");
    if (!expA) { lines.push("> ⚠️ **New experiment** — no baseline to compare.", ""); continue; }
    if (!expB) { lines.push("> ⚠️ **Experiment removed** — no current data.", ""); continue; }
    lines.push(`| Metric | ${dateA} | ${dateB} | Delta |`, `|--------|${sep(dateA.length + 2)}|${sep(dateB.length + 2)}|-------|`);
    const metricKeys = [...new Set([...Object.keys(expA.metrics), ...Object.keys(expB.metrics)])].sort();
    for (const key of metricKeys) {
      const mA = expA.metrics[key], mB = expB.metrics[key];
      if (mA && !mB) lines.push(`| ${key} | ${mA.value.toLocaleString()} ${mA.unit} | — | removed |`);
      else if (!mA && mB) lines.push(`| ${key} | — | ${mB.value.toLocaleString()} ${mB.unit} | new |`);
      else if (mA && mB) lines.push(`| ${key} | ${mA.value.toLocaleString()} ${mA.unit} | ${mB.value.toLocaleString()} ${mB.unit} | ${deltaStr(mA.value, mB.value) + severityEmoji(mA.value, mB.value)} |`);
    }
    lines.push("");
  }

  // ── Possible causes (provenance linking) ────────────────────────────────
  if (snapB.possibleCauses && snapB.possibleCauses.length > 0) {
    lines.push("## Possible Causes", "",
      "Autogent PRs from snapshot B's capture window that touched monitored paths:", "");
    for (const cause of snapB.possibleCauses) {
      const url = "https://github.com/" + cause.pr.replace("#", "/pull/");
      lines.push("- [`" + cause.pr + "`](" + url + ") — **" + cause.title + "** (merged " + cause.mergedAt + ") `[" + cause.touchedPaths.join(", ") + "]`");
    }
    lines.push("");
  }

  lines.push("---", "");

  const { severitySummary, structuralBreaks } = report;

  // ── Structural BREAKING annotations ──────────────────────────────────────
  if (structuralBreaks.length > 0) {
    lines.push("## Structural BREAKING Changes", "");
    for (const sb of structuralBreaks) {
      lines.push(`- 🔴 **BREAKING**: ${sb}`);
    }
    lines.push("");
  }

  // ── Severity summary ─────────────────────────────────────────────────────
  const summaryParts = [
    severitySummary.breaking > 0 ? `${severitySummary.breaking} BREAKING` : null,
    severitySummary.structuralBreakCount > 0 ? `${severitySummary.structuralBreakCount} structural BREAKING` : null,
    severitySummary.warning > 0 ? `${severitySummary.warning} WARNING` : null,
    severitySummary.info > 0 ? `${severitySummary.info} INFO` : null,
  ].filter(Boolean);

  if (report.hasBreaking) {
    lines.push(`🔴 **BREAKING regression detected** — ${summaryParts.join(", ")}`);
  } else if (severitySummary.warning > 0) {
    lines.push(`🟡 **Warning** — ${summaryParts.join(", ")}`);
  } else {
    lines.push("🟢 **No regression** — all metric changes below the WARNING threshold.");
  }

  lines.push("",
    "| Severity | Threshold |",
    "|----------|-----------|",
    `| 🟢 INFO | < ${WARNING_THRESHOLD_PCT}% change |`,
    `| 🟡 WARNING | ${WARNING_THRESHOLD_PCT}–${BREAKING_THRESHOLD_PCT}% change |`,
    `| 🔴 BREAKING | > ${BREAKING_THRESHOLD_PCT}% change, or tool/hook count drop |`,
    "", "---", "",
    "*Generated by [cli-wrapper-monitor](https://github.com/copilot-autogent/cli-wrapper-monitor) — compare-baselines*");

  return lines.join("\n");
}

async function main(): Promise<void> {
  const { a, b, json: jsonMode, output } = parseArgs();

  // Pre-validate both input files before attempting the diff
  for (const [label, filePath] of [["file-a", a], ["file-b", b]] as [string, string][]) {
    const result = validateBaselineFile(resolve(filePath));
    if (!result.valid) {
      console.error(`Error: baseline integrity check failed for ${label} (${filePath}):`);
      for (const err of result.errors) {
        console.error(`  [${err.field}] ${err.message}`);
      }
      process.exit(1);
    }
  }

  const snapA = loadSnapshot(a), snapB = loadSnapshot(b);
  const report = diffSnapshots(snapA, snapB);
  let content: string;
  if (jsonMode) { content = JSON.stringify(report, null, 2); }
  else { content = generateMarkdownReport(snapA, snapB); }
  if (output) { writeFileSync(resolve(output), content, "utf-8"); console.log(`Report written to: ${output}`); }
  else { console.log(content); }

  // Await webhook so it completes before any process.exit — especially important
  // on BREAKING runs where we exit immediately after.
  const { GITHUB_SERVER_URL, GITHUB_RUN_ID, GITHUB_REPOSITORY } = process.env;
  const ciRunUrl = GITHUB_SERVER_URL && GITHUB_RUN_ID && GITHUB_REPOSITORY
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : undefined;
  const dateA = shortDate(snapA.capturedAt), dateB = shortDate(snapB.capturedAt);
  await sendSeveritySummaryWebhook(report.severitySummary, dateA, dateB, ciRunUrl);

  // Fire a dedicated alert for removed tools — high-signal event warranting its own message.
  // Covers two cases:
  //   1. Named tool removal (diffToolSchemas found type:'removed' entries)
  //   2. Schema capture disappeared (baseline had tools but current has no toolSchemas)
  const removedTools = report.toolSchemaChanges
    .filter((c) => c.type === 'removed')
    .map((c) => c.toolName);
  const schemaDisappeared = report.structuralBreaks.some((s) => s.startsWith('Tool schema data disappeared'));
  const toolsToAlert = schemaDisappeared
    ? ['(all tools — schema capture missing in current snapshot)']
    : removedTools;
  await sendToolRemovedWebhook(toolsToAlert, dateA, dateB, ciRunUrl);

  // Fire a dedicated alert for removed models — high-signal event warranting its own message.
  const removedModels = report.modelPoolChanges
    .filter((c) => c.type === 'removed')
    .map((c) => c.modelId);
  await sendModelRemovedWebhook(removedModels, dateA, dateB, ciRunUrl);

  // Exit with code 1 when any BREAKING delta is present so CI fails on regressions.
  if (report.hasBreaking) {
    console.error(
      `\n🔴 BREAKING regression detected — exiting with code 1.\n` +
      `  Breaking deltas: ${report.severitySummary.breaking}` +
      (report.structuralBreaks.length > 0
        ? `\n  Structural breaks:\n${report.structuralBreaks.map((s) => `    - ${s}`).join("\n")}`
        : ""),
    );
    process.exit(1);
  }
}

main().catch((err) => { console.error(`Error: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
