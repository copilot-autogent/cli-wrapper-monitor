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

export interface CaptureConfig {
  /** Directory for monthly (PR-flow) baseline files (default: "baselines") */
  monthlyBaselinesDir: string;
  /** Directory for weekly reference snapshot files (default: "baselines/weekly") */
  weeklyBaselinesDir: string;
  /** Retention window in calendar months; files older than this are archived (default: 6) */
  retentionMonths: number;
}

export const DEFAULT_CONFIG: CaptureConfig = {
  monthlyBaselinesDir: 'baselines',
  weeklyBaselinesDir: 'baselines/weekly',
  retentionMonths: 6,
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
