#!/usr/bin/env npx tsx
/**
 * Baseline integrity validator — standalone script.
 *
 * Scans all baselines/*.json files (including latest.json if present, excluding
 * schema.json) and validates each against the expected MetricSnapshot schema.
 * Also scans nested JSON files under baselines/archive/ when that directory exists.
 *
 * Usage:
 *   npm run validate
 *   npx tsx scripts/validate-baselines.ts [--dir <path>]
 *
 * Options:
 *   --dir <path>   Directory to scan (default: baselines/)
 *
 * Exit codes:
 *   0  All files valid
 *   1  One or more files invalid (or directory not found)
 */

import { readdirSync, existsSync, lstatSync } from 'fs';
import { resolve, join, relative } from 'path';
import { validateBaselineFile, type ValidationResult } from '../src/harness/validator.js';

interface CliArgs {
  dir: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let dir = 'baselines';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) dir = args[++i];
  }
  return { dir };
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
  const { dir } = parseArgs();
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

  // Archived baselines (baselines/archive/**/*.json)
  const archiveDir = join(absDir, 'archive');
  const archivedFiles = collectJsonFiles(archiveDir);

  const allFiles = [...rootFiles, ...archivedFiles];

  if (allFiles.length === 0) {
    console.log('No baseline files found to validate.');
    process.exit(0);
  }

  if (archivedFiles.length > 0) {
    console.log(`Validating ${rootFiles.length} active + ${archivedFiles.length} archived baseline file(s)...\n`);
  }

  // Validate all files in a single pass
  const results: Array<{ label: string; result: ValidationResult }> = allFiles.map((filePath) => ({
    label: relative(absDir, filePath),
    result: validateBaselineFile(filePath),
  }));

  let invalidCount = 0;
  for (const { label, result } of results) {
    if (result.valid) {
      console.log(`  ✓  ${label}`);
    } else {
      invalidCount++;
      console.error(`  ✗  ${label}`);
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
