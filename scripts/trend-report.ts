#!/usr/bin/env -S npx tsx
/**
 * Generate a multi-baseline trend report from all historical baselines.
 *
 * Usage:
 *   npx tsx scripts/trend-report.ts [--output <path>]
 *
 * Reads all *.json files in baselines/ (excluding schema.json) in chronological order
 * and renders a flat summary table showing key metrics across captures, plus an
 * ASCII sparkline for systemPromptChars (when ≥3 data points are available).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, lstatSync } from "fs";
import { resolve, join } from "path";
import type { MetricSnapshot } from "../src/harness/types.js";
import { generateTrendReport } from "../src/harness/trend-report.js";
import { validateBaselineFile } from "../src/harness/validator.js";

/** Recursively collect *.json file paths under a directory tree. Symlinks are skipped. */
function collectJsonFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const st = lstatSync(full); // lstatSync does NOT follow symlinks (unlike statSync)
    if (st.isSymbolicLink()) continue; // skip symlinks to prevent traversal outside archive
    if (st.isDirectory()) {
      results.push(...collectJsonFiles(full));
    } else if (entry.endsWith(".json") && entry !== "schema.json" && entry !== "latest.json") {
      results.push(full);
    }
  }
  return results;
}

function loadAll(dir: string): MetricSnapshot[] {
  const absDir = resolve(dir);
  if (!existsSync(absDir)) {
    throw new Error(`Baselines directory not found: ${absDir}`);
  }

  // Collect files from the root baselines/ dir (exclude archive/ subdir entries)
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

  // Also validate and collect archived baselines (baselines/archive/**/*.json)
  const archiveDir = join(absDir, "archive");
  const archivedFilePaths = collectJsonFiles(archiveDir);
  for (const filePath of archivedFilePaths) {
    const result = validateBaselineFile(filePath);
    if (!result.valid) {
      anyInvalid = true;
      console.error(`Error: baseline integrity check failed for ${filePath}:`);
      for (const err of result.errors) {
        console.error(`  [${err.field}] ${err.message}`);
      }
    }
  }

  if (anyInvalid) {
    console.error("Aborting trend report: one or more baseline files are invalid.");
    process.exit(1);
  }

  const snapshots: MetricSnapshot[] = [
    ...files.map((f) => JSON.parse(readFileSync(join(absDir, f), "utf-8")) as MetricSnapshot),
    ...archivedFilePaths.map((p) => JSON.parse(readFileSync(p, "utf-8")) as MetricSnapshot),
  ];

  // Deduplicate by capturedAt in case a file exists in both root and archive.
  const seen = new Set<string>();
  const deduped = snapshots.filter((s) => {
    if (seen.has(s.capturedAt)) return false;
    seen.add(s.capturedAt);
    return true;
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
    const alreadyIncluded = deduped.some((s) => s.capturedAt === latest.capturedAt);
    if (!alreadyIncluded) {
      deduped.push(latest);
    }
  }

  return deduped.sort(
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
