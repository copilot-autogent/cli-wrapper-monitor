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
  /** Experiment results indexed by experiment name */
  experiments: Record<string, ExperimentResult>;
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
}
