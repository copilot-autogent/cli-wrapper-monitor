#!/usr/bin/env -S npx tsx
/**
 * Baseline retention policy: archive baselines older than N calendar months.
 *
 * Moves baseline JSON files from baselines/ → baselines/archive/YYYY/ based on
 * the date parsed from the filename (YYYY-MM-DD prefix). Files that cannot be
 * date-parsed are reported but left in place.
 *
 * Usage:
 *   npm run archive
 *   npx tsx scripts/archive-baselines.ts [options]
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

import { readdirSync, mkdirSync, renameSync, existsSync, lstatSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';

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
    if (args[i] === '--older-than-months') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) {
        console.error('Error: --older-than-months requires a value');
        process.exit(1);
      }
      const n = parseInt(args[++i], 10);
      if (isNaN(n) || n < 1) {
        console.error('Error: --older-than-months must be a positive integer');
        process.exit(1);
      }
      olderThanMonths = n;
    } else if (args[i] === '--baselines-dir') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) {
        console.error('Error: --baselines-dir requires a value');
        process.exit(1);
      }
      baselinesDir = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else {
      console.error(`Error: unknown flag '${args[i]}'`);
      process.exit(1);
    }
  }

  return { olderThanMonths, baselinesDir, dryRun };
}

// ---------------------------------------------------------------------------
// Core logic (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parse a YYYY-MM-DD date from the start of a filename.
 * Accepts `YYYY-MM-DD.json` and `YYYY-MM-DD-suffix.json` forms.
 * Returns null when the filename does not match or the date is invalid
 * (e.g. February 30 — JS would silently roll over without this check).
 */
export function parseDateFromFilename(filename: string): Date | null {
  // Require date immediately followed by either '-' (suffix) or end of base name.
  const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})(?=-|\.json$)/);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Round-trip validation: rejects impossible dates like Feb 30 that JS would silently roll over.
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return d;
}

/**
 * Compute the cutoff date: files with a date strictly before this are archived.
 * Subtracts `olderThanMonths` calendar months from `now` and normalises to midnight.
 *
 * Month-end clamping: if `now` is on the 31st and the target month has fewer days,
 * the result is clamped to the last day of that month (e.g. Aug 31 − 6 months = Feb 28).
 * This prevents JS's silent date roll-over (Feb 31 → Mar 3) from shifting the boundary.
 */
export function computeCutoffDate(now: Date, olderThanMonths: number): Date {
  const targetYear = now.getFullYear();
  const targetMonth = now.getMonth() - olderThanMonths;
  // Construct as 1st of the target month first (avoids roll-over when building the Date)
  const first = new Date(targetYear, targetMonth, 1);
  // Last day of the target month (day 0 of the next month)
  const lastDayOfMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const day = Math.min(now.getDate(), lastDayOfMonth);
  return new Date(first.getFullYear(), first.getMonth(), day, 0, 0, 0, 0);
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

  // List only regular (non-symlink) JSON files in the root baselines/ directory.
  // schema.json and latest.json are always kept.
  const files = readdirSync(absDir)
    .filter((f) => {
      if (!f.endsWith('.json') || f === 'schema.json' || f === 'latest.json') return false;
      const st = lstatSync(join(absDir, f));
      return st.isFile(); // exclude symlinks and directories named *.json
    })
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

      if (dryRun) {
        // In dry-run, check whether the archive destination already exists to mirror real behavior.
        if (!existsSync(destPath)) {
          archived.push(file);
        } else {
          console.warn(
            `Warning: skipping ${file} — destination already exists at ${destPath}.`
          );
          skipped.push(file);
        }
      } else {
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }
        if (existsSync(srcPath) && !existsSync(destPath)) {
          renameSync(srcPath, destPath);
          archived.push(file);
        } else if (existsSync(srcPath) && existsSync(destPath)) {
          // Collision: both src and dest exist (e.g. partial manual copy). Report in skipped.
          console.warn(
            `Warning: skipping ${file} — destination already exists at ${destPath}. ` +
              `Remove one copy manually to resolve.`
          );
          skipped.push(file);
        }
        // If src is already gone (moved by a prior run) it won't appear in readdirSync;
        // this branch is unreachable in normal use.
      }
    } else {
      kept.push(file);
    }
  }

  return { archived, kept, skipped, archiveDir: archiveBaseDir };
}

// ---------------------------------------------------------------------------
// Entry point — only run when this file is executed directly (not imported)
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

// Only run when this file is the direct entry-point (not imported by tests or other scripts).
const _thisFile = fileURLToPath(import.meta.url);
const _entryFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (_thisFile === _entryFile) {
  main();
}
