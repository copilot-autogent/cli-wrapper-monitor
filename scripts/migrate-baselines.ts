#!/usr/bin/env -S npx tsx
/**
 * Migrate all baseline JSON files to the current schema version.
 *
 * Usage:
 *   npm run migrate                    # dry-run (default): show plan, write nothing
 *   npm run migrate -- --dry-run       # explicit dry-run
 *   npm run migrate -- --write         # apply migrations in-place
 *   npm run migrate -- --write --quiet # apply without verbose per-file output
 *
 * Scans:
 *   baselines/          (date-stamped + latest.json)
 *   baselines/weekly/   (if present)
 *   baselines/archive/  (if present)
 *
 * Safety:
 *   - Idempotent: baselines already at current version are skipped.
 *   - Validates each result after migrating; aborts that file on error.
 *   - --write mode rewrites the file in-place (same path, formatted JSON).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, CURRENT_SCHEMA_VERSION, effectiveSchemaVersion } from '../src/harness/baseline-migrator.js';
import { validateSnapshot } from '../src/harness/validator.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  write: boolean;
  quiet: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  return {
    write: args.includes('--write'),
    quiet: args.includes('--quiet'),
  };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_DIRS = [
  join(REPO_ROOT, 'baselines'),
  join(REPO_ROOT, 'baselines', 'weekly'),
  join(REPO_ROOT, 'baselines', 'archive'),
];

function collectBaselineFiles(): string[] {
  const files: string[] = [];
  for (const dir of BASELINE_DIRS) {
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      // Skip schema.json (not a baseline snapshot)
      if (entry === 'schema.json') continue;
      const full = join(dir, entry);
      if (statSync(full).isFile()) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

// ---------------------------------------------------------------------------
// Per-file migration
// ---------------------------------------------------------------------------

interface FileMigrationResult {
  path: string;
  fromVersion: string;
  toVersion: string;
  status: 'already-current' | 'migrated' | 'written' | 'error';
  error?: string;
}

function processFile(filePath: string, write: boolean): FileMigrationResult {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { path: filePath, fromVersion: '?', toVersion: CURRENT_SCHEMA_VERSION, status: 'error', error: `Cannot read: ${String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { path: filePath, fromVersion: '?', toVersion: CURRENT_SCHEMA_VERSION, status: 'error', error: `Invalid JSON: ${String(err)}` };
  }

  const fromVersion = effectiveSchemaVersion(parsed as Record<string, unknown>);

  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    return { path: filePath, fromVersion, toVersion: CURRENT_SCHEMA_VERSION, status: 'already-current' };
  }

  let migrated: ReturnType<typeof migrate>;
  try {
    migrated = migrate(parsed, CURRENT_SCHEMA_VERSION);
  } catch (err) {
    return { path: filePath, fromVersion, toVersion: CURRENT_SCHEMA_VERSION, status: 'error', error: `Migration failed: ${String(err)}` };
  }

  // Validate the result
  const validation = validateSnapshot(migrated);
  if (!validation.valid) {
    const errMsgs = validation.errors.map((e) => `[${e.field}] ${e.message}`).join('; ');
    return { path: filePath, fromVersion, toVersion: CURRENT_SCHEMA_VERSION, status: 'error', error: `Post-migration validation failed: ${errMsgs}` };
  }

  if (write) {
    try {
      writeFileSync(filePath, JSON.stringify(migrated, null, 2) + '\n', 'utf-8');
    } catch (err) {
      return { path: filePath, fromVersion, toVersion: CURRENT_SCHEMA_VERSION, status: 'error', error: `Write failed: ${String(err)}` };
    }
    return { path: filePath, fromVersion, toVersion: CURRENT_SCHEMA_VERSION, status: 'written' };
  }

  return { path: filePath, fromVersion, toVersion: CURRENT_SCHEMA_VERSION, status: 'migrated' };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const { write, quiet } = parseArgs();

  const label = write ? 'WRITE MODE' : 'DRY-RUN MODE';
  console.log(`\n🔄  migrate-baselines — ${label}`);
  console.log(`   Target schema version: ${CURRENT_SCHEMA_VERSION}`);
  if (!write) {
    console.log('   Pass --write to apply changes in-place.');
  }
  console.log('');

  const files = collectBaselineFiles();
  if (files.length === 0) {
    console.log('No baseline JSON files found.');
    return;
  }

  const results: FileMigrationResult[] = [];
  for (const file of files) {
    const result = processFile(file, write);
    results.push(result);
    if (!quiet || result.status === 'error') {
      const rel = file.replace(REPO_ROOT + '/', '');
      switch (result.status) {
        case 'already-current':
          console.log(`  ✓ (current)   ${rel}  [${result.fromVersion}]`);
          break;
        case 'migrated':
          console.log(`  → (would migrate) ${rel}  [${result.fromVersion} → ${result.toVersion}]`);
          break;
        case 'written':
          console.log(`  ✅ (migrated)  ${rel}  [${result.fromVersion} → ${result.toVersion}]`);
          break;
        case 'error':
          console.log(`  ❌ (error)     ${rel}: ${result.error}`);
          break;
      }
    }
  }

  console.log('');

  const current = results.filter((r) => r.status === 'already-current').length;
  const toMigrate = results.filter((r) => r.status === 'migrated' || r.status === 'written').length;
  const errors = results.filter((r) => r.status === 'error').length;

  console.log(`Summary:`);
  console.log(`  Already at ${CURRENT_SCHEMA_VERSION}: ${current}`);
  console.log(`  ${write ? 'Migrated' : 'Would migrate'}: ${toMigrate}`);
  if (errors > 0) {
    console.log(`  Errors: ${errors}`);
  }
  console.log('');

  if (!write && toMigrate > 0) {
    console.log(`Run with --write to apply these migrations.`);
    console.log('');
  }

  if (errors > 0) {
    process.exit(1);
  }
}

main();
