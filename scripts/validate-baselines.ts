#!/usr/bin/env npx ts-node --esm
/**
 * Baseline integrity validator — standalone script.
 *
 * Scans all baselines/*.json files (including latest.json if present, excluding
 * schema.json) and validates each against the expected MetricSnapshot schema.
 *
 * Usage:
 *   npm run validate
 *   npx ts-node --esm scripts/validate-baselines.ts [--dir <path>]
 *
 * Options:
 *   --dir <path>   Directory to scan (default: baselines/)
 *
 * Exit codes:
 *   0  All files valid
 *   1  One or more files invalid (or directory not found)
 */

import { readdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
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

function main(): void {
  const { dir } = parseArgs();
  const absDir = resolve(dir);

  if (!existsSync(absDir)) {
    console.error(`Error: baselines directory not found: ${absDir}`);
    process.exit(1);
  }

  const files = readdirSync(absDir)
    .filter((f) => f.endsWith('.json') && f !== 'schema.json')
    .sort();

  if (files.length === 0) {
    console.log('No baseline files found to validate.');
    process.exit(0);
  }

  // Validate all files in a single pass; cache results to avoid double I/O
  const results: Array<{ file: string; result: ValidationResult }> = files.map((file) => ({
    file,
    result: validateBaselineFile(join(absDir, file)),
  }));

  let invalidCount = 0;
  for (const { file, result } of results) {
    if (result.valid) {
      console.log(`  ✓  ${file}`);
    } else {
      invalidCount++;
      console.error(`  ✗  ${file}`);
      for (const err of result.errors) {
        console.error(`       [${err.field}] ${err.message}`);
      }
    }
  }

  if (invalidCount === 0) {
    console.log(`\nAll ${files.length} baseline file${files.length === 1 ? '' : 's'} valid.`);
    process.exit(0);
  } else {
    console.error(`\n${invalidCount} of ${files.length} baseline file${files.length === 1 ? '' : 's'} invalid.`);
    process.exit(1);
  }
}

main();
