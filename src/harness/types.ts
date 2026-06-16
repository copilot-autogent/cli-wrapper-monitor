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
  /** Available model pool at capture time (absent in older baselines) */
  modelPool?: ModelPool;
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
  /** Model pool additions, removals, and state/context-window changes */
  modelPoolChanges: ModelPoolChange[];
}
