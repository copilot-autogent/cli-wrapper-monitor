#!/usr/bin/env -S npx tsx
/**
 * Compare two baseline JSON snapshots and output a structured diff report.
 *
 * Usage:
 *   npm run compare                                    # latest vs previous (auto-resolved)
 *   npm run compare -- --from=2026-06-03               # specified from vs latest
 *   npm run compare -- --from=2026-06-03 --to=2026-07-03  # explicit pair
 *   npm run compare -- --list                          # list all available baseline dates
 *   npm run compare -- <file-a> <file-b>               # explicit file paths (legacy)
 *   npm run compare -- --a <path> --b <path>           # explicit file paths (legacy)
 *
 * Options:
 *   --from <YYYY-MM-DD>  Resolve older (reference) baseline by date
 *   --to   <YYYY-MM-DD>  Resolve newer baseline by date
 *   --list               List all available baseline dates and exit
 *   --json               Output raw DiffReport as JSON instead of Markdown
 *   --output <path>      Write report to file instead of stdout
 *   --no-bundle          Send individual Discord webhooks instead of bundling
 *
 * Date resolution: searches baselines/<date>.json (monthly) first, then
 * baselines/weekly/<date>.json. When a date exists in both, monthly is preferred.
 *
 * Note: possibleCauses in the report reflects the window captured at snapshot B's
 * creation time. For non-consecutive comparisons, the provenance section is
 * best-effort and may not cover the full A→B window.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import {
  listAllBaselines,
  resolveBaselineByDate,
  findLatestBaseline,
  findPreviousBaseline,
} from "../src/harness/baseline-resolver.js";
import type { MetricSnapshot } from "../src/harness/types.js";
import { diffSnapshots } from "../src/harness/diff.js";
import { validateSnapshot } from "../src/harness/validator.js";
import { migrate, CURRENT_SCHEMA_VERSION } from "../src/harness/baseline-migrator.js";
import {
  BREAKING_THRESHOLD_PCT,
  WARNING_THRESHOLD_PCT,
  SEVERITY_EMOJI,
  classifyDeltaPct,
  sendSeveritySummaryWebhook,
  sendToolRemovedWebhook,
  sendModelRemovedWebhook,
  sendHookChangedWebhook,
  buildSeveritySummaryAlert,
  buildToolRemovedAlert,
  buildModelRemovedAlert,
  buildHookChangedAlert,
  type SeverityLevel,
} from "../src/severity.js";
import { bundleWebhooks, type WebhookAlert } from "../src/harness/webhook-utils.js";
import { loadAnnotation } from "../src/harness/annotations.js";

interface CliArgs {
  /** Explicit file path for the older (reference) baseline (legacy positional / --a flag) */
  a: string;
  /** Explicit file path for the newer baseline (legacy positional / --b flag) */
  b: string;
  /** Date string for --from flag (YYYY-MM-DD) */
  from: string | null;
  /** Date string for --to flag (YYYY-MM-DD) */
  to: string | null;
  /** Print all available baseline dates and exit */
  list: boolean;
  json: boolean;
  output: string | null;
  noBundle: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let a = "", b = "", jsonMode = false, noBundle = false, list = false;
  let from: string | null = null, to: string | null = null;
  let output: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    const nextIsValue = nextArg !== undefined && !nextArg.startsWith("--");

    if (arg === "--a" && nextIsValue) { a = args[++i]; }
    else if (arg === "--b" && nextIsValue) { b = args[++i]; }
    else if (arg === "--json") { jsonMode = true; }
    else if (arg === "--list") { list = true; }
    else if (arg === "--no-bundle") { noBundle = true; }
    else if (arg === "--output" && nextIsValue) { output = args[++i]; }
    else if (arg.startsWith("--from=")) { from = arg.slice("--from=".length); }
    else if (arg === "--from" && nextIsValue) { from = args[++i]; }
    else if (arg.startsWith("--to=")) { to = arg.slice("--to=".length); }
    else if (arg === "--to" && nextIsValue) { to = args[++i]; }
    else if (arg.startsWith("--")) {
      console.warn(`Warning: unrecognized flag "${arg}" — ignored.`);
      if (nextIsValue) i++;
    } else { positional.push(arg); }
  }

  if (!a && positional[0]) a = positional[0];
  if (!b && positional[1]) b = positional[1];

  // When --from/--to/--list are in use, explicit file paths are not required
  const needsExplicitPaths = !list && from === null && to === null;
  if (needsExplicitPaths && (!a || !b)) {
    console.error(
      "Usage: npm run compare [options]\n\n" +
      "  Date-based (recommended):\n" +
      "    npm run compare                              # latest vs previous (auto-resolved)\n" +
      "    npm run compare -- --from=2026-06-03         # from → latest\n" +
      "    npm run compare -- --from=2026-06-03 --to=2026-07-03  # explicit pair\n" +
      "    npm run compare -- --list                    # list available dates\n\n" +
      "  Explicit file paths (legacy):\n" +
      "    npm run compare -- <file-a> <file-b>         # compare two JSON files\n" +
      "    npm run compare -- --a <path> --b <path>     # same via named flags\n\n" +
      "  Options:\n" +
      "    --json            Output raw DiffReport JSON instead of Markdown\n" +
      "    --output <path>   Write report to file\n" +
      "    --no-bundle       Send individual Discord webhooks instead of bundling"
    );
    process.exit(1);
  }

  return { a, b, from, to, list, json: jsonMode, output, noBundle };
}

