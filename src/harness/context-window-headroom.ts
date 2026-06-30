/**
 * Context window headroom tracking.
 *
 * For every model in the pool, computes how much of the context window is
 * consumed by the system prompt and flags models that are dangerously full.
 *
 * Thresholds:
 *   promptFillPct > 90%  → 'overflow-risk'  🚨
 *   promptFillPct > 50%  → 'high-fill'      ⚠️
 *   contextWindow === 0  → 'unknown'        ❓  (SDK did not report window size)
 *   otherwise            → 'ok'             ✅
 *
 * HEADROOM ALERT fires when any *enabled* model newly crosses the >50% threshold
 * compared to the previous baseline snapshot.
 */
import type { ModelPool, ContextWindowHeadroomEntry, HeadroomStatus, MetricSnapshot } from './types.js';
import { sendWebhookWithRetry } from './webhook-utils.js';

/** Fill threshold that triggers a HIGH FILL warning */
export const HEADROOM_HIGH_FILL_PCT = 50;
/** Fill threshold that triggers an OVERFLOW RISK warning */
export const HEADROOM_OVERFLOW_RISK_PCT = 90;

/**
 * Compute context window headroom for every model in the pool.
 *
 * @param modelPool           - Pool captured via listModels()
 * @param systemPromptTokens  - Token count of the current system prompt
 */
export function computeContextWindowHeadroom(
  modelPool: ModelPool,
  systemPromptTokens: number,
): ContextWindowHeadroomEntry[] {
  return modelPool.models.map((model) => {
    const cw = model.contextWindow;

    // contextWindow === 0 (or invalid: negative, NaN, Infinity) means the SDK
    // did not report the window size. We cannot compute headroom, and it would
    // be misleading to show the model as 'ok' with negative headroomTokens.
    // Treat as 'unknown'.
    if (!(cw > 0) || !isFinite(cw)) {
      return {
        modelId: model.id,
        state: model.state,
        contextWindow: cw,
        systemPromptTokens,
        headroomTokens: cw > 0 ? cw - systemPromptTokens : -systemPromptTokens,
        promptFillPct: 0,
        status: 'unknown' as HeadroomStatus,
      };
    }

    const headroomTokens = cw - systemPromptTokens;
    // Use raw percentage for threshold comparisons; round to 2 decimal places
    // for display so boundary cases (e.g. 90.04% vs 89.96%) are visibly
    // distinguishable even though both round to "90.0%" at 1 decimal place.
    const rawFillPct = (systemPromptTokens / cw) * 100;
    const promptFillPct = Math.round(rawFillPct * 100) / 100;

    let status: HeadroomStatus;
    if (rawFillPct > HEADROOM_OVERFLOW_RISK_PCT) {
      status = 'overflow-risk';
    } else if (rawFillPct > HEADROOM_HIGH_FILL_PCT) {
      status = 'high-fill';
    } else {
      status = 'ok';
    }

    return {
      modelId: model.id,
      state: model.state,
      contextWindow: cw,
      systemPromptTokens,
      headroomTokens,
      promptFillPct,
      status,
    };
  });
}

const STATUS_LABEL: Record<HeadroomStatus, string> = {
  ok: '✅ OK',
  'high-fill': '⚠️  HIGH FILL',
  'overflow-risk': '🚨 OVERFLOW RISK',
  unknown: '❓ UNKNOWN',
};

/**
 * Format a headroom table for console output.
 * Mirrors the layout from the issue spec.
 */
