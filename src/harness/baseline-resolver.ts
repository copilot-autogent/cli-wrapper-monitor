import { readdirSync, existsSync, statSync } from "fs";
import { resolve, join } from "path";

export interface BaselineEntry {
  /** ISO date string, e.g. "2026-06-03" */
  date: string;
  /** Absolute path to the JSON file */
  path: string;
  type: "monthly" | "weekly";
}

const DATE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.json$/;

/** Returns true when the path exists and is a directory (not a file/symlink-to-file). */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch (err) {
    // Only treat "not found" as false; surface permission / I/O errors to the caller
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Returns true when the path exists and is a regular file. */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Lists all available baseline files from `baselinesDir/` (monthly) and
 * `baselinesDir/weekly/` (weekly), sorted by date descending.
 * When the same date exists in both directories, the monthly entry comes first.
 */
export function listAllBaselines(baselinesDir: string): BaselineEntry[] {
  const entries: BaselineEntry[] = [];
  const absDir = resolve(baselinesDir);

  if (isDirectory(absDir)) {
    for (const file of readdirSync(absDir, { encoding: "utf8" })) {
      const match = DATE_FILE_PATTERN.exec(file);
      if (!match) continue;
      const filePath = join(absDir, file);
      // Skip non-file entries (e.g. a sub-directory named 2026-06-03.json)
      if (!isFile(filePath)) continue;
      entries.push({ date: match[1], path: filePath, type: "monthly" });
    }
  }

  const weeklyDir = join(absDir, "weekly");
  if (isDirectory(weeklyDir)) {
    for (const file of readdirSync(weeklyDir, { encoding: "utf8" })) {
      const match = DATE_FILE_PATTERN.exec(file);
      if (!match) continue;
      const filePath = join(weeklyDir, file);
      if (!isFile(filePath)) continue;
      entries.push({ date: match[1], path: filePath, type: "weekly" });
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
  // Basic calendar-range validation to surface typos early
  const [, month, day] = date.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(
      `Invalid date "${date}" — month must be 01–12 and day must be 01–31`
    );
  }
  // Deeper check: feed through Date constructor to catch impossible combos (e.g. Feb 31)
  const d = new Date(`${date}T00:00:00Z`);
  if (isNaN(d.getTime()) || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) {
    throw new Error(
      `Invalid date "${date}" — not a valid calendar date (e.g. no Feb 30)`
    );
  }

  const absDir = resolve(baselinesDir);
  const monthlyPath = join(absDir, `${date}.json`);
  const weeklyPath = join(absDir, "weekly", `${date}.json`);

  if (existsSync(monthlyPath)) {
    if (!isFile(monthlyPath)) {
      throw new Error(`Baseline path for ${date} is not a regular file: ${monthlyPath}`);
    }
    if (existsSync(weeklyPath)) {
      // Ambiguous: exists in both — prefer monthly, document the tie-break
      process.stderr.write(
        `Note: baseline ${date} exists in both monthly and weekly; using monthly.\n`
      );
    }
    return monthlyPath;
  }

  if (existsSync(weeklyPath)) {
    if (!isFile(weeklyPath)) {
      throw new Error(`Baseline path for ${date} is not a regular file: ${weeklyPath}`);
    }
    return weeklyPath;
  }

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
