import type { MetricSnapshot } from './types.js';
import { sendWebhookWithRetry } from './webhook-utils.js';

/** Percentage change threshold that triggers a size alert */
export const SIZE_ALERT_THRESHOLD_PCT = 10;

export interface SizeMetricDelta {
  key: string;
  label: string;
  current: number;
  unit: string;
  previous: number | null;
  /** current - previous; null when no prior baseline */
  deltaAbsolute: number | null;
  /** percentage change; positive = growth; null when no prior baseline */
  deltaPct: number | null;
  /** true when |deltaPct| > SIZE_ALERT_THRESHOLD_PCT */
  alert: boolean;
}

export interface SizeDeltaResult {
  metrics: SizeMetricDelta[];
  /** true when any tracked metric exceeds the alert threshold */
  hasAlert: boolean;
  /** capturedAt of the comparison baseline, or null if none */
  previousCapturedAt: string | null;
}

const TRACKED_METRICS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'systemPromptChars', label: 'System prompt chars' },
  { key: 'systemPromptTokensEstimated', label: 'Tokens (est.)' },
  { key: 'toolCount', label: 'Tool count' },
];

/**
 * Compute a delta summary for the key size metrics in the context-tax
 * experiment.
 *
 * @param current - the newly captured snapshot
 * @param latest  - the prior baseline snapshot; pass null when none exists
 */
export function computeSizeDelta(
  current: MetricSnapshot,
  latest: MetricSnapshot | null,
): SizeDeltaResult {
  const currentExp = current.experiments['context-tax'];
  const latestExp = latest?.experiments['context-tax'] ?? null;

  // If the experiment failed, return a zero-delta result to avoid spurious
  // SIZE ALERTs caused by missing metrics (e.g. all values → 0 → -100% delta).
  if (currentExp?.error) {
    return {
      metrics: TRACKED_METRICS.map(({ key, label }) => ({
        key,
        label,
        current: 0,
        unit: '',
        previous: null,
        deltaAbsolute: null,
        deltaPct: null,
        alert: false,
      })),
      hasAlert: false,
      previousCapturedAt: latest?.capturedAt ?? null,
    };
  }

  const metrics: SizeMetricDelta[] = TRACKED_METRICS.map(({ key, label }) => {
    const currentMetric = currentExp?.metrics[key];
    const latestMetric = latestExp?.metrics[key] ?? null;

    const currentVal = currentMetric?.value ?? 0;
    const unit = currentMetric?.unit ?? '';
    const prevVal = latestMetric !== null ? latestMetric.value : null;

    const deltaAbsolute = prevVal !== null ? currentVal - prevVal : null;

    // deltaPct is null when prevVal is 0 (division by zero) or there is no
    // prior baseline.  Note: this is intentionally strict (> not >=) per the
    // issue spec which says ">10% change".  diff.ts uses >= for its own
    // regression threshold — the two are separate output channels.
    const deltaPct =
      deltaAbsolute !== null && prevVal !== null && prevVal !== 0
        ? (deltaAbsolute / prevVal) * 100
        : null;

    // 0 → N is treated as always alerting: we can't compute a %, but any
    // growth from zero is a notable change worth investigating.
    const alert =
      (deltaPct !== null && Math.abs(deltaPct) > SIZE_ALERT_THRESHOLD_PCT) ||
      (prevVal === 0 && deltaAbsolute !== null && currentVal > 0);

    return {
      key,
      label,
      current: currentVal,
      unit,
      previous: prevVal,
      deltaAbsolute,
      deltaPct,
      alert,
    };
  });

  return {
    metrics,
    hasAlert: metrics.some((m) => m.alert),
    previousCapturedAt: latest?.capturedAt ?? null,
  };
}

/**
 * Format a concise size-delta summary table for console output.
 * Shows current value, previous value, and delta with percentage.
 * Emits a SIZE ALERT block when any metric exceeds the threshold.
 */
