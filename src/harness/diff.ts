import type { DiffReport, MetricChange, MetricSnapshot, ModelPool, ModelPoolChange, PromptSectionChange, ToolParamSchema, ToolSchemaChange } from './types.js';
import { classifyDeltaPct } from '../severity.js';
import { diffPromptSections } from './prompt-sections.js';

/**
 * Compute an aggregate security regression score (0–100, higher = more regressed).
 *
 * Scoring formula:
 *   - Tool removals:          10 pts per removed tool (max 30)
 *   - Model pool drop:        20 pts if any model removed
 *   - Hook count decrease:    20 pts if hook count drops
 *   - Hook body change:        5 pts if any hook body changed (single-hash tracking)
 *   - Injection refusal drop: 15 pts if any per-experiment refusal rate drops >5 pp
 *   - Headroom below 50%:      5 pts if headroom crosses below 50% (was ≥50% or absent before)
 *
 * Score 0 = no regressions. Score ≥30 = BREAKING tier. Score 1–29 = WARNING tier.
 */
export function computeSecurityPostureScore(
  baseline: MetricSnapshot,
  current: MetricSnapshot,
  toolSchemaChanges: ToolSchemaChange[],
  modelPoolChanges: ModelPoolChange[],
  hookChanged: boolean,
): number {
  let score = 0;

  // Tool removals: 10 pts per removed tool, capped at 30
  const removedToolCount = toolSchemaChanges.filter((c) => c.type === 'removed').length;
  score += Math.min(removedToolCount * 10, 30);

  // Model pool drop: 20 pts if any model removed
  if (modelPoolChanges.some((c) => c.type === 'removed')) {
    score += 20;
  }

  // Hook count decrease: 20 pts if hook count drops (or disappears)
  const baselineHookCount = baseline.hookCount;
  const currentHookCount = current.hookCount;
  const hookCountDropped =
    baselineHookCount !== undefined &&
    (currentHookCount === undefined || currentHookCount < baselineHookCount);
  if (hookCountDropped) {
    score += 20;
  }

  // Hook body change: 5 pts when hook body changes with same count.
  // Single-hash tracking means one body-change observation per diff = 5 pts.
  if (
    hookChanged &&
    baselineHookCount !== undefined &&
    currentHookCount !== undefined &&
    baselineHookCount === currentHookCount
  ) {
    score += 5;
  }

  // Injection refusal drop: 15 pts if any per-experiment refusal rate drops >5 pp.
  // Only compare experiments present in both snapshots to avoid cross-population artifacts.
  let injectionDropDetected = false;
  for (const [expName, baselineExp] of Object.entries(baseline.experiments ?? {})) {
    const currentExp = current.experiments?.[expName];
    if (!currentExp) continue;
    const baselineMetric = baselineExp.metrics?.['injectionRefusedRate'];
    const currentMetric = currentExp.metrics?.['injectionRefusedRate'];
    if (baselineMetric !== undefined && currentMetric !== undefined) {
      if (baselineMetric.value - currentMetric.value > 0.05) {
        injectionDropDetected = true;
        break;
      }
    }
  }
  if (injectionDropDetected) {
    score += 15;
  }

  // Headroom drop: 5 pts if headroom crosses below 50% (i.e. was ≥50% or absent before).
  // Avoids re-penalising snapshots that were already below threshold before the diff.
  const getHeadroomPct = (snap: MetricSnapshot): number | null => {
    const entries = snap.contextWindowHeadroom;
    if (!entries || entries.length === 0) return null;
    const enabled = entries.filter(
      (e) => e.state === 'enabled' && e.contextWindow > 0 && e.status !== 'unknown',
    );
    if (enabled.length === 0) return null;
    const totalHeadroom = enabled.reduce((sum, e) => sum + e.headroomTokens, 0);
    const totalWindow = enabled.reduce((sum, e) => sum + e.contextWindow, 0);
    return (totalHeadroom / totalWindow) * 100;
  };
  const baselineHeadroom = getHeadroomPct(baseline);
  const currentHeadroom = getHeadroomPct(current);
  if (
    currentHeadroom !== null &&
    currentHeadroom < 50 &&
    (baselineHeadroom === null || baselineHeadroom >= 50)
  ) {
    score += 5;
  }

  return Math.min(score, 100);
}

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
  if (baselineToolCount !== undefined) {
    if (currentToolCount === undefined) {
      structuralBreaks.push(`Tool count disappeared (was ${baselineToolCount})`);
    } else if (currentToolCount < baselineToolCount) {
      structuralBreaks.push(`Tool count dropped: ${baselineToolCount} → ${currentToolCount}`);
    }
  }

  const baselineHookCount = baseline.hookCount;
  const currentHookCount = current.hookCount;
  if (baselineHookCount !== undefined) {
    if (currentHookCount === undefined) {
      structuralBreaks.push(`Hook count disappeared (was ${baselineHookCount})`);
    } else if (currentHookCount < baselineHookCount) {
      structuralBreaks.push(`Hook count dropped: ${baselineHookCount} → ${currentHookCount}`);
    } else if (currentHookCount > baselineHookCount) {
      structuralBreaks.push(`Hook count increased: ${baselineHookCount} → ${currentHookCount}`);
    }
  }

  // Named tool removal via schema tracking = always BREAKING.
  // One removed tool is enough to mark the comparison as a breaking regression
  // because callers that depend on a named tool will fail silently when it vanishes.
  //
  // Special case: if the baseline had tracked tools but current snapshot has no
  // toolSchemas, that is likely a capture failure — flag it as BREAKING.
  // Only trigger when baseline actually tracked at least one tool, so a baseline
  // that was created without schema data does not produce a false positive.
  // (diffToolSchemas returns [] when either side is undefined, so we check explicitly.)
  const baselineTrackedToolCount = baseline.toolSchemas
    ? Object.keys(baseline.toolSchemas).length
    : 0;
  if (baseline.toolSchemas !== undefined && current.toolSchemas === undefined && baselineTrackedToolCount > 0) {
    structuralBreaks.push(
      `Tool schema data disappeared — baseline had ${baselineTrackedToolCount} tool(s) tracked but current snapshot has no toolSchemas`,
    );
  } else {
    // Normal path: diff named tools and flag each removal.
    for (const change of toolSchemaChanges) {
      if (change.type === 'removed') {
        const paramCount = change.before?.parameterCount;
        const paramLabel = paramCount !== undefined
          ? `was ${paramCount} param${paramCount !== 1 ? 's' : ''}`
          : 'parameter count unknown';
        structuralBreaks.push(`Tool removed: \`${change.toolName}\` (${paramLabel})`);
      }
    }
  }

  // Model removal is always BREAKING: agents that hard-code a model ID will
  // silently fall back or error when that model disappears from the pool.
  for (const change of modelPoolChanges) {
    if (change.type === 'removed' && change.before) {
      structuralBreaks.push(
        `Model removed from pool: \`${change.modelId}\` (was state: ${change.before.state})`,
      );
    }
  }

  // ── WARNING-level structural notes ────────────────────────────────────────
  // Hook body changed without count change: notable but not BREAKING.
  const warnings: string[] = [];
  if (
    hookChanged &&
    baselineHookCount !== undefined &&
    currentHookCount !== undefined &&
    baselineHookCount === currentHookCount
  ) {
    const hashSnippet = (h: string | undefined) =>
      h && h !== 'unknown' ? h.replace(/^sha256:/, '').slice(0, 12) + '…' : 'unknown';
    warnings.push(
      `Hook body changed (count unchanged: ${baselineHookCount}): ` +
        `\`${hashSnippet(baseline.hookSourceHash)}\` → \`${hashSnippet(current.hookSourceHash)}\``,
    );
  }

  const hasBreaking =
    changes.some((c) => c.severity === 'BREAKING') || structuralBreaks.length > 0;

  // severitySummary counts metric-change rows by tier; structural breaks are
    // severitySummary counts metric-change rows by tier; structural breaks are
  // tracked in structuralBreakCount to avoid double-counting with metric rows.
  const severitySummary = {
    breaking: changes.filter((c) => c.severity === 'BREAKING').length,
    warning: changes.filter((c) => c.severity === 'WARNING').length,
    info: changes.filter((c) => c.severity === 'INFO').length,
    structuralBreakCount: structuralBreaks.length,
  };

  // hasRegressions preserved with original >= 10% metric-only semantics.
  // Does NOT include structural breaks — use hasBreaking for that.
  const LEGACY_REGRESSION_THRESHOLD_PCT = 10;
  const hasRegressions = changes.some((c) => Math.abs(c.deltaPct) >= LEGACY_REGRESSION_THRESHOLD_PCT);

  const promptSectionChanges = diffPromptSections(baseline.promptSections, current.promptSections);
  const promptSectionsAvailable =
    (baseline.promptSections !== undefined && baseline.promptSections.length > 0) ||
    (current.promptSections !== undefined && current.promptSections.length > 0);

  return {
    baseline,
    current,
    changes,
    hasBreaking,
    hasRegressions,
    severitySummary,
    structuralBreaks,
    warnings,
    binaryChanged,
    systemPromptChanged,
    hookChanged,
    modelPoolChanges,
    toolSchemaChanged,
    toolSchemaChanges,
    promptSectionChanges,
    promptSectionsAvailable,
    securityPostureScore: computeSecurityPostureScore(
      baseline,
      current,
      toolSchemaChanges,
      modelPoolChanges,
      hookChanged,
    ),
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

  // Security Posture Score
  const score = report.securityPostureScore;
  const scoreIcon = score >= 30 ? '🔴' : score >= 1 ? '⚠️' : '✅';
  const scoreTierLabel = score >= 30 ? 'BREAKING' : score >= 1 ? 'WARNING' : 'CLEAN';
  lines.push(`**Security Posture Score**: ${score}/100 ${scoreIcon} ${scoreTierLabel}`, '');

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
  );

  if (report.structuralBreaks.length > 0) {
    lines.push('## Structural BREAKING Changes', '');
    for (const sb of report.structuralBreaks) {
      lines.push(`- 🔴 **BREAKING**: ${sb}`);
    }
    lines.push('');
  }

  if (report.warnings.length > 0) {
    lines.push('## Hook Changes', '');
    for (const w of report.warnings) {
      lines.push(`- 🟡 **WARNING**: ${w}`);
    }
    lines.push('');
  }

  lines.push('## Metric Changes', '');

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

  // Prompt section changes
  lines.push('', '## Prompt Section Changes', '');
  if (!report.promptSectionsAvailable) {
    lines.push('> _Section data unavailable — baselines pre-date section attribution._');
  } else if (report.promptSectionChanges.length === 0) {
    lines.push('> No prompt section changes detected.');
  } else {
    for (const change of report.promptSectionChanges) {
      const sign = change.deltaAbsolute >= 0 ? '+' : '';
      const pctStr =
        change.deltaPct !== null ? ` (${sign}${change.deltaPct.toFixed(1)}%)` : ' (new)';
      const icon = change.deltaAbsolute > 0 ? '📈' : change.deltaAbsolute < 0 ? '📉' : '🟢';
      const from =
        change.baselineCharCount !== null
          ? `${change.baselineCharCount.toLocaleString()} chars`
          : '_(new)_';
      const to =
        change.currentCharCount !== null
          ? `${change.currentCharCount.toLocaleString()} chars`
          : '_(removed)_';
      lines.push(
        `${icon} **${change.name}**: ${from} → ${to} (${sign}${change.deltaAbsolute.toLocaleString()} chars${pctStr})`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}
