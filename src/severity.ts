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
  /** Count of metric-change rows classified as BREAKING (>15% delta). */
  breaking: number;
  warning: number;
  info: number;
  /**
   * Count of structural BREAKING conditions (tool/hook count drop) that are
   * tracked separately from metric rows to avoid double-counting.
   */
  structuralBreakCount: number;
}

/**
 * Send a dedicated Discord webhook alert when one or more named tools are
 * removed between baselines.
 *
 * Reads DISCORD_WEBHOOK_URL from the environment. Silently no-ops when the
 * env var is absent or when removedTools is empty. Network errors and non-2xx
 * responses are caught and logged as warnings.
 */
export async function sendToolRemovedWebhook(
  removedTools: string[],
  dateA: string,
  dateB: string,
  ciRunUrl?: string,
): Promise<void> {
  const webhookUrl = process.env['DISCORD_WEBHOOK_URL'];
  if (!webhookUrl || !webhookUrl.trim()) return;
  if (removedTools.length === 0) return;

  const header =
    `🚨 **BREAKING: Tool removed** — ${dateA} vs ${dateB}` +
    (ciRunUrl ? `\n🔗 CI run: ${ciRunUrl}` : '');

  const DISCORD_MAX_CONTENT = 2000;
  // Build tool list with graceful truncation: if the full list overflows, keep
  // as many tool names as fit and append "…and N more" so the alert is never
  // silently incomplete. Tool names are sanitised to strip backticks/newlines
  // that could break out of Discord code spans.
  const sanitize = (name: string) => name.replace(/[`\n\r]/g, '_');
  const toolEntries = removedTools.map((t) => `\`${sanitize(t)}\``);
  let toolList = toolEntries.join(', ');
  const REMOVED_PREFIX = '\nRemoved: ';
  const headerAndPrefix = header.length + REMOVED_PREFIX.length;
  if (headerAndPrefix + toolList.length > DISCORD_MAX_CONTENT) {
    // Iteratively find how many entries fit, accounting for a computed suffix.
    let kept = 0;
    let running = 0;
    for (let i = 0; i < toolEntries.length; i++) {
      const remaining = toolEntries.length - (i + 1);
      const suffix = remaining > 0 ? `, …and ${remaining} more` : '';
      const add = (i > 0 ? 2 : 0) + toolEntries[i].length; // 2 for ", "
      const projectedTotal = headerAndPrefix + running + add + suffix.length;
      if (projectedTotal > DISCORD_MAX_CONTENT) break;
      running += add;
      kept++;
    }
    const remaining = toolEntries.length - kept;
    const sep = kept > 0 ? ', ' : '';
    toolList = toolEntries.slice(0, kept).join(', ') + (remaining > 0 ? `${sep}…and ${remaining} more` : '');
    // Final safety clamp in case header itself is pathologically long.
    const full = header + REMOVED_PREFIX + toolList;
    if (full.length > DISCORD_MAX_CONTENT) {
      toolList = '';
    }
  }
  const content = header + REMOVED_PREFIX + toolList;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(
        `⚠️  Discord webhook returned ${res.status} — tool-removed alert may not have been delivered.`,
      );
    }
  } catch (err) {
    console.warn(`⚠️  Discord webhook failed (tool-removed notification skipped): ${String(err)}`);
  }
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

  const { breaking, warning, info, structuralBreakCount } = summary;
  // Only post to Discord when there is something actionable — pure INFO-only
  // runs (all changes within 5%) would create noisy green pings on every CI run.
  if (breaking === 0 && warning === 0 && structuralBreakCount === 0) return;

  const icon = breaking > 0 || structuralBreakCount > 0 ? '🔴' : warning > 0 ? '🟡' : '🟢';
  const summaryLine = [
    breaking > 0 ? `${breaking} BREAKING` : null,
    structuralBreakCount > 0 ? `${structuralBreakCount} structural BREAKING` : null,
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
