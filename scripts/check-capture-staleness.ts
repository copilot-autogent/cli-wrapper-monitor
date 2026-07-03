/**
 * Capture-miss alert: detect when scheduled capture cron jobs failed to run.
 *
 * Checks:
 *   1. Monthly baselines — must have a capture this calendar month.
 *      Grace period: alert starts the day after the expected capture day
 *      (MONTHLY_CAPTURE_DOM + MONTHLY_GRACE_DAYS = day 4 of each month).
 *   2. Weekly baselines  — must have a capture within the last
 *      WEEKLY_STALENESS_THRESHOLD_DAYS days (9, giving a 2-day grace buffer).
 *   3. Health log streak — FAILURE_STREAK_THRESHOLD consecutive errors triggers alert.
 *
 * Exits 0 (all fresh) or 1 (any stale). Prints a human-readable summary to stdout.
 * When stale and DISCORD_WEBHOOK_URL is set, fires sendWebhookWithRetry().
 *
 * Usage:
 *   npx tsx scripts/check-capture-staleness.ts
 *   npm run check-staleness
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readHealthLog,
  hasFailureStreak,
  consecutiveFailureCount,
  FAILURE_STREAK_THRESHOLD,
} from '../src/harness/capture-health.js';
import { sendWebhookWithRetry } from '../src/harness/webhook-utils.js';
import type { HealthLogEntry } from '../src/harness/capture-health.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default paths (relative to repo root)
const DEFAULT_MONTHLY_DIR = join(__dirname, '../baselines');
const DEFAULT_WEEKLY_DIR = join(__dirname, '../baselines/weekly');
const DEFAULT_HEALTH_LOG = join(__dirname, '../logs/capture-health.jsonl');

// Monthly capture runs on the 3rd of each month at 00:00 UTC.
// Grace period: +1 day, so alert starts on day 4 if no capture yet this month.
export const MONTHLY_CAPTURE_DOM = 3;
export const MONTHLY_GRACE_DAYS = 1;

// Weekly captures happen every Monday. Alert when the last capture is older
// than this many days (7-day cadence + 2-day grace buffer).
export const WEEKLY_STALENESS_THRESHOLD_DAYS = 9;

// Regex matching baseline filename dates: YYYY-MM-DD.json
const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:-.+)?\.json$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckResult {
  /** True if this dimension is stale and warrants an alert. */
  stale: boolean;
  /** ISO date (YYYY-MM-DD) of the most recent captured baseline, or null. */
  lastCaptured: string | null;
  /** Human-readable status message. */
  message: string;
}

export interface StalenessReport {
  monthly: CheckResult;
  weekly: CheckResult;
  healthStreak: CheckResult;
  /** True when any dimension is stale. */
  overallStale: boolean;
  /** ISO timestamp of when the check ran. */
  checkedAt: string;
}