export function formatSizeDeltaTable(result: SizeDeltaResult): string {
  const lines: string[] = [];

  const vsLabel = result.previousCapturedAt
    ? `vs ${result.previousCapturedAt.slice(0, 10)}`
    : 'no prior baseline';
  lines.push(`Size summary (${vsLabel}):`);

  const C1 = 28; // metric label column width
  const C2 = 20; // current column width
  const C3 = 20; // previous column width

  lines.push(
    `  ${'Metric'.padEnd(C1)}  ${'Current'.padEnd(C2)}  ${'Previous'.padEnd(C3)}  Since last`,
  );
  lines.push(
    `  ${'─'.repeat(C1)}  ${'─'.repeat(C2)}  ${'─'.repeat(C3)}  ${'─'.repeat(22)}`,
  );

  for (const m of result.metrics) {
    const current = `${m.current.toLocaleString('en-US')} ${m.unit}`.padEnd(C2);
    const previous = (
      m.previous !== null
        ? `${m.previous.toLocaleString('en-US')} ${m.unit}`
        : '—'
    ).padEnd(C3);

    let sinceLast = '—';
    if (m.deltaAbsolute !== null) {
      const sign = m.deltaAbsolute >= 0 ? '+' : '';
      if (m.deltaPct !== null) {
        sinceLast = `${sign}${m.deltaAbsolute.toLocaleString('en-US')} (${sign}${m.deltaPct.toFixed(1)}%)`;
      } else {
        // prevVal was 0 — percentage undefined; show absolute change
        sinceLast = `${sign}${m.deltaAbsolute.toLocaleString('en-US')} (∞%)`;
      }
      if (m.alert) sinceLast += ' ⚠️';
    }

    lines.push(
      `  ${m.label.padEnd(C1)}  ${current}  ${previous}  ${sinceLast}`,
    );
  }
  lines.push('');

  if (result.hasAlert) {
    lines.push(
      '  ┌──────────────────────────────────────────────────────────┐',
      '  │  ⚠️  SIZE ALERT: a key metric changed by >10% since last  │',
      '  │  Investigate drift before the next scheduled baseline     │',
      '  └──────────────────────────────────────────────────────────┘',
    );
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Send a Discord webhook notification when a SIZE ALERT fires.
 *
 * Reads DISCORD_WEBHOOK_URL from the environment. When the env var is absent
 * or empty the function returns immediately — no CI failure is produced.
 * Network errors and non-2xx responses are caught and logged as warnings so
 * a flaky Discord endpoint never causes a CI failure.
 *
 * @param result     - the SizeDeltaResult that triggered the alert
 * @param ciRunUrl   - optional link to the CI run (from GITHUB_SERVER_URL + GITHUB_RUN_ID)
 */
export async function sendSizeAlertWebhook(
  result: SizeDeltaResult,
  ciRunUrl?: string,
): Promise<void> {
  if (!result.hasAlert) return;

  const webhookUrl = process.env['DISCORD_WEBHOOK_URL'];
  if (!webhookUrl || !webhookUrl.trim()) return;

  const alertingMetrics = result.metrics.filter((m) => m.alert);

  const metricLines = alertingMetrics.map((m) => {
    // Use deltaPct to derive sign so the prefix always matches the direction
    // shown in the percentage string. Fall back to deltaAbsolute for the ∞%
    // (prevVal=0) case where deltaPct is null but delta is always positive.
    const sign = (m.deltaPct !== null ? m.deltaPct >= 0 : (m.deltaAbsolute ?? 0) >= 0) ? '+' : '';
    const pctStr =
      m.deltaPct !== null
        ? `${sign}${m.deltaPct.toFixed(1)}%`
        : '∞%';
    const prevStr =
      m.previous !== null
        ? `${m.previous.toLocaleString('en-US')} ${m.unit}`
        : '—';
    const currStr = `${m.current.toLocaleString('en-US')} ${m.unit}`;
    return `• **${m.label}**: ${prevStr} → ${currStr} (${pctStr})`;
  });

  const ciLine = ciRunUrl ? `\n🔗 CI run: ${ciRunUrl}` : '';

  const DISCORD_MAX_CONTENT = 2000;
  let content =
    `⚠️ **SIZE ALERT** — a key CLI wrapper metric changed by >${SIZE_ALERT_THRESHOLD_PCT}%\n` +
    metricLines.join('\n') +
    ciLine;
  if (content.length > DISCORD_MAX_CONTENT) {
    content = content.slice(0, DISCORD_MAX_CONTENT - 1) + '…';
  }

  await sendWebhookWithRetry(webhookUrl, { content }, 'size-alert');
}