export function formatHeadroomTable(entries: ContextWindowHeadroomEntry[]): string {
  if (entries.length === 0) return '';

  const lines: string[] = [];
  lines.push('Context window headroom:');

  const C1 = 28; // Model column
  const C2 = 16; // Context window column
  const C3 = 15; // Prompt tokens column
  const C4 = 8;  // Fill % column

  lines.push(
    `  ${'Model'.padEnd(C1)}  ${'Context Window'.padEnd(C2)}  ${'Prompt Tokens'.padEnd(C3)}  ${'Fill %'.padEnd(C4)}  Status`,
  );
  lines.push(
    `  ${'─'.repeat(C1)}  ${'─'.repeat(C2)}  ${'─'.repeat(C3)}  ${'─'.repeat(C4)}  ${'─'.repeat(16)}`,
  );

  // Sort: overflow-risk first, then high-fill, then ok; within tier, alphabetical
  const sorted = [...entries].sort((a, b) => {
    const tier = (e: ContextWindowHeadroomEntry) =>
      e.status === 'overflow-risk' ? 0 : e.status === 'high-fill' ? 1 : 2;
    const td = tier(a) - tier(b);
    if (td !== 0) return td;
    return a.modelId.localeCompare(b.modelId);
  });

  for (const e of sorted) {
    const model = e.modelId.padEnd(C1);
    const cw = e.contextWindow.toLocaleString('en-US').padEnd(C2);
    const tokens = e.systemPromptTokens.toLocaleString('en-US').padEnd(C3);
    const fill = `${e.promptFillPct.toFixed(2)}%`.padEnd(C4);
    const status = STATUS_LABEL[e.status];
    lines.push(`  ${model}  ${cw}  ${tokens}  ${fill}  ${status}`);
  }
  lines.push('');

  // Summary banner if any model needs attention
  const highFill = entries.filter((e) => e.status === 'high-fill');
  const overflowRisk = entries.filter((e) => e.status === 'overflow-risk');
  if (overflowRisk.length > 0) {
    lines.push(
      '  ┌──────────────────────────────────────────────────────────────┐',
      `  │  🚨 OVERFLOW RISK: ${overflowRisk.length} model(s) are >90% full`.padEnd(66) + '│',
      '  │  System prompt may be truncated for these models              │',
      '  └──────────────────────────────────────────────────────────────┘',
    );
    lines.push('');
  } else if (highFill.length > 0) {
    lines.push(
      '  ┌──────────────────────────────────────────────────────────────┐',
      `  │  ⚠️  HIGH FILL: ${highFill.length} model(s) are >50% full`.padEnd(66) + '│',
      '  │  Little headroom for conversation history on these models     │',
      '  └──────────────────────────────────────────────────────────────┘',
    );
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Return *enabled* models that newly crossed the >50% fill threshold compared
 * to a prior snapshot.
 *
 * "Newly crossed" means the model was NOT flagged (status was 'ok' or 'unknown')
 * in the previous snapshot (or didn't exist there), but IS now flagged
 * ('high-fill' or 'overflow-risk').
 *
 * When `previous` is `undefined` (no prior headroom data exists, e.g. first
 * run after rollout or the prior baseline pre-dates this feature), returns an
 * empty array.  This avoids a spam burst where all currently-flagged models
 * appear as "new crossings" after the feature is first deployed.
 *
 * When `previous` is a defined array (even empty), newly-added pool models
 * that are already flagged ARE included — they represent a genuine transition
 * into a dangerous state.
 *
 * Only enabled models (state === 'enabled') are included: disabled and
 * unconfigured models have no operational impact and would produce noisy alerts.
 */
export function detectFirstTimeCrossings(
  current: ContextWindowHeadroomEntry[],
  previous: ContextWindowHeadroomEntry[] | undefined,
): ContextWindowHeadroomEntry[] {
  // No prior headroom data → first run after rollout; do not alert.
  if (previous === undefined) return [];

  const prevMap = new Map<string, HeadroomStatus>(
    previous.map((e) => [e.modelId, e.status]),
  );

  return current.filter((e) => {
    // Only alert for enabled models to avoid noise from disabled/unconfigured entries.
    if (e.state !== 'enabled') return false;
    const isFlagged = e.status === 'high-fill' || e.status === 'overflow-risk';
    if (!isFlagged) return false;
    const prevStatus = prevMap.get(e.modelId);
    // Newly crossed = was 'ok'/'unknown' before OR is a new model in the pool.
    return prevStatus === undefined || prevStatus === 'ok' || prevStatus === 'unknown';
  });
}

/**
 * Extract system prompt token count from a MetricSnapshot.
 * Returns 0 when the context-tax experiment is absent or errored.
 */
export function extractSystemPromptTokens(snapshot: MetricSnapshot): number {
  const exp = snapshot.experiments['context-tax'];
  if (!exp || exp.error) return 0;
  return exp.metrics['systemPromptTokensEstimated']?.value ?? 0;
}

/**
 * Send a Discord webhook notification when models newly cross the >50%
 * fill threshold.
 *
 * Reads DISCORD_WEBHOOK_URL from the environment.  When the env var is
 * absent or the crossings list is empty the function returns immediately —
 * network errors are caught and logged as warnings so a flaky Discord
 * endpoint never causes a CI failure.
 *
 * @param crossings  - Models that newly crossed the 50% threshold
 * @param ciRunUrl   - Optional link to the CI run
 */
export async function sendHeadroomAlertWebhook(
  crossings: ContextWindowHeadroomEntry[],
  ciRunUrl?: string,
): Promise<void> {
  if (crossings.length === 0) return;

  const webhookUrl = process.env['DISCORD_WEBHOOK_URL'];
  if (!webhookUrl || !webhookUrl.trim()) return;

  const modelLines = crossings.map((e) => {
    const label = e.status === 'overflow-risk' ? '🚨 OVERFLOW RISK' : '⚠️  HIGH FILL';
    return `• **${e.modelId}**: ${e.contextWindow.toLocaleString('en-US')} ctx / ${e.systemPromptTokens.toLocaleString('en-US')} prompt = **${e.promptFillPct.toFixed(2)}%** ${label}`;
  });

  const ciLine = ciRunUrl ? `\n🔗 CI run: ${ciRunUrl}` : '';

  const DISCORD_MAX_CONTENT = 2000;
  let content =
    `⚠️ **HEADROOM ALERT** — system prompt now exceeds 50% of context window for ${crossings.length} model(s)\n` +
    modelLines.join('\n') +
    ciLine;
  // Truncate on Unicode code-point boundaries to avoid splitting surrogate pairs
  // (emoji like 🚨/⚠️ are represented as surrogate pairs in UTF-16 strings).
  if ([...content].length > DISCORD_MAX_CONTENT) {
    content = [...content].slice(0, DISCORD_MAX_CONTENT - 1).join('') + '…';
  }

  try {
    await sendWebhookWithRetry(webhookUrl, { content }, 'headroom-alert');
  } catch {
    // sendWebhookWithRetry handles all error logging
  }
}
