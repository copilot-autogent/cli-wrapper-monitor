import type { DiffReport, MetricChange, MetricSnapshot, ModelPool, ModelPoolChange } from './types.js';

const WARNING_THRESHOLD_PCT = 5;
const REGRESSION_THRESHOLD_PCT = 10;

/** Diff two model pools, returning structured change records. */
export function diffModelPool(
  baseline: ModelPool | undefined,
  current: ModelPool | undefined,
): ModelPoolChange[] {
  if (!baseline || !current) return [];

  const changes: ModelPoolChange[] = [];
  const baseMap = new Map(baseline.models.map((m) => [m.id, m]));
  const currMap = new Map(current.models.map((m) => [m.id, m]));

  // Removed models
  for (const [id, before] of baseMap) {
    if (!currMap.has(id)) {
      changes.push({ type: 'removed', modelId: id, before });
    }
  }

  // Added models and changed models
  for (const [id, after] of currMap) {
    const before = baseMap.get(id);
    if (!before) {
      changes.push({ type: 'added', modelId: id, after });
      continue;
    }
    if (before.state !== after.state) {
      changes.push({ type: 'state_changed', modelId: id, before, after });
    }
    if (before.contextWindow !== after.contextWindow) {
      changes.push({ type: 'context_window_changed', modelId: id, before, after });
    }
  }

  return changes;
}

/**
 * Compare two snapshots and return a diff report.
 * Only metrics present in both snapshots are compared.
 */
export function diffSnapshots(
  baseline: MetricSnapshot,
  current: MetricSnapshot,
): DiffReport {
  const changes: MetricChange[] = [];

  for (const [expName, currentResult] of Object.entries(current.experiments)) {
    const baselineResult = baseline.experiments[expName];
    if (!baselineResult) continue;

    for (const [metricName, currentMetric] of Object.entries(
      currentResult.metrics,
    )) {
      const baselineMetric = baselineResult.metrics[metricName];
      if (!baselineMetric) continue;

      const deltaAbsolute = currentMetric.value - baselineMetric.value;
      const deltaPct =
        baselineMetric.value !== 0
          ? (deltaAbsolute / baselineMetric.value) * 100
          : 0;

      const absPct = Math.abs(deltaPct);
      const severity: MetricChange['severity'] =
        absPct >= REGRESSION_THRESHOLD_PCT
          ? 'regression'
          : absPct >= WARNING_THRESHOLD_PCT
            ? 'warning'
            : 'info';

      changes.push({
        experiment: expName,
        metric: metricName,
        baseline: baselineMetric,
        current: currentMetric,
        deltaAbsolute,
        deltaPct,
        severity,
      });
    }
  }

  const binaryChanged =
    baseline.binaryHash !== undefined &&
    current.binaryHash !== undefined &&
    baseline.binaryHash !== 'unknown' &&
    current.binaryHash !== 'unknown' &&
    baseline.binaryHash !== current.binaryHash;

  const systemPromptChanged =
    baseline.systemPromptHash !== undefined &&
    current.systemPromptHash !== undefined &&
    baseline.systemPromptHash !== 'unknown' &&
    current.systemPromptHash !== 'unknown' &&
    baseline.systemPromptHash !== current.systemPromptHash;

  const modelPoolChanges = diffModelPool(baseline.modelPool, current.modelPool);

  return {
    baseline,
    current,
    changes,
    hasRegressions: changes.some((c) => c.severity === 'regression'),
    binaryChanged,
    systemPromptChanged,
    modelPoolChanges,
  };
}

/** Format a diff report as a markdown string. */
export function formatDiffReport(report: DiffReport): string {
  const lines: string[] = [
    '# CLI Wrapper Monitor — Diff Report',
    '',
    `**Baseline**: ${report.baseline.capturedAt} (${report.baseline.monitorVersion})`,
    `**Current**:  ${report.current.capturedAt} (${report.current.monitorVersion})`,
    `**Model**: ${report.current.model}`,
    '',
  ];

  // Hash change warnings
  if (report.binaryChanged) {
    const prev = report.baseline.binaryHash?.slice(0, 8) ?? '?';
    const curr = report.current.binaryHash?.slice(0, 8) ?? '?';
    lines.push(`⚠️  **CLI binary changed**: \`${prev}…\` → \`${curr}…\``);
  }
  if (report.systemPromptChanged) {
    const prev = report.baseline.systemPromptHash?.slice(0, 8) ?? '?';
    const curr = report.current.systemPromptHash?.slice(0, 8) ?? '?';
    lines.push(`⚠️  **System prompt changed**: \`${prev}…\` → \`${curr}…\``);
  }
  if (report.binaryChanged || report.systemPromptChanged) {
    lines.push('');
  }

  lines.push(
    report.hasRegressions ? '⚠️  **Regressions detected**' : '✅ No regressions',
    '',
    '## Metric Changes',
    '',
  );

  if (report.changes.length === 0) {
    lines.push('_No overlapping metrics to compare._');
  } else {
    for (const change of report.changes) {
      const icon =
        change.severity === 'regression'
          ? '🔴'
          : change.severity === 'warning'
            ? '🟡'
            : '⚪';
      const sign = change.deltaAbsolute >= 0 ? '+' : '';
      lines.push(
        `${icon} **${change.experiment}/${change.metric}**: ` +
          `${change.baseline.value} → ${change.current.value} ${change.current.unit} ` +
          `(${sign}${change.deltaPct.toFixed(1)}%)`,
      );
    }
  }

  // Model pool changes
  if (report.modelPoolChanges.length > 0) {
    lines.push('', '## Model Pool Changes', '');
    for (const change of report.modelPoolChanges) {
      if (change.type === 'added' && change.after) {
        const m = change.after;
        lines.push(
          `✅ **Added**: \`${m.id}\` — state: ${m.state}, ctx: ${m.contextWindow.toLocaleString()} tokens`,
        );
      } else if (change.type === 'removed' && change.before) {
        const m = change.before;
        lines.push(
          `❌ **Removed**: \`${m.id}\` — was state: ${m.state}, ctx: ${m.contextWindow.toLocaleString()} tokens`,
        );
      } else if (change.type === 'state_changed' && change.before && change.after) {
        lines.push(
          `⚠️  **State changed**: \`${change.modelId}\` — ${change.before.state} → ${change.after.state}`,
        );
      } else if (change.type === 'context_window_changed' && change.before && change.after) {
        lines.push(
          `⚠️  **Context window changed**: \`${change.modelId}\` — ` +
            `${change.before.contextWindow.toLocaleString()} → ${change.after.contextWindow.toLocaleString()} tokens`,
        );
      }
    }
  }

  return lines.join('\n');
}
