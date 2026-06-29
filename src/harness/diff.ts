import type { DiffReport, MetricChange, MetricSnapshot, ModelPool, ModelPoolChange, ToolParamSchema, ToolSchemaChange } from './types.js';
import { classifyDeltaPct } from '../severity.js';

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

/** Diff two tool schema maps, returning per-tool change records.
 *
 * Returns an empty array when either map is absent — prevents spurious
 * add/remove spam when comparing against older baselines that pre-date
 * schema tracking.
 */
export function diffToolSchemas(
  baseline: Record<string, ToolParamSchema> | undefined,
  current: Record<string, ToolParamSchema> | undefined,
): ToolSchemaChange[] {
  // Don't diff when either side lacks schema data — avoids false churn
  // against pre-feature baselines (every tool would appear as added/removed).
  if (!baseline || !current) return [];
  const baseMap = new Map(Object.entries(baseline));
  const currMap = new Map(Object.entries(current));
  const changes: ToolSchemaChange[] = [];

  // Removed tools
  for (const [name, before] of baseMap) {
    if (!currMap.has(name)) {
      changes.push({ toolName: name, type: 'removed', before });
    }
  }

  // Added tools and changed tools
  for (const [name, after] of currMap) {
    const before = baseMap.get(name);
    if (!before) {
      changes.push({ toolName: name, type: 'added', after });
      continue;
    }
    const allBefore = new Set([...before.requiredParams, ...before.optionalParams]);
    const allAfter = new Set([...after.requiredParams, ...after.optionalParams]);
    const addedParams = [...allAfter].filter((p) => !allBefore.has(p)).sort();
    const removedParams = [...allBefore].filter((p) => !allAfter.has(p)).sort();
    if (addedParams.length > 0 || removedParams.length > 0) {
      changes.push({ toolName: name, type: 'params_changed', before, after, addedParams, removedParams });
    } else if (before.descriptionHash !== after.descriptionHash) {
      changes.push({ toolName: name, type: 'description_changed', before, after });
    }
  }

  return changes;
}


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
      const severity = classifyDeltaPct(absPct);

      // Structural BREAKING override: tool count dropping is always BREAKING
      // regardless of percentage magnitude. Detected below via structuralBreaks.
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

  const hookChanged =
    baseline.hookSourceHash !== undefined &&
    current.hookSourceHash !== undefined &&
    baseline.hookSourceHash !== 'unknown' &&
    current.hookSourceHash !== 'unknown' &&
    baseline.hookSourceHash !== current.hookSourceHash;

  const toolSchemaChanged =
    baseline.toolSchemaHash !== undefined &&
    current.toolSchemaHash !== undefined &&
    baseline.toolSchemaHash !== current.toolSchemaHash;

  const toolSchemaChanges = diffToolSchemas(baseline.toolSchemas, current.toolSchemas);

  const modelPoolChanges = diffModelPool(baseline.modelPool, current.modelPool);

  // ── Structural BREAKING conditions ────────────────────────────────────────
  // These are BREAKING regardless of percentage magnitude.
  const structuralBreaks: string[] = [];

  const baselineToolCount = baseline.experiments['context-tax']?.metrics['toolCount']?.value;
  const currentToolCount = current.experiments['context-tax']?.metrics['toolCount']?.value;
  if (
    baselineToolCount !== undefined &&
    currentToolCount !== undefined &&
    currentToolCount < baselineToolCount
  ) {
    structuralBreaks.push(
      `Tool count dropped: ${baselineToolCount} → ${currentToolCount}`,
    );
  }

  const baselineHookCount = baseline.hookCount;
  const currentHookCount = current.hookCount;
  if (
    baselineHookCount !== undefined &&
    currentHookCount !== undefined &&
    currentHookCount < baselineHookCount
  ) {
    structuralBreaks.push(
      `Hook count dropped: ${baselineHookCount} → ${currentHookCount}`,
    );
  }

  const hasBreaking =
    changes.some((c) => c.severity === 'BREAKING') || structuralBreaks.length > 0;

  const severitySummary = {
    breaking: changes.filter((c) => c.severity === 'BREAKING').length + structuralBreaks.length,
    warning: changes.filter((c) => c.severity === 'WARNING').length,
    info: changes.filter((c) => c.severity === 'INFO').length,
  };

  return {
    baseline,
    current,
    changes,
    hasBreaking,
    hasRegressions: hasBreaking,
    severitySummary,
    structuralBreaks,
    binaryChanged,
    systemPromptChanged,
    hookChanged,
    modelPoolChanges,
    toolSchemaChanged,
    toolSchemaChanges,
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
  if (report.hookChanged) {
    const prev = report.baseline.hookSourceHash?.slice(0, 16) ?? '?';
    const curr = report.current.hookSourceHash?.slice(0, 16) ?? '?';
    const prevCount = report.baseline.hookCount ?? '?';
    const currCount = report.current.hookCount ?? '?';
    const countNote = prevCount !== currCount ? ` (count: ${prevCount} → ${currCount})` : '';
    lines.push(`🚨  **Hook definitions changed**: \`${prev}…\` → \`${curr}…\`${countNote}`);
  }
  if (report.binaryChanged || report.systemPromptChanged || report.hookChanged) {
    lines.push('');
  }

  lines.push(
    report.hasBreaking ? '🔴  **BREAKING regressions detected**' : '✅ No breaking regressions',
    '',
    '## Metric Changes',
    '',
  );

  if (report.changes.length === 0) {
    lines.push('_No overlapping metrics to compare._');
  } else {
    for (const change of report.changes) {
      const icon =
        change.severity === 'BREAKING'
          ? '🔴'
          : change.severity === 'WARNING'
            ? '🟡'
            : '🟢';
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

  // Tool schema changes (only shown when BOTH snapshots have schema data)
  if (report.toolSchemaChanges.length > 0) {
    lines.push('', '## Tool Schema Changes', '');
    for (const change of report.toolSchemaChanges) {
      if (change.type === 'added') {
        const s = change.after!;
        lines.push(
          `✅ **Added tool**: \`${change.toolName}\` — ` +
            `${s.parameterCount} params (required: [${s.requiredParams.join(', ')}])`,
        );
      } else if (change.type === 'removed') {
        const s = change.before!;
        lines.push(
          `❌ **Removed tool**: \`${change.toolName}\` — ` +
            `was ${s.parameterCount} params (required: [${s.requiredParams.join(', ')}])`,
        );
      } else if (change.type === 'params_changed') {
        const added = change.addedParams ?? [];
        const removed = change.removedParams ?? [];
        const parts: string[] = [];
        if (added.length > 0) parts.push(`+ added: [${added.join(', ')}]`);
        if (removed.length > 0) parts.push(`- removed: [${removed.join(', ')}]`);
        lines.push(`⚠️  **Params changed**: \`${change.toolName}\` — ${parts.join('; ')}`);
      } else if (change.type === 'description_changed') {
        const prev = change.before!.descriptionHash.slice(0, 8);
        const curr = change.after!.descriptionHash.slice(0, 8);
        lines.push(
          `⚠️  **Description changed**: \`${change.toolName}\` — hash: \`${prev}…\` → \`${curr}…\``,
        );
      }
    }
  } else if (report.baseline.toolSchemas !== undefined && report.current.toolSchemas !== undefined) {
    lines.push('', '## Tool Schema Changes', '', '> No tool schema changes detected.', '');
  }

  return lines.join('\n');
}
