#!/usr/bin/env npx ts-node --esm
/**
 * Baseline integrity validator — standalone script.
 *
 * Scans all baselines/*.json files (excluding schema.json and latest.json
 * which is a symlink to the most recent capture) and validates each against
 * the expected MetricSnapshot schema.
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
import { validateBaselineFile } from '../src/harness/validator.js';

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
    .filter((f) => f.endsWith('.json') && f !== 'schema.json' && f !== 'latest.json')
    .sort();

  if (files.length === 0) {
    console.log('No baseline files found to validate.');
    process.exit(0);
  }

  let allValid = true;

  for (const file of files) {
    const filePath = join(absDir, file);
    const result = validateBaselineFile(filePath);

    if (result.valid) {
      console.log(`  ✓  ${file}`);
    } else {
      allValid = false;
      console.error(`  ✗  ${file}`);
      for (const err of result.errors) {
        console.error(`       [${err.field}] ${err.message}`);
      }
    }
  }

  if (allValid) {
    console.log(`\nAll ${files.length} baseline file${files.length === 1 ? '' : 's'} valid.`);
    process.exit(0);
  } else {
    const invalidCount = files.filter((f) => {
      const result = validateBaselineFile(join(absDir, f));
      return !result.valid;
    }).length;
    console.error(`\n${invalidCount} of ${files.length} baseline file${files.length === 1 ? '' : 's'} invalid.`);
    process.exit(1);
  }
}

main();
