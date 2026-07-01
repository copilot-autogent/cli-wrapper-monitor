#!/usr/bin/env npx ts-node --esm
/**
 * Generate a multi-baseline trend report from all historical baselines.
 *
 * Usage:
 *   npx ts-node --esm scripts/trend-report.ts [--output <path>]
 *
 * Reads all *.json files in baselines/ (excluding schema.json) in chronological order
 * and renders a flat summary table showing key metrics across captures, plus an
 * ASCII sparkline for systemPromptChars (when ≥3 data points are available).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { resolve, join } from "path";
import type { MetricSnapshot } from "../src/harness/types.js";
import { generateTrendReport } from "../src/harness/trend-report.js";
import { validateBaselineFile } from "../src/harness/validator.js";

function loadAll(dir: string): MetricSnapshot[] {
  const absDir = resolve(dir);
  if (!existsSync(absDir)) {
    throw new Error(`Baselines directory not found: ${absDir}`);
  }

  const files = readdirSync(absDir)
    .filter((f) => f.endsWith(".json") && f !== "schema.json" && f !== "latest.json")
    .sort(); // lexicographic = chronological for ISO-date filenames

  // Pre-validate all baseline files before loading
  let anyInvalid = false;
  for (const f of files) {
    const filePath = join(absDir, f);
    const result = validateBaselineFile(filePath);
    if (!result.valid) {
      anyInvalid = true;
      console.error(`Error: baseline integrity check failed for ${f}:`);
      for (const err of result.errors) {
        console.error(`  [${err.field}] ${err.message}`);
      }
    }
  }
  if (anyInvalid) {
    console.error("Aborting trend report: one or more baseline files are invalid.");
    process.exit(1);
  }

  const snapshots: MetricSnapshot[] = files.map((f) => {
    const content = readFileSync(join(absDir, f), "utf-8");
    return JSON.parse(content) as MetricSnapshot;
  });

  // Also include latest.json if it exists and isn't already represented
  const latestPath = join(absDir, "latest.json");
  if (existsSync(latestPath)) {
    const latestResult = validateBaselineFile(latestPath);
    if (!latestResult.valid) {
      console.error("Error: baseline integrity check failed for latest.json:");
      for (const err of latestResult.errors) {
        console.error(`  [${err.field}] ${err.message}`);
      }
      console.error("Aborting trend report: latest.json is invalid.");
      process.exit(1);
    }
    const latest = JSON.parse(readFileSync(latestPath, "utf-8")) as MetricSnapshot;
    const alreadyIncluded = snapshots.some((s) => s.capturedAt === latest.capturedAt);
    if (!alreadyIncluded) {
      snapshots.push(latest);
    }
  }

  return snapshots.sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime()
  );
}

function main(): void {
  const args = process.argv.slice(2);
  let output: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) output = args[++i];
  }

  const snapshots = loadAll("baselines");
  const report = generateTrendReport(snapshots);

  if (output) {
    writeFileSync(resolve(output), report, "utf-8");
    console.log(`Trend report written to: ${output}`);
  } else {
    console.log(report);
  }
}

main();
