/**
 * Capture health log — append-only JSONL tracking of each capture attempt.
 *
 * Provides:
 *   - appendHealthLog()       write one entry after a capture attempt
 *   - readHealthLog()         read all entries from the log
 *   - consecutiveFailureCount()  count trailing consecutive errors
 *   - hasFailureStreak()      detect streaks of 3+ consecutive errors
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Number of consecutive failures that triggers a streak warning. */
export const FAILURE_STREAK_THRESHOLD = 3;

export interface HealthLogEntry {
  capturedAt: string;
  status: 'success' | 'error';
  durationMs: number;
  baselinesDir: string;
  /** Path to the written snapshot; present on success only. */
  snapshotPath?: string;
  /** Classifier of the thrown error; present on error only. */
  errorType?: string;
  /** Human-readable error message; present on error only. */
  errorMessage?: string;
}

/**
 * Append one capture-health entry to the JSONL log file.
 * Creates the parent directory if it does not yet exist.
 * Errors during the write are swallowed so that a log failure never masks
 * an otherwise successful capture.
 */
export function appendHealthLog(logPath: string, entry: HealthLogEntry): void {
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Best-effort — never let logging failures abort a capture run.
  }
}

/**
 * Read and parse all entries from the JSONL health log.
 * Returns an empty array when the file does not exist or cannot be read.
 * Malformed individual lines are skipped rather than aborting the parse,
 * so one corrupt entry does not erase history or suppress streak detection.
 */
export function readHealthLog(logPath: string): HealthLogEntry[] {
  if (!existsSync(logPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf-8');
  } catch {
    return [];
  }
  const entries: HealthLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'status' in parsed &&
        ((parsed as Record<string, unknown>)['status'] === 'success' ||
          (parsed as Record<string, unknown>)['status'] === 'error')
      ) {
        entries.push(parsed as HealthLogEntry);
      }
    } catch {
      // Skip malformed lines — best-effort reads.
    }
  }
  return entries;
}

/**
 * Return the count of trailing consecutive error entries.
 *
 * Returns 0 if the log is empty or the last entry was a success.
 */
export function consecutiveFailureCount(entries: HealthLogEntry[]): number {
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.status === 'error') {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Return true when the last FAILURE_STREAK_THRESHOLD entries are all errors.
 */
export function hasFailureStreak(entries: HealthLogEntry[]): boolean {
  return consecutiveFailureCount(entries) >= FAILURE_STREAK_THRESHOLD;
}
