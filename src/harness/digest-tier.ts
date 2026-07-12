/**
 * digest-tier.ts
 *
 * Drift-magnitude scoring and tier classification for the weekly stability digest.
 *
 * The three tiers drive message verbosity in buildWeeklyDigestMessage():
 *   🚨 ALERT  — significant change; full section-changes + probe breakdown
 *   ⚠️ CHANGE — minor drift; current digest format (unchanged)
 *   ✅ STABLE  — no meaningful drift; single-line summary
 */

import type { DiffReport } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Four-signal drift magnitude object computed from a DiffReport.
 * All values are absolute magnitudes (never negative for delta fields).
 */
export interface DriftMagnitude {
  /** Absolute percentage change of the system prompt char count (always ≥ 0). */
  systemPromptDeltaPct: number;
  /**
   * Net tool-count delta (current − baseline).
   * 0 means no change; non-zero means tools were added or removed.
   */
  toolCountDelta: number;
  /**
   * Absolute drop in probe-refusal rate in percentage points (always ≥ 0).
   * Computed across all experiments that carry an `injectionRefusedRate` metric.
   * 0 when no probe-result data is available or the rate did not drop.
   */
  probeRefusalDeltaPp: number;
  /** True when any prompt sections changed (added, removed, or resized). */
  hasSectionChanges: boolean;
  /**
   * True when ANY change was detected in the diff report, including changes
   * not captured by the four primary signals above (hook body changes, binary
   * changes, model-pool changes, tool-schema changes, system-prompt hash changes).
   * Used to ensure CHANGE tier is emitted for any detected drift even when
   * the four numeric signals are all zero.
   */
  hasAnyDrift: boolean;
  /**
   * Total number of named tool additions + removals between the two snapshots.
   * Computed from `toolNames` fields (sorted lists) when available; falls back
   * to `toolSchemas` keys when `toolNames` is absent; 0 when neither snapshot
   * carries named-tool data (pre-toolNames baselines).
   * Used to detect swap-out regressions invisible to toolCountDelta alone.
   */
  toolSurfaceChanges: number;
}

/**
 * Tier-classification thresholds.  All fields are optional; absent fields fall
 * back to the DEFAULT_TIER_THRESHOLDS defaults so existing repos without a
 * `digestTier` config key get sensible behaviour automatically.
 */
export interface DigestTierConfig {
  /**
   * System-prompt delta percentage at or above which the digest is ALERT-tier.
   * Default: 5 (%).
   */
  alertSystemPromptDeltaPct?: number;
  /**
   * Probe-refusal drop in percentage points at or above which the digest is
   * ALERT-tier.  Default: 5 (pp).
   */
  alertProbeRefusalDeltaPp?: number;
}

export type DigestTier = 'alert' | 'change' | 'stable';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_TIER_THRESHOLDS: Required<DigestTierConfig> = {
  alertSystemPromptDeltaPct: 5,
  alertProbeRefusalDeltaPp: 5,
};

// ---------------------------------------------------------------------------
// buildDriftMagnitude
// ---------------------------------------------------------------------------

/**
 * Compute a DriftMagnitude object from a DiffReport.
 *
 * - systemPromptDeltaPct: derived from context-tax experiment's
 *   `systemPromptChars` metric (baseline vs current).
 * - toolCountDelta: derived from context-tax `toolCount` metric delta.
 * - probeRefusalDeltaPp: maximum drop across any experiment that captures an
 *   `injectionRefusedRate` metric (0–100 pp scale, always ≥ 0).
 * - hasSectionChanges: true when any promptSectionChange has a non-zero
 *   absolute delta or a null side (section added/removed).
 */
