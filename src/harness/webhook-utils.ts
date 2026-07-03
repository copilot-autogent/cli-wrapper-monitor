import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Maximum number of delivery attempts (initial + retries). */
export const MAX_ATTEMPTS = 3;

/** Severity level for a bundled webhook alert. */
export type AlertSeverity = 'BREAKING' | 'WARNING' | 'INFO';

/** A pre-formatted alert ready to be sent or bundled with others. */
export interface WebhookAlert {
  /** Pre-formatted Discord content string for this alert. */
  content: string;
  /** Human-readable label used in dead-letter entries (e.g. 'tool-removed'). */
  alertType: string;
  /** Severity level used for header determination when bundling. */
  severity: AlertSeverity;
}

/** Base delay in milliseconds for exponential backoff (1 s → 2 s). */
const BASE_DELAY_MS = 1000;

/**
 * HTTP status codes that are permanent client errors and should NOT be retried.
 * Server errors (5xx) and rate-limits (429) and timeouts (408) are retryable.
 */
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 405, 410, 413, 415, 422]);

/** Path to the dead-letter log file. Resolved lazily (at call time) to respect CWD. */
function deadLetterLogPath(): string {
  return resolve('logs', 'webhook-failures.jsonl');
}

/** Payload structure sent to Discord. */
export interface WebhookPayload {
  content: string;
}

/** Entry written to the dead-letter log on final failure. */
interface DeadLetterEntry {
  timestamp: string;
  alertType: string;
  payload: WebhookPayload;
  error: string;
  attempts: number;
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Append a structured failure entry to the dead-letter log.
 * Creates `logs/` if it does not exist. Errors are swallowed to avoid
 * masking the original webhook failure.
 *
 * @returns true if the entry was written, false if a FS error occurred.
 */
function writeDeadLetter(entry: DeadLetterEntry): boolean {
  const logPath = deadLetterLogPath();
  try {
    mkdirSync(resolve('logs'), { recursive: true });
    appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a Discord webhook POST with exponential-backoff retries.
 *
 * - Retries up to {@link MAX_ATTEMPTS} times (1 s → 2 s delays between attempts).
 * - Short-circuits immediately on permanent client errors (400/401/403/404/405/410).
 * - On final failure writes a structured entry to `logs/webhook-failures.jsonl`.
 * - Logs `console.error` on final failure so CI run logs surface the problem.
 *
 * @param webhookUrl  - The Discord webhook URL (already validated non-empty by caller).
 * @param payload     - JSON payload to POST.
 * @param alertType   - Human-readable label used in dead-letter entries (e.g. "size-alert").
 */
export async function sendWebhookWithRetry(
  webhookUrl: string,
  payload: WebhookPayload,
  alertType: string,
): Promise<void> {
  let lastError = '';
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsMade = attempt;
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) return; // Delivered successfully

      lastError = `HTTP ${res.status}`;

      // Permanent client error — retrying won't help
      if (NON_RETRYABLE_STATUS.has(res.status)) break;
    } catch (err) {
      lastError = String(err);
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  // All attempts exhausted — write dead-letter entry and surface via console.error
  const entry: DeadLetterEntry = {
    timestamp: new Date().toISOString(),
    alertType,
    payload,
    error: lastError,
    attempts: attemptsMade,
  };

  const logPath = deadLetterLogPath();
  const logged = writeDeadLetter(entry);
  const logSuffix = logged
    ? ` Failure logged to ${logPath}.`
    : ' Dead-letter write also failed (disk full or permissions error).';

  console.error(
    `❌ Discord webhook delivery failed after ${attemptsMade} attempt(s)` +
      ` [${alertType}]: ${lastError}.${logSuffix}`,
  );
}

/**
 * Merge multiple alerts into a single Discord webhook call to reduce notification noise.
 *
 * - Empty list → no-op (no fetch called).
 * - Single alert → passed through directly with its original `alertType`, content clamped to 2000 chars.
 * - Multiple alerts → sections joined by a separator under a single header line
 *   that reflects the highest severity across all alerts (BREAKING > WARNING > INFO).
 *   `issueCount` (optional) controls the "N issues detected" label in the header; when omitted,
 *   `alerts.length` is used. Pass a lower count when some alerts are meta/summary entries that
 *   should not be counted as distinct issues.
 *
 * The combined content is clamped to Discord's 2000-character limit.
 *
 * @param alerts      - Pre-built alert objects to send (or merge).
 * @param webhookUrl  - Optional URL override; falls back to `DISCORD_WEBHOOK_URL` env var.
 * @param issueCount  - Optional override for the "N issues detected" count in the bundle header.
 */
export async function bundleWebhooks(
  alerts: WebhookAlert[],
  webhookUrl?: string,
  issueCount?: number,
): Promise<void> {
  const url = webhookUrl ?? process.env['DISCORD_WEBHOOK_URL'];
  if (!url || !url.trim()) return;
  if (alerts.length === 0) return;

  const DISCORD_MAX_CONTENT = 2000;

  if (alerts.length === 1) {
    const content =
      alerts[0].content.length > DISCORD_MAX_CONTENT
        ? alerts[0].content.slice(0, DISCORD_MAX_CONTENT - 1) + '…'
        : alerts[0].content;
    await sendWebhookWithRetry(url, { content }, alerts[0].alertType);
    return;
  }

  // Determine highest severity: BREAKING > WARNING > INFO
  const SEVERITY_ORDER: AlertSeverity[] = ['BREAKING', 'WARNING', 'INFO'];
  const highestSeverity = SEVERITY_ORDER.find((s) => alerts.some((a) => a.severity === s)) ?? 'INFO';
  const emoji = highestSeverity === 'BREAKING' ? '🚨' : highestSeverity === 'WARNING' ? '⚠️' : '🟢';
  const count = issueCount ?? alerts.length;

  const header = `${emoji} **${highestSeverity} (${count} issues detected)**`;
  const sections = alerts.map((a) => a.content).join('\n\n―――――――――――――――\n\n');
  const full = `${header}\n\n${sections}`;

  const content =
    full.length > DISCORD_MAX_CONTENT ? full.slice(0, DISCORD_MAX_CONTENT - 1) + '…' : full;

  await sendWebhookWithRetry(url, { content }, 'bundled-alert');
}
