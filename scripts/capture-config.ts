/**
 * Capture configuration loader.
 *
 * Reads capture.config.json from the repository root (or a custom path)
 * and returns a validated CaptureConfig object with defaults applied.
 *
 * Exported for unit testing and for use by archive/validate scripts.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { DigestTierConfig } from '../src/harness/digest-tier.js';

export interface CaptureConfig {
  /** Directory for monthly (PR-flow) baseline files (default: "baselines") */
  monthlyBaselinesDir: string;
  /** Directory for weekly reference snapshot files (default: "baselines/weekly") */
  weeklyBaselinesDir: string;
  /** Retention window in calendar months; files older than this are archived (default: 6) */
  retentionMonths: number;
  /**
   * When true, store the raw text of each prompt section in MetricSnapshot.promptSections[*].text.
   * Default false — keeps baseline file sizes small.
   * Enabling this is required for prompt section text diff in compare reports.
   */
  capturePromptSectionText: boolean;
  /**
   * When true, store per-probe pass/fail results in MetricSnapshot.probeResults[].
   * Default false — keeps baseline file sizes small. Required for `npm run probe-audit`.
   * Only has effect when the refusal-rate experiment runs (requires GITHUB_TOKEN).
   */
  captureProbeResults: boolean;
  /**
   * Digest tier classification thresholds.
   * Absent (undefined) means use DEFAULT_TIER_THRESHOLDS from digest-tier.ts.
   * ALERT on: systemPromptDeltaPct ≥ alertSystemPromptDeltaPct (default 5%)
   *           OR toolCountDelta ≠ 0
   *           OR probeRefusalDeltaPp ≥ alertProbeRefusalDeltaPp (default 5 pp)
   */
  digestTier?: DigestTierConfig;
}

export const DEFAULT_CONFIG: CaptureConfig = {
  monthlyBaselinesDir: 'baselines',
  weeklyBaselinesDir: 'baselines/weekly',
  retentionMonths: 6,
  capturePromptSectionText: false,
  captureProbeResults: false,
  digestTier: undefined,
};

/**
 * Load and validate capture.config.json.
 *
 * - If the config file does not exist, returns DEFAULT_CONFIG.
 * - Unknown keys are silently ignored.
 * - Invalid values (wrong type or out-of-range) throw a descriptive Error.
 *
 * @param configPath  Path to capture.config.json (default: "capture.config.json")
 */
export function loadCaptureConfig(configPath = 'capture.config.json'): CaptureConfig {
  const absPath = resolve(configPath);

  if (!existsSync(absPath)) {
    return { ...DEFAULT_CONFIG };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${(err as Error).message}`);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${configPath}: root value must be a JSON object`);
  }

  const obj = raw as Record<string, unknown>;
  const config: CaptureConfig = { ...DEFAULT_CONFIG };

  if ('monthlyBaselinesDir' in obj) {
    if (typeof obj.monthlyBaselinesDir !== 'string' || obj.monthlyBaselinesDir.trim() === '') {
      throw new Error(`${configPath}: monthlyBaselinesDir must be a non-empty string`);
    }
    config.monthlyBaselinesDir = obj.monthlyBaselinesDir.trim();
  }

  if ('weeklyBaselinesDir' in obj) {
    if (typeof obj.weeklyBaselinesDir !== 'string' || obj.weeklyBaselinesDir.trim() === '') {
      throw new Error(`${configPath}: weeklyBaselinesDir must be a non-empty string`);
    }
    config.weeklyBaselinesDir = obj.weeklyBaselinesDir.trim();
  }

  if ('retentionMonths' in obj) {
    const n = obj.retentionMonths;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw new Error(`${configPath}: retentionMonths must be a positive integer`);
    }
    config.retentionMonths = n;
  }

  if ('capturePromptSectionText' in obj) {
    if (typeof obj.capturePromptSectionText !== 'boolean') {
      throw new Error(`${configPath}: capturePromptSectionText must be a boolean`);
    }
    config.capturePromptSectionText = obj.capturePromptSectionText;
  }

  if ('captureProbeResults' in obj) {
    if (typeof obj.captureProbeResults !== 'boolean') {
      throw new Error(`${configPath}: captureProbeResults must be a boolean`);
    }
    config.captureProbeResults = obj.captureProbeResults;
  }

  if ('digestTier' in obj) {
    const dt = obj.digestTier;
    if (typeof dt !== 'object' || dt === null || Array.isArray(dt)) {
      throw new Error(`${configPath}: digestTier must be an object`);
    }
    const dtObj = dt as Record<string, unknown>;
    const tierConfig: DigestTierConfig = {};
    if ('alertSystemPromptDeltaPct' in dtObj) {
      const v = dtObj.alertSystemPromptDeltaPct;
      if (typeof v !== 'number' || v <= 0) {
        throw new Error(`${configPath}: digestTier.alertSystemPromptDeltaPct must be a positive number`);
      }
      tierConfig.alertSystemPromptDeltaPct = v;
    }
    if ('alertProbeRefusalDeltaPp' in dtObj) {
      const v = dtObj.alertProbeRefusalDeltaPp;
      if (typeof v !== 'number' || v <= 0) {
        throw new Error(`${configPath}: digestTier.alertProbeRefusalDeltaPp must be a positive number`);
      }
      tierConfig.alertProbeRefusalDeltaPp = v;
    }
    config.digestTier = tierConfig;
  }

  return config;
}

/**
 * Resolve the correct baselines directory for a given capture reason.
 *
 * - "weekly" → weeklyBaselinesDir
 * - anything else ("scheduled", "manual", "post-release", …) → monthlyBaselinesDir
 *
 * This function is the single routing point so tests can verify directory
 * selection without exercising file I/O.
 */
export function resolveBaselinesDir(
  captureReason: string,
  config: CaptureConfig = DEFAULT_CONFIG
): string {
  return captureReason.trim().toLowerCase() === 'weekly'
    ? config.weeklyBaselinesDir
    : config.monthlyBaselinesDir;
}
