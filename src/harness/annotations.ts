/**
 * Baseline annotation loader.
 *
 * Annotations are optional per-date markdown files stored in a `notes/` directory.
 * File naming convention: `notes/YYYY-MM-DD.md`
 * Missing files → undefined (no annotation, no error).
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/** Maximum annotation length for the "short" display in trend report tables. */
export const ANNOTATION_TRUNCATE_LEN = 50;

/**
 * Truncate annotation text to `maxLen` characters, appending "…" when truncated.
 * Pure function — no I/O.
 */
export function truncateAnnotation(text: string, maxLen = ANNOTATION_TRUNCATE_LEN): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + "…";
}

/**
 * Load a single annotation for the given ISO date (YYYY-MM-DD).
 * Returns the file content (trimmed) if the file exists, or undefined if it doesn't.
 * Never throws for missing files — uses try/catch to avoid TOCTOU race.
 * ENOENT and ENOTDIR are both treated as "no annotation" (no error).
 */
export function loadAnnotation(notesDir: string, date: string): string | undefined {
  const filePath = join(notesDir, `${date}.md`);
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    // ENOENT = file doesn't exist; ENOTDIR = path component isn't a directory
    const code = err && typeof err === "object" ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
  return content.trim() || undefined;
}

/**
 * Load all annotations from a `notes/` directory.
 * Returns a `Record<YYYY-MM-DD, content>` for every file matching the naming convention.
 * Returns an empty object when the directory doesn't exist or can't be read (not an error).
 */
export function loadAnnotations(notesDir: string): Record<string, string> {
  const result: Record<string, string> = {};

  const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
  let entries: string[];
  try {
    entries = readdirSync(notesDir).sort(); // sort for deterministic output
  } catch {
    // Directory doesn't exist or isn't readable — treat as empty annotations
    return result;
  }

  for (const entry of entries) {
    const m = DATE_RE.exec(entry);
    if (!m) continue;
    const date = m[1];
    // Read directly instead of delegating to loadAnnotation to avoid double stat
    try {
      const content = readFileSync(join(notesDir, entry), "utf-8").trim();
      if (content) result[date] = content;
    } catch {
      // Skip unreadable files silently
    }
  }

  return result;
}
