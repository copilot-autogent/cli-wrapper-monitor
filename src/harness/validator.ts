/**
 * Baseline integrity validator.
 *
 * Validates that a MetricSnapshot JSON object conforms to the expected schema:
 *   - Required top-level keys are present with correct types
 *   - `capturedAt` is a valid ISO 8601 date-time string
 *   - No NaN or null in numeric metric values
 *   - Experiment entries have the required structure
 */

import { readFileSync } from 'fs';

export interface ValidationError {
  /** Human-readable description of what failed */
  message: string;
  /** Dot-path to the offending field (e.g. "experiments.context-tax.metrics.toolCount.value") */
  field: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const REQUIRED_TOP_LEVEL: Record<string, string> = {
  capturedAt: 'string',
  monitorVersion: 'string',
  sdkVersion: 'string',
  model: 'string',
  experiments: 'object',
};

function isValidIso8601(value: string): boolean {
  // Require full datetime with explicit timezone (Z or ±HH:MM), anchored at both ends.
  // This rejects bare dates, bare times, and strings with trailing junk.
  const m = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
  );
  if (!m) return false;

  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const second = parseInt(m[6], 10);

  // Basic component range checks
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  // Detect impossible calendar dates (e.g. Feb 31) via Date.UTC round-trip.
  // Using Date.UTC avoids local timezone interference; we compare the UTC
  // components produced by treating the extracted values as if they were UTC.
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    !isNaN(d.getTime()) &&
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day &&
    d.getUTCHours() === hour &&
    d.getUTCMinutes() === minute &&
    d.getUTCSeconds() === second
  );
}

/**
 * Validate a single parsed baseline object.
 * Returns a ValidationResult describing all errors found (or none if valid).
 */
export function validateSnapshot(data: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: [{ field: '<root>', message: 'Baseline must be a JSON object' }] };
  }

  const obj = data as Record<string, unknown>;

  // Check required top-level keys and their types
  for (const [key, expectedType] of Object.entries(REQUIRED_TOP_LEVEL)) {
    if (!(key in obj)) {
      errors.push({ field: key, message: `Missing required field "${key}"` });
      continue;
    }
    const val = obj[key];
    if (expectedType === 'object') {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) {
        errors.push({ field: key, message: `Field "${key}" must be a non-null object, got ${val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val}` });
      }
    } else {
      if (typeof val !== expectedType) {
        errors.push({ field: key, message: `Field "${key}" must be of type ${expectedType}, got ${typeof val}` });
      }
    }
  }

  // Validate capturedAt is a valid ISO 8601 date
  if (typeof obj.capturedAt === 'string' && !isValidIso8601(obj.capturedAt)) {
    errors.push({ field: 'capturedAt', message: `Field "capturedAt" is not a valid ISO 8601 date-time: "${obj.capturedAt}"` });
  }

  // Validate experiments structure
  if (obj.experiments !== null && typeof obj.experiments === 'object' && !Array.isArray(obj.experiments)) {
    const experiments = obj.experiments as Record<string, unknown>;
    for (const [expName, expEntry] of Object.entries(experiments)) {
      const expPath = `experiments.${expName}`;
      if (expEntry === null || typeof expEntry !== 'object' || Array.isArray(expEntry)) {
        errors.push({ field: expPath, message: `Experiment "${expName}" must be a non-null object` });
        continue;
      }
      const exp = expEntry as Record<string, unknown>;

      for (const required of ['name', 'description', 'metrics']) {
        if (!(required in exp)) {
          errors.push({ field: `${expPath}.${required}`, message: `Experiment "${expName}" is missing required field "${required}"` });
        } else if (required !== 'metrics' && typeof exp[required] !== 'string') {
          errors.push({ field: `${expPath}.${required}`, message: `Experiment "${expName}.${required}" must be a string, got ${typeof exp[required]}` });
        }
      }

      // Validate metrics
      if (exp.metrics !== null && typeof exp.metrics === 'object' && !Array.isArray(exp.metrics)) {
        const metrics = exp.metrics as Record<string, unknown>;
        for (const [metricName, metricEntry] of Object.entries(metrics)) {
          const metricPath = `${expPath}.metrics.${metricName}`;
          if (metricEntry === null || typeof metricEntry !== 'object' || Array.isArray(metricEntry)) {
            errors.push({ field: metricPath, message: `Metric "${metricName}" must be a non-null object` });
            continue;
          }
          const metric = metricEntry as Record<string, unknown>;

          for (const required of ['value', 'unit', 'description']) {
            if (!(required in metric)) {
              errors.push({ field: `${metricPath}.${required}`, message: `Metric "${metricName}" is missing required field "${required}"` });
            } else if (required !== 'value' && typeof metric[required] !== 'string') {
              errors.push({ field: `${metricPath}.${required}`, message: `Metric "${metricName}.${required}" must be a string, got ${typeof metric[required]}` });
            }
          }

          // Check numeric value is not NaN or null (only if present)
          if ('value' in metric) {
            const value = metric.value;
            if (typeof value !== 'number') {
              errors.push({ field: `${metricPath}.value`, message: `Metric "${metricName}.value" must be a number, got ${value === null ? 'null' : typeof value}` });
            } else if (isNaN(value)) {
              errors.push({ field: `${metricPath}.value`, message: `Metric "${metricName}.value" is NaN` });
            }
          }
        }
      } else if ('metrics' in exp && (exp.metrics === null || typeof exp.metrics !== 'object' || Array.isArray(exp.metrics))) {
        errors.push({ field: `${expPath}.metrics`, message: `Experiment "${expName}.metrics" must be a non-null object` });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a single baseline file given its path.
 * Returns a ValidationResult describing all errors found (or none if valid).
 */
export function validateBaselineFile(filePath: string): ValidationResult {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { valid: false, errors: [{ field: '<file>', message: `Cannot read file: ${String(err)}` }] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { valid: false, errors: [{ field: '<json>', message: `Invalid JSON: ${String(err)}` }] };
  }

  return validateSnapshot(parsed);
}