function loadSnapshot(path: string): MetricSnapshot {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`Snapshot not found: ${abs}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf-8"));
  } catch (err) {
    throw new Error(`Invalid JSON in ${abs}: ${String(err)}`);
  }
  // Migrate to current schema first, then validate — so the validator sees
  // the fully-populated fields rather than the raw legacy object.
  let migrated: MetricSnapshot;
  try {
    migrated = migrate(parsed, CURRENT_SCHEMA_VERSION);
  } catch (err) {
    throw new Error(`Schema migration failed for ${abs}: ${String(err)}`);
  }
  const result = validateSnapshot(migrated);
  if (!result.valid) {
    const msgs = result.errors.map((e) => `  [${e.field}] ${e.message}`).join('\n');
    throw new Error(`Baseline validation failed after migration for ${abs}:\n${msgs}`);
  }
  return migrated;
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

  // Annotations: show any notes for from/to dates in the header
  const noteA = loadAnnotation("notes", dateA);
  const noteB = loadAnnotation("notes", dateB);
  if (noteA !== undefined || noteB !== undefined) {
    lines.push("### 📝 Annotations", "");
    // Strip newlines to keep each annotation on a single bullet line
    if (noteA !== undefined) lines.push(`- **${dateA}**: ${noteA.replace(/[\r\n]+/g, " ")}`);
    if (noteB !== undefined) lines.push(`- **${dateB}**: ${noteB.replace(/[\r\n]+/g, " ")}`);
    lines.push("");
  }

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

  // ── Hook Changes ──────────────────────────────────────────────────────────
  const hookStructuralBreaks = report.structuralBreaks.filter((s) => s.startsWith("Hook"));
  const hookWarnings = report.warnings.filter((w) => w.startsWith("Hook body"));
  if (hookStructuralBreaks.length > 0 || hookWarnings.length > 0) {
    lines.push(`## Hook Changes`, "");
    for (const sb of hookStructuralBreaks) {
      lines.push(`- 🔴 **BREAKING**: ${sb}`);
    }
    for (const w of hookWarnings) {
      lines.push(`- 🟡 **WARNING**: ${w}`);
    }
    lines.push("");
  } else if (snapA.hookCount !== undefined || snapB.hookCount !== undefined || snapA.hookSourceHash !== undefined || snapB.hookSourceHash !== undefined) {
    lines.push(`## Hook Changes`, "", "> No hook changes detected.", "");
  }

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
  const { a, b, from, to, list, json: jsonMode, output, noBundle } = parseArgs();

  const BASELINES_DIR = resolve(process.cwd(), "baselines");

  // ── --list: print available baseline dates and exit ──────────────────────
  if (list) {
    const entries = listAllBaselines(BASELINES_DIR);
    if (entries.length === 0) {
      console.log("No baselines found.");
      return;
    }
    console.log("Available baseline dates (newest first):\n");
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!seen.has(entry.date)) {
        seen.add(entry.date);
        // Note when a date exists in both monthly and weekly
        const hasWeeklyToo =
          entry.type === "monthly" &&
          entries.some((e) => e.date === entry.date && e.type === "weekly");
        const suffix = hasWeeklyToo ? "  (also in weekly)" : "";
        console.log(`  ${entry.date}  [${entry.type}]${suffix}`);
      }
    }
    return;
  }

  // ── Resolve file paths (date-based or explicit) ───────────────────────────
  let resolvedA: string, resolvedB: string;

  if (from !== null || to !== null) {
    // At least one date flag provided — resolve both ends
    const allBaselines = listAllBaselines(BASELINES_DIR);

    if (to !== null) {
      resolvedB = resolveBaselineByDate(to, BASELINES_DIR);
    } else {
      // No --to: use the latest available baseline
      const latest = findLatestBaseline(allBaselines);
      if (!latest) throw new Error("No baselines found; capture a baseline first.");
      resolvedB = latest.path;
    }

    if (from !== null) {
      resolvedA = resolveBaselineByDate(from, BASELINES_DIR);
    } else {
      // No --from: use the baseline immediately before the resolved 'to' date
      const bDate = to ?? findLatestBaseline(allBaselines)?.date;
      if (!bDate) throw new Error("No baselines found; capture a baseline first.");
      const prev = findPreviousBaseline(bDate, allBaselines);
      if (!prev) {
        throw new Error(
          `No baseline found before ${bDate}; run \`npm run compare -- --list\` to see available dates`
        );
      }
      resolvedA = prev.path;
    }
  } else if (a && b) {
    // Legacy: explicit file paths (positional or --a/--b)
    resolvedA = a;
    resolvedB = b;
  } else {
    // No args at all: compare the two most recent baselines
    const allBaselines = listAllBaselines(BASELINES_DIR);
    const latest = findLatestBaseline(allBaselines);
    if (!latest) throw new Error("No baselines found; capture a baseline first.");
    const prev = findPreviousBaseline(latest.date, allBaselines);
    if (!prev) {
      throw new Error(
        `Only one baseline available (${latest.date}); need at least two to compare.\n` +
        `Run \`npm run compare -- --list\` to see available dates.`
      );
    }
    resolvedA = prev.path;
    resolvedB = latest.path;
  }

  // loadSnapshot() auto-migrates each baseline to the current schema version
  // and validates the result after migration.  No pre-validation needed here.
  const snapA = loadSnapshot(resolvedA), snapB = loadSnapshot(resolvedB);
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

  const removedModels = report.modelPoolChanges
    .filter((c) => c.type === 'removed')
    .map((c) => c.modelId);

  const hookCountDropped =
    snapA.hookCount !== undefined &&
    (snapB.hookCount === undefined || snapB.hookCount < snapA.hookCount);
  const hookCountIncreased =
    snapA.hookCount !== undefined &&
    snapB.hookCount !== undefined &&
    snapB.hookCount > snapA.hookCount;
  const hookBodyWarnings = report.warnings.filter((w) => w.startsWith('Hook body'));

  if (noBundle) {
    // --no-bundle: send each alert individually (useful for debugging)
    await sendSeveritySummaryWebhook(
      { ...report.severitySummary, securityPostureScore: report.securityPostureScore },
      dateA, dateB, ciRunUrl,
    );
    await sendToolRemovedWebhook(toolsToAlert, dateA, dateB, ciRunUrl);
    // Fire a dedicated alert for removed models — high-signal event warranting its own message.
    await sendModelRemovedWebhook(removedModels, dateA, dateB, ciRunUrl);
    // Fire a dedicated alert for hook fingerprint changes — security-posture signal.
    // Only fire when baseline had hook tracking (baselineHookCount defined), matching
    // diff.ts's gate — avoids false-positive BREAKING on first comparison after
    // hook tracking was introduced to older baselines.
    if (hookCountDropped || hookCountIncreased) {
      const changeType = hookCountDropped ? 'removed' : 'added';
      await sendHookChangedWebhook(
        changeType,
        { before: snapA.hookCount, after: snapB.hookCount },
        { before: snapA.hookSourceHash, after: snapB.hookSourceHash },
        dateA, dateB, ciRunUrl,
      );
    }
    // Use report.warnings as the source of truth (populated by diff.ts, avoids duplicating logic).
    if (hookBodyWarnings.length > 0) {
      await sendHookChangedWebhook(
        'body_changed',
        { before: snapA.hookCount, after: snapB.hookCount },
        { before: snapA.hookSourceHash, after: snapB.hookSourceHash },
        dateA, dateB, ciRunUrl,
      );
    }
  } else {
    // Default: collect all alerts and send as one bundled Discord message (≤1 ping per run).
    //
    // The severity summary is included as a section but NOT counted in the "N issues detected"
    // header — it is a meta overview, not itself a distinct regression event. Specific event
    // alerts (tool removed, model removed, hook changed) drive the count.
    const summaryAlert = buildSeveritySummaryAlert(
      { ...report.severitySummary, securityPostureScore: report.securityPostureScore },
      dateA, dateB, ciRunUrl,
    );

    // Specific event alerts — each represents a distinct regression event.
    const specificAlerts: WebhookAlert[] = [
      buildToolRemovedAlert(toolsToAlert, dateA, dateB, ciRunUrl),
      buildModelRemovedAlert(removedModels, dateA, dateB, ciRunUrl),
    ].filter((a): a is WebhookAlert => a !== null);

    // Fire a dedicated alert for hook fingerprint changes — security-posture signal.
    // Only fire when baseline had hook tracking (baselineHookCount defined), matching
    // diff.ts's gate — avoids false-positive BREAKING on first comparison after
    // hook tracking was introduced to older baselines.
    if (hookCountDropped || hookCountIncreased) {
      const changeType = hookCountDropped ? 'removed' : 'added';
      specificAlerts.push(buildHookChangedAlert(
        changeType,
        { before: snapA.hookCount, after: snapB.hookCount },
        { before: snapA.hookSourceHash, after: snapB.hookSourceHash },
        dateA, dateB, ciRunUrl,
      ));
    }
    // Use report.warnings as the source of truth (populated by diff.ts, avoids duplicating logic).
    if (hookBodyWarnings.length > 0) {
      specificAlerts.push(buildHookChangedAlert(
        'body_changed',
        { before: snapA.hookCount, after: snapB.hookCount },
        { before: snapA.hookSourceHash, after: snapB.hookSourceHash },
        dateA, dateB, ciRunUrl,
      ));
    }

    // Specific event alerts are listed first so they are prioritised by the greedy bundler when
    // space is tight. The severity summary (a meta overview) is appended last so it's the section
    // most likely to be dropped if the combined content nears the 2000-char limit.
    // Pass specificAlerts.length as issueCount so the bundle header counts only distinct regression
    // events — not the summary entry itself.
    // When there are no specific events, allAlerts has at most 1 entry (the summary) and
    // bundleWebhooks uses the single-alert pass-through path — issueCount is not consulted.
    const allAlerts: WebhookAlert[] = [
      ...specificAlerts,
      ...(summaryAlert ? [summaryAlert] : []),
    ];
    await bundleWebhooks(allAlerts, undefined, specificAlerts.length);
  }

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
