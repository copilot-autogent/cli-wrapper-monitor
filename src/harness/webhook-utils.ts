import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Maximum number of delivery attempts (initial + retries). */
const MAX_ATTEMPTS = 3;

/** Base delay in milliseconds for exponential backoff (1s → 2s → 4s). */
const BASE_DELAY_MS = 1000;

/** Path to the dead-letter log file. */
const DEAD_LETTER_LOG = resolve('logs', 'webhook-failures.jsonl');

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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Append a structured failure entry to the dead-letter log.
 * Creates `logs/` if it does not exist. Errors are swallowed to avoid
 * masking the original webhook failure.
 *
 * @returns true if the entry was written, false if a FS error occurred.
 */
function writeDeadLetter(entry: DeadLetterEntry): boolean {
  try {
    mkdirSync(resolve('logs'), { recursive: true });
    appendFileSync(DEAD_LETTER_LOG, JSON.stringify(entry) + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a Discord webhook POST with exponential-backoff retries.
 *
 * - Retries up to {@link MAX_ATTEMPTS} times (1 s → 2 s delays between attempts).
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

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) return; // Delivered successfully

      lastError = `HTTP ${res.status}`;
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
    attempts: MAX_ATTEMPTS,
  };

  const logged = writeDeadLetter(entry);
  const logSuffix = logged
    ? ` Failure logged to ${DEAD_LETTER_LOG}.`
    : ' Dead-letter write also failed (disk full or permissions error).';

  console.error(
    `❌ Discord webhook delivery failed after ${MAX_ATTEMPTS} attempts` +
      ` [${alertType}]: ${lastError}.${logSuffix}`,
  );
}
