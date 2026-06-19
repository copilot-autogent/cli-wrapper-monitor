#!/usr/bin/env npx ts-node --esm
/**
 * Generate a markdown diff report comparing two baseline snapshots.
 *
 * Usage:
 *   npx ts-node --esm scripts/generate-diff-report.ts [--baseline <path>] [--current <path>] [--output <path>]
 *
 * Defaults:
 *   --baseline   baselines/latest.json
 *   --current    baselines/latest.json
 *   --output     stdout
 *
 * Note: possibleCauses reflects the window at the time the current snapshot was
 * captured. For non-consecutive baseline pairs the provenance section is best-effort.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import type { MetricSnapshot } from "../src/harness/types.js";

function parseArgs() {
  const args = process.argv.slice(2);
  let baseline = "baselines/latest.json", current = "";
  let output: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--baseline" && args[i + 1]) baseline = args[++i];
    else if (args[i] === "--current" && args[i + 1]) current = args[++i];
    else if (args[i] === "--output" && args[i + 1]) output = args[++i];
  }
  if (!current) {
    const files = readdirSync(resolve("baselines"))
      .filter((f) => f.endsWith(".json") && f !== "schema.json" && f !== "latest.json")
      .sort().reverse();
    current = files.length > 0 ? join("baselines", files[0]) : baseline;
  }
  return { baseline, current, output };
}

function loadSnapshot(path: string): MetricSnapshot {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`Snapshot file not found: ${abs}`);
  return JSON.parse(readFileSync(abs, "utf-8")) as MetricSnapshot;
}

function pct(a: number, b: number): string {
  if (a === 0) return "N/A";
  const change = ((b - a) / a) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
}

function severity(a: number, b: number): string {
  if (a === 0) return "";
  const change = Math.abs(((b - a) / a) * 100);
  if (change < 5) return "⚪";
  if (change < 10) return "🟡";
  return "🔴";
}

function formatValue(value: number, unit: string): string {
  return `${value.toLocaleString()} ${unit}`;
}

function generateDiffReport(baselineSnap: MetricSnapshot, currentSnap: MetricSnapshot): string {
  const lines: string[] = [];
  const baseDate = new Date(baselineSnap.capturedAt).toISOString().slice(0, 10);
  const currDate = new Date(currentSnap.capturedAt).toISOString().slice(0, 10);

  lines.push(
    "# CLI Wrapper Monitor — Diff Report", "",
    "| | Value |", "|---|---|",
    `| **Baseline** | ${baseDate} (v${baselineSnap.monitorVersion}) |`,
    `| **Current** | ${currDate} (v${currentSnap.monitorVersion}) |`,
    `| **Model** | ${baselineSnap.model} → ${currentSnap.model} |`,
    `| **SDK** | ${baselineSnap.sdkVersion} → ${currentSnap.sdkVersion} |`,
    "");

  const binaryChanged = baselineSnap.binaryHash && currentSnap.binaryHash &&
    baselineSnap.binaryHash !== 'unknown' && currentSnap.binaryHash !== 'unknown' &&
    baselineSnap.binaryHash !== currentSnap.binaryHash;
  const systemPromptChanged = baselineSnap.systemPromptHash && currentSnap.systemPromptHash &&
    baselineSnap.systemPromptHash !== 'unknown' && currentSnap.systemPromptHash !== 'unknown' &&
    baselineSnap.systemPromptHash !== currentSnap.systemPromptHash;

  if (binaryChanged || systemPromptChanged) {
    lines.push("## ⚠️ Fingerprint Changes", "");
    if (binaryChanged) lines.push(`- **CLI binary changed**: \`${baselineSnap.binaryHash!.slice(0, 15)}…\` → \`${currentSnap.binaryHash!.slice(0, 15)}…\``);
    if (systemPromptChanged) lines.push(`- **System prompt changed**: \`${baselineSnap.systemPromptHash!.slice(0, 15)}…\` → \`${currentSnap.systemPromptHash!.slice(0, 15)}…\``);
    lines.push("");
  }

  const experimentNames = new Set([...Object.keys(baselineSnap.experiments), ...Object.keys(currentSnap.experiments)]);
  let hasRegression = false, hasWarning = false;

  for (const expName of experimentNames) {
    const baseExp = baselineSnap.experiments[expName];
    const currExp = currentSnap.experiments[expName];
    lines.push(`## ${expName}`, "");
    if (!baseExp) {
      lines.push("> ⚠️ **New experiment** — no baseline to compare against.", "");
      if (currExp) {
        lines.push("| Metric | Current | Unit |", "|--------|---------|------|")
        for (const [key, metric] of Object.entries(currExp.metrics)) lines.push(`| ${key} | ${metric.value.toLocaleString()} | ${metric.unit} |`);
      }
      continue;
    }
    if (!currExp) { lines.push("> ⚠️ **Experiment removed** — no current data.", ""); continue; }
    lines.push("| Metric | Baseline | Current | Change | |", "|--------|----------|---------|--------|--|")
    for (const [key, baseMetric] of Object.entries(baseExp.metrics)) {
      const currMetric = currExp.metrics[key];
      if (!currMetric) { lines.push(`| ${key} | ${formatValue(baseMetric.value, baseMetric.unit)} | — | removed | ⚠️ |`); continue; }
      const sev = severity(baseMetric.value, currMetric.value);
      if (sev === "🔴") hasRegression = true;
      if (sev === "🟡") hasWarning = true;
      lines.push(`| ${key} | ${formatValue(baseMetric.value, baseMetric.unit)} | ${formatValue(currMetric.value, currMetric.unit)} | ${pct(baseMetric.value, currMetric.value)} | ${sev} |`);
    }
    for (const [key, currMetric] of Object.entries(currExp.metrics)) {
      if (!baseExp.metrics[key]) lines.push(`| ${key} | — | ${formatValue(currMetric.value, currMetric.unit)} | new | ⚪ |`);
    }
    lines.push("");
  }

  // ── Possible causes (provenance linking) ────────────────────────────────
  if (currentSnap.possibleCauses && currentSnap.possibleCauses.length > 0) {
    lines.push("## Possible Causes", "",
      "Autogent PRs from the current snapshot's capture window that touched monitored paths:", "");
    for (const cause of currentSnap.possibleCauses) {
      const url = "https://github.com/" + cause.pr.replace("#", "/pull/");
      lines.push("- [`" + cause.pr + "`](" + url + ") — **" + cause.title + "** (merged " + cause.mergedAt + ") `[" + cause.touchedPaths.join(", ") + "]`");
    }
    lines.push("");
  }

  lines.push("## Summary", "");
  if (hasRegression) lines.push("🔴 **Regression detected** — one or more metrics changed by >10%.");
  else if (hasWarning) lines.push("🟡 **Warning** — one or more metrics changed by 5–10%.");
  else lines.push("✅ **No regression** — all metric changes are within the 5% info threshold.");
  lines.push("",
    "| Severity | Threshold |",
    "|----------|-----------|" ,
    "| ⚪ Info | < 5% change |",
    "| 🟡 Warning | 5–10% change |",
    "| 🔴 Regression | > 10% change |",
    "", "---", "",
    "*Generated by [cli-wrapper-monitor](https://github.com/copilot-autogent/cli-wrapper-monitor)*");

  return lines.join("\n");
}

function main(): void {
  const { baseline, current, output } = parseArgs();
  if (baseline === current) {
    console.warn("⚠️  Baseline and current point to the same file. Run a new snapshot first.");
    console.warn(`   Baseline: ${baseline}`);
    console.warn(`   Current:  ${current}`);
    console.warn("");
    console.warn("Generating self-comparison report for reference...");
  }
  const baselineSnap = loadSnapshot(baseline), currentSnap = loadSnapshot(current);
  const report = generateDiffReport(baselineSnap, currentSnap);
  if (output) { writeFileSync(resolve(output), report, "utf-8"); console.log(`Diff report written to: ${output}`); }
  else { console.log(report); }
}

main();
