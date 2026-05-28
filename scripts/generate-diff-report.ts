#!/usr/bin/env npx ts-node --esm
/**
 * Generate a markdown diff report comparing two baseline snapshots.
 *
 * Usage:
 *   npx ts-node --esm scripts/generate-diff-report.ts [--baseline <path>] [--current <path>] [--output <path>]
 *
 * Defaults:
 *   --baseline   baselines/latest.json     (the stored reference)
 *   --current    baselines/latest.json     (will be replaced once a new snapshot exists)
 *   --output     stdout
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import type { MetricSnapshot, ExperimentSnapshot } from "../src/harness/types.js";

interface CliArgs {
  baseline: string;
  current: string;
  output: string | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let baseline = "baselines/latest.json";
  let current = "";
  let output: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--baseline" && args[i + 1]) baseline = args[++i];
    else if (args[i] === "--current" && args[i + 1]) current = args[++i];
    else if (args[i] === "--output" && args[i + 1]) output = args[++i];
  }

  // If --current not provided, find the most recent non-latest baseline
  if (!current) {
    const baselinesDir = resolve("baselines");
    const files = readdirSync(baselinesDir)
      .filter((f) => f.endsWith(".json") && f !== "schema.json" && f !== "latest.json")
      .sort()
      .reverse();
    current = files.length > 0 ? join("baselines", files[0]) : baseline;
  }

  return { baseline, current, output };
}

function loadSnapshot(path: string): MetricSnapshot {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`Snapshot file not found: ${abs}`);
  }
  return JSON.parse(readFileSync(abs, "utf-8")) as MetricSnapshot;
}

function pct(a: number, b: number): string {
  if (a === 0) return "N/A";
  const change = ((b - a) / a) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(1)}%`;
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

  lines.push(`# CLI Wrapper Monitor — Diff Report`);
  lines.push(``);
  lines.push(`| | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| **Baseline** | ${baseDate} (v${baselineSnap.monitorVersion}) |`);
  lines.push(`| **Current** | ${currDate} (v${currentSnap.monitorVersion}) |`);
  lines.push(`| **Model** | ${baselineSnap.model} → ${currentSnap.model} |`);
  lines.push(`| **SDK** | ${baselineSnap.sdkVersion} → ${currentSnap.sdkVersion} |`);
  lines.push(``);

  // Hash fingerprint change warnings
  const binaryChanged =
    baselineSnap.binaryHash !== undefined &&
    currentSnap.binaryHash !== undefined &&
    baselineSnap.binaryHash !== 'unknown' &&
    currentSnap.binaryHash !== 'unknown' &&
    baselineSnap.binaryHash !== currentSnap.binaryHash;

  const systemPromptChanged =
    baselineSnap.systemPromptHash !== undefined &&
    currentSnap.systemPromptHash !== undefined &&
    baselineSnap.systemPromptHash !== 'unknown' &&
    currentSnap.systemPromptHash !== 'unknown' &&
    baselineSnap.systemPromptHash !== currentSnap.systemPromptHash;

  if (binaryChanged || systemPromptChanged) {
    lines.push(`## ⚠️ Fingerprint Changes`);
    lines.push(``);
    if (binaryChanged) {
      const prev = baselineSnap.binaryHash!.slice(0, 15);
      const curr = currentSnap.binaryHash!.slice(0, 15);
      lines.push(`- **CLI binary changed**: \`${prev}…\` → \`${curr}…\``);
    }
    if (systemPromptChanged) {
      const prev = baselineSnap.systemPromptHash!.slice(0, 15);
      const curr = currentSnap.systemPromptHash!.slice(0, 15);
      lines.push(`- **System prompt changed**: \`${prev}…\` → \`${curr}…\``);
    }
    lines.push(``);
  }

  // Collect all experiment names
  const experimentNames = new Set([
    ...Object.keys(baselineSnap.experiments),
    ...Object.keys(currentSnap.experiments),
  ]);

  let hasRegression = false;
  let hasWarning = false;

  for (const expName of experimentNames) {
    const baseExp: ExperimentSnapshot | undefined = baselineSnap.experiments[expName];
    const currExp: ExperimentSnapshot | undefined = currentSnap.experiments[expName];

    lines.push(`## ${expName}`);
    lines.push(``);

    if (!baseExp) {
      lines.push(`> ⚠️ **New experiment** — no baseline to compare against.`);
      lines.push(``);
      if (currExp) {
        lines.push(`| Metric | Current | Unit |`);
        lines.push(`|--------|---------|------|`);
        for (const [key, metric] of Object.entries(currExp.metrics)) {
          lines.push(`| ${key} | ${metric.value.toLocaleString()} | ${metric.unit} |`);
        }
      }
      continue;
    }

    if (!currExp) {
      lines.push(`> ⚠️ **Experiment removed** — no current data.`);
      lines.push(``);
      continue;
    }

    lines.push(`| Metric | Baseline | Current | Change | |`);
    lines.push(`|--------|----------|---------|--------|--|`);

    for (const [key, baseMetric] of Object.entries(baseExp.metrics)) {
      const currMetric = currExp.metrics[key];
      if (!currMetric) {
        lines.push(`| ${key} | ${formatValue(baseMetric.value, baseMetric.unit)} | — | removed | ⚠️ |`);
        continue;
      }

      const change = pct(baseMetric.value, currMetric.value);
      const sev = severity(baseMetric.value, currMetric.value);

      if (sev === "🔴") hasRegression = true;
      if (sev === "🟡") hasWarning = true;

      lines.push(
        `| ${key} | ${formatValue(baseMetric.value, baseMetric.unit)} | ${formatValue(currMetric.value, currMetric.unit)} | ${change} | ${sev} |`
      );
    }

    // New metrics in current not in baseline
    for (const [key, currMetric] of Object.entries(currExp.metrics)) {
      if (!baseExp.metrics[key]) {
        lines.push(`| ${key} | — | ${formatValue(currMetric.value, currMetric.unit)} | new | ⚪ |`);
      }
    }

    lines.push(``);
  }

  // Summary
  lines.push(`## Summary`);
  lines.push(``);
  if (hasRegression) {
    lines.push(`🔴 **Regression detected** — one or more metrics changed by >10%.`);
  } else if (hasWarning) {
    lines.push(`🟡 **Warning** — one or more metrics changed by 5–10%.`);
  } else {
    lines.push(`✅ **No regression** — all metric changes are within the 5% info threshold.`);
  }
  lines.push(``);
  lines.push(`| Severity | Threshold |`);
  lines.push(`|----------|-----------|`);
  lines.push(`| ⚪ Info | < 5% change |`);
  lines.push(`| 🟡 Warning | 5–10% change |`);
  lines.push(`| 🔴 Regression | > 10% change |`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`*Generated by [cli-wrapper-monitor](https://github.com/copilot-autogent/cli-wrapper-monitor)*`);

  return lines.join("\n");
}

function main(): void {
  const { baseline, current, output } = parseArgs();

  if (baseline === current) {
    console.warn(
      "⚠️  Baseline and current point to the same file. Run a new snapshot first (npm run experiments), then pass --current path/to/new-snapshot.json."
    );
    console.warn(`   Baseline: ${baseline}`);
    console.warn(`   Current:  ${current}`);
    console.warn("");
    console.warn("Generating self-comparison report for reference...");
  }

  const baselineSnap = loadSnapshot(baseline);
  const currentSnap = loadSnapshot(current);

  const report = generateDiffReport(baselineSnap, currentSnap);

  if (output) {
    writeFileSync(resolve(output), report, "utf-8");
    console.log(`Diff report written to: ${output}`);
  } else {
    console.log(report);
  }
}

main();