/** Injectable dependencies (all optional — defaults use real FS / current time). */
export interface StalenessCheckDeps {
  now?: Date;
  monthlyDir?: string;
  weeklyDir?: string;
  healthLogPath?: string;
  readdirSyncFn?: (dir: string) => string[];
  existsSyncFn?: (path: string) => boolean;
  readHealthLogFn?: (path: string) => HealthLogEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the date string (YYYY-MM-DD) from a baseline filename, or null
 * when the filename does not match the expected pattern.
 */
export function extractDateFromFilename(filename: string): string | null {
  const m = DATE_FILE_RE.exec(filename);
  return m ? (m[1] ?? null) : null;
}

/**
 * Find the most recently captured date string (YYYY-MM-DD) in a directory
 * by scanning JSON filenames matching the YYYY-MM-DD pattern.
 * Returns null when the directory is absent or contains no matching files.
 */
export function findMostRecentBaseline(
  dir: string,
  deps: Pick<StalenessCheckDeps, 'readdirSyncFn' | 'existsSyncFn'> = {},
): string | null {
  const existsFn = deps.existsSyncFn ?? existsSync;
  const readdirFn = deps.readdirSyncFn ?? readdirSync;

  if (!existsFn(dir)) return null;

  let files: string[];
  try {
    files = readdirFn(dir);
  } catch {
    return null;
  }

  const dates = files
    .map((f) => extractDateFromFilename(f))
    .filter((d): d is string => d !== null)
    .sort();

  return dates.length > 0 ? (dates[dates.length - 1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * Check whether a monthly baseline was captured this calendar month.
 *
 * Alert condition: today is past the grace period (day >= MONTHLY_CAPTURE_DOM +
 * MONTHLY_GRACE_DAYS) AND no baseline exists for the current calendar month.
 */
export function checkMonthlyBaseline(deps: StalenessCheckDeps = {}): CheckResult {
  const now = deps.now ?? new Date();
  const dir = deps.monthlyDir ?? DEFAULT_MONTHLY_DIR;

  const lastDate = findMostRecentBaseline(dir, deps);

  const todayYear = now.getUTCFullYear();
  const todayMonth = now.getUTCMonth(); // 0-indexed
  const todayDom = now.getUTCDate();

  const alertThresholdDom = MONTHLY_CAPTURE_DOM + MONTHLY_GRACE_DAYS; // day 4

  const hasCaptureThisMonth =
    lastDate !== null &&
    (() => {
      const d = new Date(lastDate + 'T00:00:00Z');
      return d.getUTCFullYear() === todayYear && d.getUTCMonth() === todayMonth;
    })();

  const pastGracePeriod = todayDom >= alertThresholdDom;
  const stale = pastGracePeriod && !hasCaptureThisMonth;

  let message: string;
  if (!pastGracePeriod) {
    message = `✅ Monthly: capture not yet expected this month (day ${todayDom} < ${alertThresholdDom}).`;
  } else if (hasCaptureThisMonth) {
    message = `✅ Monthly: captured this month — last: ${lastDate}.`;
  } else {
    const lastSeen = lastDate ?? 'never';
    message = `⚠️  Monthly: no capture this month (${todayYear}-${String(todayMonth + 1).padStart(2, '0')}) — last seen: ${lastSeen}.`;
  }

  return { stale, lastCaptured: lastDate, message };
}

/**
 * Check whether a weekly baseline was captured within the staleness window.
 *
 * Alert condition: the most recent weekly baseline is older than
 * WEEKLY_STALENESS_THRESHOLD_DAYS days, or no weekly baselines exist.
 */
export function checkWeeklyBaseline(deps: StalenessCheckDeps = {}): CheckResult {
  const now = deps.now ?? new Date();
  const dir = deps.weeklyDir ?? DEFAULT_WEEKLY_DIR;

  const lastDate = findMostRecentBaseline(dir, deps);

  let stale: boolean;
  let message: string;

  if (lastDate === null) {
    stale = true;
    message = `⚠️  Weekly: no weekly baselines found in ${dir}.`;
  } else {
    const lastMs = new Date(lastDate + 'T00:00:00Z').getTime();
    const ageMs = now.getTime() - lastMs;
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

    stale = ageDays >= WEEKLY_STALENESS_THRESHOLD_DAYS;
    if (stale) {
      message = `⚠️  Weekly: last capture was ${ageDays} day(s) ago (${lastDate}) — threshold: ${WEEKLY_STALENESS_THRESHOLD_DAYS} days.`;
    } else {
      message = `✅ Weekly: captured ${ageDays} day(s) ago (${lastDate}).`;
    }
  }

  return { stale, lastCaptured: lastDate, message };
}

/**
 * Check the capture health log for a consecutive-failure streak.
 *
 * Alert condition: FAILURE_STREAK_THRESHOLD or more consecutive errors at the
 * tail of the health log (indicating all recent capture runs failed).
 */
export function checkHealthStreak(deps: StalenessCheckDeps = {}): CheckResult {
  const logPath = deps.healthLogPath ?? DEFAULT_HEALTH_LOG;
  const readFn = deps.readHealthLogFn ?? readHealthLog;

  const entries = readFn(logPath);
  const failCount = consecutiveFailureCount(entries);
  const stale = hasFailureStreak(entries);

  let message: string;
  if (entries.length === 0) {
    message = `✅ Health log: no entries yet.`;
  } else if (stale) {
    message = `⚠️  Health log: ${failCount} consecutive failure(s) (threshold: ${FAILURE_STREAK_THRESHOLD}).`;
  } else {
    message = `✅ Health log: ${failCount} trailing failure(s) — below alert threshold of ${FAILURE_STREAK_THRESHOLD}.`;
  }

  return { stale, lastCaptured: null, message };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run all three staleness checks and return a structured report.
 */
export function checkStaleness(deps: StalenessCheckDeps = {}): StalenessReport {
  const monthly = checkMonthlyBaseline(deps);
  const weekly = checkWeeklyBaseline(deps);
  const healthStreak = checkHealthStreak(deps);

  const overallStale = monthly.stale || weekly.stale || healthStreak.stale;
  const checkedAt = (deps.now ?? new Date()).toISOString();

  return { monthly, weekly, healthStreak, overallStale, checkedAt };
}

// ---------------------------------------------------------------------------
// Main entry point (runs when invoked as a script)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const report = checkStaleness();

  const lines = [
    `Capture-staleness check — ${report.checkedAt}`,
    report.monthly.message,
    report.weekly.message,
    report.healthStreak.message,
  ];

  for (const line of lines) {
    console.log(line);
  }

  if (report.overallStale) {
    const webhookUrl = process.env['DISCORD_WEBHOOK_URL'] ?? '';
    if (webhookUrl) {
      const staleItems: string[] = [];
      if (report.monthly.stale) {
        const last = report.monthly.lastCaptured ?? 'never';
        staleItems.push(`monthly capture overdue — last seen ${last}`);
      }
      if (report.weekly.stale) {
        const last = report.weekly.lastCaptured ?? 'never';
        staleItems.push(`weekly capture overdue — last seen ${last}`);
      }
      if (report.healthStreak.stale) {
        staleItems.push(`capture health log shows consecutive failures`);
      }

      const alertMsg = `⚠️ cli-wrapper-monitor: ${staleItems.join('; ')}.`;
      await sendWebhookWithRetry(webhookUrl, { content: alertMsg }, 'capture-staleness');
    }
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error('check-capture-staleness failed:', err);
    process.exit(1);
  });
}
