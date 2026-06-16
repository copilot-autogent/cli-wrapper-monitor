import type { MetricSnapshot } from './types.js';

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

  const metrics: SizeMetricDelta[] = TRACKED_METRICS.map(({ key, label }) => {
    const currentMetric = currentExp?.metrics[key];
    const latestMetric = latestExp?.metrics[key] ?? null;

    const currentVal = currentMetric?.value ?? 0;
    const unit = currentMetric?.unit ?? '';
    const prevVal = latestMetric !== null ? latestMetric.value : null;

    const deltaAbsolute = prevVal !== null ? currentVal - prevVal : null;
    const deltaPct =
      deltaAbsolute !== null && prevVal !== null && prevVal !== 0
        ? (deltaAbsolute / prevVal) * 100
        : null;

    const alert =
      deltaPct !== null && Math.abs(deltaPct) > SIZE_ALERT_THRESHOLD_PCT;

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
    const current = `${m.current.toLocaleString()} ${m.unit}`.padEnd(C2);
    const previous = (
      m.previous !== null
        ? `${m.previous.toLocaleString()} ${m.unit}`
        : '—'
    ).padEnd(C3);

    let sinceLast = '—';
    if (m.deltaAbsolute !== null && m.deltaPct !== null) {
      const sign = m.deltaAbsolute >= 0 ? '+' : '';
      sinceLast = `${sign}${m.deltaAbsolute.toLocaleString()} (${sign}${m.deltaPct.toFixed(1)}%)`;
      if (m.alert) sinceLast += ' ⚠️';
    }

    lines.push(
      `  ${m.label.padEnd(C1)}  ${current}  ${previous}  ${sinceLast}`,
    );
  }
  lines.push('');

  if (result.hasAlert) {
    lines.push(
      '  ┌────────────────────────────────────────────────────────┐',
      '  │  ⚠️  SIZE ALERT: a key metric grew >10% since last run  │',
      '  │  Investigate growth before the next scheduled baseline  │',
      '  └────────────────────────────────────────────────────────┘',
    );
    lines.push('');
  }

  return lines.join('\n');
}
