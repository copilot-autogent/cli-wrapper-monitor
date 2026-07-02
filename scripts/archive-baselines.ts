#!/usr/bin/env npx ts-node --esm
/**
 * Baseline retention policy: archive baselines older than N calendar months.
 *
 * Moves baseline JSON files from baselines/ → baselines/archive/YYYY/ based on
 * the date parsed from the filename (YYYY-MM-DD prefix). Files that cannot be
 * date-parsed are reported but left in place.
 *
 * Usage:
 *   npm run archive
 *   npx ts-node --esm scripts/archive-baselines.ts [options]
 *
 * Options:
 *   --older-than-months N   Archive files older than N calendar months (default: 6)
 *   --baselines-dir <path>  Baselines root directory (default: baselines/)
 *   --dry-run               Print what would be moved without touching files
 *
 * Exit codes:
 *   0  Success (including "nothing to archive")
 *   1  Error (directory not found, bad argument)
 */

import { readdirSync, mkdirSync, renameSync, existsSync } from 'fs';
import { resolve, join } from 'path';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  olderThanMonths: number;
  baselinesDir: string;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let olderThanMonths = 6;
  let baselinesDir = 'baselines';
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--older-than-months' && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (isNaN(n) || n < 1) {
        console.error('Error: --older-than-months must be a positive integer');
        process.exit(1);
      }
      olderThanMonths = n;
    } else if (args[i] === '--baselines-dir' && args[i + 1]) {
      baselinesDir = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  return { olderThanMonths, baselinesDir, dryRun };
}

// ---------------------------------------------------------------------------
// Core logic (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parse a YYYY-MM-DD date from the start of a filename.
 * Returns null when the filename does not begin with a valid date.
 */
export function parseDateFromFilename(filename: string): Date | null {
  const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Use local midnight for comparison with cutoff (also local midnight).
  return new Date(year, month - 1, day);
}

/**
 * Compute the cutoff date: files with a date strictly before this are archived.
 * Subtracts `olderThanMonths` calendar months from `now` and normalises to midnight.
 */
export function computeCutoffDate(now: Date, olderThanMonths: number): Date {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - olderThanMonths);
  cutoff.setHours(0, 0, 0, 0);
  return cutoff;
}

export interface ArchiveResult {
  /** Files moved (or that would be moved in dry-run) to archive */
  archived: string[];
  /** Files retained in baselines/ */
  kept: string[];
  /** Files skipped because their names don't parse as a date */
  skipped: string[];
  /** Absolute path to the archive base directory */
  archiveDir: string;
}

/**
 * Archive baseline files from `baselinesDir` that are older than `olderThanMonths`.
 *
 * Idempotent: a file already absent from `baselinesDir` (moved on a previous run)
 * will simply not appear in the listing and will not be processed again.
 *
 * @param baselinesDir  Path to the baselines root (default: baselines/)
 * @param olderThanMonths  Retention window in calendar months (default: 6)
 * @param dryRun  When true, no filesystem mutations are performed
 * @param now  Reference "current" date (injectable for testing; default: new Date())
 */
export function archiveBaselines(
  baselinesDir: string,
  olderThanMonths: number,
  dryRun: boolean,
  now: Date = new Date()
): ArchiveResult {
  const absDir = resolve(baselinesDir);
  if (!existsSync(absDir)) {
    throw new Error(`Baselines directory not found: ${absDir}`);
  }

  const cutoff = computeCutoffDate(now, olderThanMonths);
  const archiveBaseDir = join(absDir, 'archive');

  // List only date-named JSON files in the root baselines/ directory.
  // schema.json and latest.json are always kept.
  const files = readdirSync(absDir)
    .filter((f) => f.endsWith('.json') && f !== 'schema.json' && f !== 'latest.json')
    .sort();

  const archived: string[] = [];
  const kept: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const fileDate = parseDateFromFilename(file);
    if (!fileDate) {
      skipped.push(file);
      continue;
    }

    if (fileDate < cutoff) {
      const year = fileDate.getFullYear().toString();
      const destDir = join(archiveBaseDir, year);
      const srcPath = join(absDir, file);
      const destPath = join(destDir, file);

      if (!dryRun) {
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }
        // Guard against duplicate runs where the source was already removed
        if (existsSync(srcPath) && !existsSync(destPath)) {
          renameSync(srcPath, destPath);
        }
      }
      archived.push(file);
    } else {
      kept.push(file);
    }
  }

  return { archived, kept, skipped, archiveDir: archiveBaseDir };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): void {
  const { olderThanMonths, baselinesDir, dryRun } = parseArgs();

  if (dryRun) {
    console.log(
      `[dry-run] Would archive baselines older than ${olderThanMonths} months from ${baselinesDir}/`
    );
  }

  let result: ArchiveResult;
  try {
    result = archiveBaselines(baselinesDir, olderThanMonths, dryRun);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const { archived, kept, skipped } = result;

  if (archived.length === 0) {
    console.log(`No baselines older than ${olderThanMonths} months to archive.`);
  } else {
    const dates = archived.map((f) => f.slice(0, 10)); // YYYY-MM-DD prefix
    const minDate = dates[0];
    const maxDate = dates[dates.length - 1];
    const action = dryRun ? 'Would archive' : 'Archived';
    console.log(
      `${action} ${archived.length} baseline${archived.length === 1 ? '' : 's'} ` +
        `(${minDate} to ${maxDate}). ` +
        `${kept.length} baseline${kept.length === 1 ? '' : 's'} remain in ${baselinesDir}/.`
    );
  }

  if (skipped.length > 0) {
    console.warn(
      `Skipped ${skipped.length} file(s) with non-date filenames: ${skipped.join(', ')}`
    );
  }
}

main();
