#!/usr/bin/env -S npx tsx
/**
 * Baseline integrity validator — standalone script.
 *
 * Scans all baselines/*.json files (including latest.json if present, excluding
 * schema.json) and validates each against the expected MetricSnapshot schema.
 * Also scans nested JSON files under baselines/archive/ when that directory exists.
 * Also scans baselines/weekly/ and baselines/weekly/archive/ when they exist.
 *
 * Usage:
 *   npm run validate
 *   npx tsx scripts/validate-baselines.ts [--dir <path>] [--weekly-dir <path>]
 *
 * Options:
 *   --dir <path>         Monthly baselines directory to scan (default: from capture.config.json or baselines/)
 *   --weekly-dir <path>  Weekly baselines directory to scan (default: from capture.config.json or baselines/weekly/)
 *   --skip-weekly        Skip scanning weekly baselines
 *
 * Exit codes:
 *   0  All files valid
 *   1  One or more files invalid (or directory not found)
 */

import { readdirSync, existsSync, lstatSync } from 'fs';
import { resolve, join, relative } from 'path';
import { validateBaselineFile, type ValidationResult } from '../src/harness/validator.js';
import { loadCaptureConfig } from './capture-config.js';

interface CliArgs {
  dir: string;
  weeklyDir: string;
  skipWeekly: boolean;
}

function parseArgs(): CliArgs {
  const cfg = loadCaptureConfig();
  const args = process.argv.slice(2);
  let dir = cfg.monthlyBaselinesDir;
  let weeklyDir = cfg.weeklyBaselinesDir;
  let skipWeekly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) dir = args[++i];
    else if (args[i] === '--weekly-dir' && args[i + 1]) weeklyDir = args[++i];
    else if (args[i] === '--skip-weekly') skipWeekly = true;
  }
  return { dir, weeklyDir, skipWeekly };
}

/** Recursively collect all *.json file paths under a directory tree. Symlinks are skipped. */
function collectJsonFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const st = lstatSync(full); // lstatSync does NOT follow symlinks (unlike statSync)
    if (st.isSymbolicLink()) continue; // skip symlinks to prevent traversal outside archive
    if (st.isDirectory()) {
      results.push(...collectJsonFiles(full));
    } else if (entry.endsWith('.json') && entry !== 'schema.json' && entry !== 'latest.json') {
      results.push(full);
    }
  }
  return results;
}

function main(): void {
  const { dir, weeklyDir, skipWeekly } = parseArgs();
  const absDir = resolve(dir);

  if (!existsSync(absDir)) {
    console.error(`Error: baselines directory not found: ${absDir}`);
    process.exit(1);
  }

  // Root baselines files (non-recursive: skip archive/ subdirectory here)
  const rootFiles = readdirSync(absDir)
    .filter((f) => f.endsWith('.json') && f !== 'schema.json')
    .sort()
    .map((f) => join(absDir, f));

  // Archived monthly baselines (baselines/archive/**/*.json)
  const archiveDir = join(absDir, 'archive');
  const archivedFiles = collectJsonFiles(archiveDir);

  // Weekly baselines (baselines/weekly/**/*.json) — includes archive subdir
  const weeklyFiles: string[] = [];
  if (!skipWeekly) {
    const absWeeklyDir = resolve(weeklyDir);
    // Collect weekly root files (excluding schema.json / latest.json, non-recursive for root)
    if (existsSync(absWeeklyDir)) {
      const weeklyRoot = readdirSync(absWeeklyDir)
        .filter((f) => {
          if (!f.endsWith('.json') || f === 'schema.json' || f === 'latest.json') return false;
          const st = lstatSync(join(absWeeklyDir, f));
          return st.isFile();
        })
        .sort()
        .map((f) => join(absWeeklyDir, f));
      weeklyFiles.push(...weeklyRoot);

      // Archived weekly baselines (baselines/weekly/archive/**/*.json)
      const weeklyArchiveDir = join(absWeeklyDir, 'archive');
      weeklyFiles.push(...collectJsonFiles(weeklyArchiveDir));
    }
  }

  const allFiles = [...rootFiles, ...archivedFiles, ...weeklyFiles];

  if (allFiles.length === 0) {
    console.log('No baseline files found to validate.');
    process.exit(0);
  }

  const parts: string[] = [];
  if (rootFiles.length > 0) parts.push(`${rootFiles.length} active monthly`);
  if (archivedFiles.length > 0) parts.push(`${archivedFiles.length} archived monthly`);
  if (weeklyFiles.length > 0) parts.push(`${weeklyFiles.length} weekly`);
  if (parts.length > 1) {
    console.log(`Validating ${parts.join(' + ')} baseline file(s)...\n`);
  }

  // Validate all files in a single pass
  const results: Array<{ label: string; result: ValidationResult }> = allFiles.map((filePath) => ({
    label: relative(absDir, filePath),
    result: validateBaselineFile(filePath),
  }));

  let invalidCount = 0;
  for (const { label, result } of results) {
    if (result.valid) {
      console.log(`  \u2713  ${label}`);
    } else {
      invalidCount++;
      console.error(`  \u2717  ${label}`);
      for (const err of result.errors) {
        console.error(`       [${err.field}] ${err.message}`);
      }
    }
  }

  const total = allFiles.length;
  if (invalidCount === 0) {
    console.log(`\nAll ${total} baseline file${total === 1 ? '' : 's'} valid.`);
    process.exit(0);
  } else {
    console.error(`\n${invalidCount} of ${total} baseline file${total === 1 ? '' : 's'} invalid.`);
    process.exit(1);
  }
}

main();