export function buildDriftMagnitude(diffReport: DiffReport): DriftMagnitude {
  const { baseline, current } = diffReport;

  // --- system prompt delta pct ---
  let systemPromptDeltaPct = 0;
  const baselineSysChars =
    baseline.experiments['context-tax']?.metrics?.['systemPromptChars']?.value;
  const currentSysChars =
    current.experiments['context-tax']?.metrics?.['systemPromptChars']?.value;
  if (
    baselineSysChars !== undefined &&
    currentSysChars !== undefined &&
    baselineSysChars > 0
  ) {
    systemPromptDeltaPct = Math.abs(
      ((currentSysChars - baselineSysChars) / baselineSysChars) * 100,
    );
  }

  // --- tool count delta ---
  let toolCountDelta = 0;
  const baselineToolCount =
    baseline.experiments['context-tax']?.metrics?.['toolCount']?.value;
  const currentToolCount =
    current.experiments['context-tax']?.metrics?.['toolCount']?.value;
  if (baselineToolCount !== undefined && currentToolCount !== undefined) {
    toolCountDelta = currentToolCount - baselineToolCount;
  }

  // --- probe refusal delta (pp, 0–100) ---
  // Convert stored 0–1 fraction to pp (×100), report the worst (largest) drop.
  let probeRefusalDeltaPp = 0;
  for (const [expName, baselineExp] of Object.entries(baseline.experiments ?? {})) {
    const currentExp = current.experiments?.[expName];
    if (!currentExp) continue;
    const baselineRate = baselineExp.metrics?.['injectionRefusedRate']?.value;
    const currentRate = currentExp.metrics?.['injectionRefusedRate']?.value;
    if (baselineRate !== undefined && currentRate !== undefined) {
      const dropPp = (baselineRate - currentRate) * 100;
      if (dropPp > probeRefusalDeltaPp) {
        probeRefusalDeltaPp = dropPp;
      }
    }
  }
  // probeRefusalDeltaPp can only be ≥ 0 (loop only assigns positive drops starting from 0),
  // but clamp defensively to guard against future code changes.
  probeRefusalDeltaPp = Math.max(0, probeRefusalDeltaPp);

  // --- section changes ---
  const hasSectionChanges =
    diffReport.promptSectionsAvailable &&
    diffReport.promptSectionChanges.some(
      (c) =>
        c.deltaAbsolute !== 0 ||
        c.baselineCharCount === null ||
        c.currentCharCount === null,
    );

  // --- named tool surface changes ---
  // Resolve the best available tool-name sets for each snapshot.
  // Preference: toolNames (explicit sorted list) → toolSchemas keys → null (unavailable).
  function resolveToolNameSet(snap: { toolNames?: string[] | null; toolSchemas?: Record<string, unknown> | null }): Set<string> | null {
    // Use `!= null` to guard against both `undefined` (field absent) and `null`
    // (older baselines persist `toolSchemas: null`). `Object.keys(null)` throws.
    if (snap.toolNames != null) return new Set(snap.toolNames);
    if (snap.toolSchemas != null) return new Set(Object.keys(snap.toolSchemas));
    return null;
  }
  const baselineToolNames = resolveToolNameSet(baseline);
  const currentToolNames = resolveToolNameSet(current);
  let toolSurfaceChanges = 0;
  if (baselineToolNames !== null && currentToolNames !== null) {
    const added = [...currentToolNames].filter((n) => !baselineToolNames.has(n)).length;
    const removed = [...baselineToolNames].filter((n) => !currentToolNames.has(n)).length;
    toolSurfaceChanges = added + removed;
  }

  return {
    systemPromptDeltaPct,
    toolCountDelta,
    probeRefusalDeltaPp,
    hasSectionChanges,
    hasAnyDrift:
      hasSectionChanges ||
      systemPromptDeltaPct > 0 ||
      toolCountDelta !== 0 ||
      probeRefusalDeltaPp > 0 ||
      toolSurfaceChanges > 0 ||
      diffReport.hasBreaking ||
      diffReport.warnings.length > 0 ||
      diffReport.binaryChanged ||
      diffReport.hookChanged ||
      diffReport.toolSchemaChanged ||
      diffReport.modelPoolChanges.length > 0 ||
      diffReport.systemPromptChanged,
    toolSurfaceChanges,
  };
}

// ---------------------------------------------------------------------------
// classifyDigestTier
// ---------------------------------------------------------------------------

/**
 * Classify a DriftMagnitude into one of three digest tiers.
 *
 * ALERT conditions (any one sufficient):
 *   - systemPromptDeltaPct ≥ alertSystemPromptDeltaPct threshold
 *   - toolCountDelta ≠ 0
 *   - probeRefusalDeltaPp ≥ alertProbeRefusalDeltaPp threshold
 *
 * CHANGE conditions (any drift but below ALERT threshold):
 *   - systemPromptDeltaPct > 0
 *   - hasSectionChanges
 *   - probeRefusalDeltaPp > 0
 *
 * STABLE: none of the above.
 *
 * When `config` is absent or partially specified, DEFAULT_TIER_THRESHOLDS fill
 * the gaps — preserving existing digest verbosity when the `digestTier` key is
 * absent from capture.config.json.
 */
export function classifyDigestTier(
  magnitude: DriftMagnitude,
  config?: DigestTierConfig,
): DigestTier {
  const alertSysPct =
    config?.alertSystemPromptDeltaPct ?? DEFAULT_TIER_THRESHOLDS.alertSystemPromptDeltaPct;
  const alertProbePp =
    config?.alertProbeRefusalDeltaPp ?? DEFAULT_TIER_THRESHOLDS.alertProbeRefusalDeltaPp;

  // ALERT: significant change
  if (
    magnitude.systemPromptDeltaPct >= alertSysPct ||
    magnitude.toolCountDelta !== 0 ||
    magnitude.probeRefusalDeltaPp >= alertProbePp ||
    magnitude.toolSurfaceChanges >= 2
  ) {
    return 'alert';
  }

  // CHANGE: any detectable drift below the alert threshold
  if (magnitude.hasAnyDrift) {
    return 'change';
  }

  // STABLE: no meaningful drift
  return 'stable';
}
