/**
 * Regression severity classification for baseline comparisons.
 *
 * Thresholds are exposed as tunable constants. Adjust after real baseline
 * data from July 2026 establishes reference points (see issue #16).
 */

/** Metric change > this threshold (%) is classified as BREAKING. */
export const BREAKING_THRESHOLD_PCT = 15;

/** Metric change >= this threshold (%) is classified as WARNING. */
export const WARNING_THRESHOLD_PCT = 5;

/** Severity tiers for a baseline delta. */
export type SeverityLevel = 'BREAKING' | 'WARNING' | 'INFO';

/** Visual emoji for each severity tier. */
export const SEVERITY_EMOJI: Record<SeverityLevel, string> = {
  BREAKING: '🔴',
  WARNING: '🟡',
  INFO: '🟢',
};

/**
 * Classify an absolute percentage change into a severity tier.
 *
 * @param absPct - absolute value of the percentage change (always ≥ 0)
 */
export function classifyDeltaPct(absPct: number): SeverityLevel {
  if (absPct > BREAKING_THRESHOLD_PCT) return 'BREAKING';
  if (absPct >= WARNING_THRESHOLD_PCT) return 'WARNING';
  return 'INFO';
}

/** Counts of each severity tier across all delta rows. */
export interface SeveritySummary {
  breaking: number;
  warning: number;
  info: number;
}

/**
 * Send a Discord webhook with a severity summary line, e.g.
 * "1 BREAKING, 2 WARNING, 3 INFO".
 *
 * Reads DISCORD_WEBHOOK_URL from the environment. When the env var is absent
 * or empty the function returns immediately. Network errors and non-2xx
 * responses are caught and logged as warnings so a flaky Discord endpoint
 * never causes a CI failure.
 */
export async function sendSeveritySummaryWebhook(
  summary: SeveritySummary,
  dateA: string,
  dateB: string,
  ciRunUrl?: string,
): Promise<void> {
  const webhookUrl = process.env['DISCORD_WEBHOOK_URL'];
  if (!webhookUrl || !webhookUrl.trim()) return;

  const { breaking, warning, info } = summary;
  if (breaking === 0 && warning === 0 && info === 0) return;

  const icon = breaking > 0 ? '🔴' : warning > 0 ? '🟡' : '🟢';
  const summaryLine = [
    breaking > 0 ? `${breaking} BREAKING` : null,
    warning > 0 ? `${warning} WARNING` : null,
    info > 0 ? `${info} INFO` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const ciLine = ciRunUrl ? `\n🔗 CI run: ${ciRunUrl}` : '';

  const DISCORD_MAX_CONTENT = 2000;
  let content =
    `${icon} **Baseline comparison** — ${dateA} vs ${dateB}\n` +
    `Severity: **${summaryLine}**` +
    ciLine;
  if (content.length > DISCORD_MAX_CONTENT) {
    content = content.slice(0, DISCORD_MAX_CONTENT - 1) + '…';
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(
        `⚠️  Discord webhook returned ${res.status} — severity summary may not have been delivered.`,
      );
    }
  } catch (err) {
    console.warn(`⚠️  Discord webhook failed (notification skipped): ${String(err)}`);
  }
}
