import { readdirSync, existsSync } from "fs";
import { resolve, join } from "path";

export interface BaselineEntry {
  /** ISO date string, e.g. "2026-06-03" */
  date: string;
  /** Absolute path to the JSON file */
  path: string;
  type: "monthly" | "weekly";
}

const DATE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * Lists all available baseline files from `baselinesDir/` (monthly) and
 * `baselinesDir/weekly/` (weekly), sorted by date descending.
 * When the same date exists in both directories, the monthly entry comes first.
 */
export function listAllBaselines(baselinesDir: string): BaselineEntry[] {
  const entries: BaselineEntry[] = [];
  const absDir = resolve(baselinesDir);

  if (existsSync(absDir)) {
    for (const file of readdirSync(absDir)) {
      const match = DATE_FILE_PATTERN.exec(file);
      if (match) {
        entries.push({ date: match[1], path: join(absDir, file), type: "monthly" });
      }
    }
  }

  const weeklyDir = join(absDir, "weekly");
  if (existsSync(weeklyDir)) {
    for (const file of readdirSync(weeklyDir)) {
      const match = DATE_FILE_PATTERN.exec(file);
      if (match) {
        entries.push({ date: match[1], path: join(weeklyDir, file), type: "weekly" });
      }
    }
  }

  // Sort descending by date; for the same date prefer monthly over weekly
  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.type === b.type) return 0;
    return a.type === "monthly" ? -1 : 1;
  });

  return entries;
}

/**
 * Resolves a date string (YYYY-MM-DD) to an absolute baseline file path.
 *
 * Search order:
 *   1. `baselinesDir/<date>.json`   (monthly — preferred when ambiguous)
 *   2. `baselinesDir/weekly/<date>.json`
 *
 * Throws a user-friendly error when the date is not found.
 */
export function resolveBaselineByDate(date: string, baselinesDir: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      `Invalid date format "${date}" — expected YYYY-MM-DD (e.g. 2026-06-03)`
    );
  }

  const absDir = resolve(baselinesDir);
  const monthlyPath = join(absDir, `${date}.json`);
  const weeklyPath = join(absDir, "weekly", `${date}.json`);

  if (existsSync(monthlyPath)) {
    if (existsSync(weeklyPath)) {
      // Ambiguous: exists in both — prefer monthly, document the tie-break
      process.stderr.write(
        `Note: baseline ${date} exists in both monthly and weekly; using monthly.\n`
      );
    }
    return monthlyPath;
  }

  if (existsSync(weeklyPath)) return weeklyPath;

  throw new Error(
    `No baseline found for ${date}; run \`npm run compare -- --list\` to see available dates`
  );
}

/**
 * Returns the most recent entry from a sorted (descending) list, or null when
 * the list is empty.
 */
export function findLatestBaseline(entries: BaselineEntry[]): BaselineEntry | null {
  return entries.length > 0 ? entries[0] : null;
}

/**
 * Returns the most recent entry whose date is strictly before `currentDate`,
 * or null if no such entry exists.
 *
 * Assumes `entries` is sorted descending (as returned by `listAllBaselines`).
 */
export function findPreviousBaseline(
  currentDate: string,
  entries: BaselineEntry[]
): BaselineEntry | null {
  for (const entry of entries) {
    if (entry.date < currentDate) return entry;
  }
  return null;
}
