/** A single measured metric value */
export interface MetricValue {
  value: number;
  unit: string;
  description: string;
}

/** Result of a single experiment run */
export interface ExperimentResult {
  name: string;
  description: string;
  /** Named metrics collected during the experiment */
  metrics: Record<string, MetricValue>;
  /** Optional raw data for debugging */
  rawData?: unknown;
  /** Set when the experiment threw an error */
  error?: string;
}

/** A single model's recorded state in a baseline capture */
export interface ModelPoolEntry {
  id: string;
  /** policy.state from the SDK: 'enabled' | 'disabled' | 'unconfigured' */
  state: string;
  /** capabilities.limits.max_context_window_tokens */
  contextWindow: number;
}

/** Model pool snapshot captured at baseline time */
export interface ModelPool {
  /** ISO 8601 timestamp when listModels() was called */
  capturedAt: string;
  models: ModelPoolEntry[];
}

/** Fill-status tiers for a model's context window headroom */
export type HeadroomStatus = 'ok' | 'high-fill' | 'overflow-risk';

/** Context window headroom computed for a single model */
export interface ContextWindowHeadroomEntry {
  modelId: string;
  /** Total context window size in tokens */
  contextWindow: number;
  /** System prompt token count used for this measurement */
  systemPromptTokens: number;
  /** contextWindow - systemPromptTokens */
  headroomTokens: number;
  /** (systemPromptTokens / contextWindow) * 100, rounded to 1 decimal */
  promptFillPct: number;
  /** 'ok' ≤50%, 'high-fill' >50%, 'overflow-risk' >90% */
  status: HeadroomStatus;
}

/**
 * A single autogent PR matched as a possible cause for a baseline delta.
 * Embedded in MetricSnapshot.possibleCauses when provenance linking is enabled.
 */
export interface ProvenanceLinkEntry {
  /** e.g. "JackywithaWhiteDog/autogent#612" */
  pr: string;
  title: string;
  /** ISO date of merge, e.g. "2026-06-15" */
  mergedAt: string;
  /** Which of the provenance-relevant path prefixes were touched by this PR */
  touchedPaths: string[];
}

/** A complete snapshot of all experiment results at a point in time */
export interface MetricSnapshot {
  /** ISO 8601 timestamp */
  capturedAt: string;
  /** Short git SHA of the monitor repo at capture time */
  monitorVersion: string;
  /** @github/copilot-sdk semver string */
  sdkVersion: string;
  /** Copilot model used during experiments */
  model: string;
  /** sha256 fingerprint of the monitored CLI binary (e.g. dist/index.js), or 'unknown' */
  binaryHash?: string;
  /** sha256 fingerprint of the assembled system prompt, or 'unknown' */
  systemPromptHash?: string;
  /** Number of hook handlers detected (onPreToolUse, onPermissionRequest, onPostToolUse) */
  hookCount?: number;
  /** sha256 fingerprint of the concatenated hook source files, or 'unknown' */
  hookSourceHash?: string;
  /** Available model pool at capture time (absent in older baselines) */
  modelPool?: ModelPool;
  /**
   * Per-model context window headroom relative to the current system prompt.
   * Absent when modelPool was not captured or the context-tax experiment failed.
   */
  contextWindowHeadroom?: ContextWindowHeadroomEntry[];
  /**
   * Autogent PRs that touched provenance-relevant paths (src/workspace/,
   * src/tools/builtin/, src/hooks/) between the previous baseline and this one.
   * Absent when no previous baseline exists, provenance linking is disabled,
   * or no matching PRs were found.
   */
  possibleCauses?: ProvenanceLinkEntry[];
  /** Experiment results indexed by experiment name */
  experiments: Record<string, ExperimentResult>;
}

/** A model-pool change between two snapshots */
export interface ModelPoolChange {
  type: 'added' | 'removed' | 'state_changed' | 'context_window_changed';
  modelId: string;
  /** Previous entry (absent for 'added') */
  before?: ModelPoolEntry;
  /** New entry (absent for 'removed') */
  after?: ModelPoolEntry;
}

/** Interface every experiment must implement */
export interface Experiment {
  readonly name: string;
  readonly description: string;
  run(): Promise<ExperimentResult>;
}

/** A single metric change between two snapshots */
export interface MetricChange {
  experiment: string;
  metric: string;
  baseline: MetricValue;
  current: MetricValue;
  /** Absolute delta (current - baseline) */
  deltaAbsolute: number;
  /** Percentage change; positive = increase */
  deltaPct: number;
  severity: 'info' | 'warning' | 'regression';
}

/** Full comparison between a baseline and current snapshot */
export interface DiffReport {
  baseline: MetricSnapshot;
  current: MetricSnapshot;
  changes: MetricChange[];
  hasRegressions: boolean;
  /** True when the monitored CLI binary hash changed between snapshots */
  binaryChanged: boolean;
  /** True when the assembled system prompt hash changed between snapshots */
  systemPromptChanged: boolean;
  /** True when the hook source hash changed between snapshots */
  hookChanged: boolean;
  /** Model pool additions, removals, and state/context-window changes */
  modelPoolChanges: ModelPoolChange[];
}

// ---------------------------------------------------------------------------
// Multi-model comparison types
// ---------------------------------------------------------------------------

/**
 * Context-tax measurements for a single model.
 * In static mode these are identical across models (wrapper overhead is constant);
 * kept per-entry for forward-compatibility with live-mode measurements.
 */
export interface ModelContextTax {
  systemPromptChars: number;
  systemPromptTokensEstimated: number;
  toolDefinitionsChars: number;
  toolDefinitionsTokensEstimated: number;
  toolCount: number;
}

/** Refusal-rate measurements for a single model. Null when experiment was skipped. */
export interface ModelRefusalRates {
  /** Fraction of safe prompts allowed (target: 1.0) */
  safeAllowedRate: number;
  /** Fraction of dangerous prompts refused (target: 1.0) */
  dangerousRefusedRate: number;
  /** Fraction of borderline prompts refused (varies by model policy) */
  borderlineRefusedRate: number;
  /** Total probes sent across all categories */
  totalProbes: number;
}

/** Per-model results from the multi-model sweep. */
export interface ModelBehaviorEntry {
  model: string;
  contextTax: ModelContextTax;
  /** Null when refusal experiment was skipped or unavailable. */
  refusal: ModelRefusalRates | null;
  /** Set when the sweep encountered an error for this model. */
  error?: string;
}

/**
 * Full snapshot produced by capture-multi-model.ts.
 * Stored in reports/multi-model-YYYY-MM-DD.json.
 */
export interface MultiModelComparisonSnapshot {
  /** ISO 8601 timestamp of the sweep */
  capturedAt: string;
  /** Short git SHA of the monitor repo */
  monitorVersion: string;
  /** Ordered list of model IDs tested */
  models: string[];
  /** Per-model results, in the same order as models[] */
  entries: ModelBehaviorEntry[];
}
