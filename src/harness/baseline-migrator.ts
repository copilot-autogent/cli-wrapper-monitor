/**
 * Baseline schema versioning and migration.
 *
 * Each baseline carries a `schemaVersion` field.  Baselines without the field
 * are treated as version "0.9" (pre-versioning legacy).
 *
 * The `migrate` function applies forward migrations in sequence until the
 * baseline is at the requested target version.  Migrations are idempotent:
 * running them twice produces the same result.
 */

import type { MetricSnapshot } from './types.js';

/** Current (latest) schema version written by new captures. */
export const CURRENT_SCHEMA_VERSION = '1.0';

/** Versions known to this migrator, in ascending order. */
const VERSION_ORDER: readonly string[] = ['0.9', '1.0'];

/** A loosely-typed baseline that may be missing versioning fields. */
type RawBaseline = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Individual migration steps
// ---------------------------------------------------------------------------

/**
 * 0.9 → 1.0
 *
 * Adds `schemaVersion` and backfills `null` for fields introduced after 0.9:
 *   - `binaryHash`, `systemPromptHash`, `hookCount`, `hookSourceHash`,
 *     `modelPool`, `contextWindowHeadroom`, `possibleCauses`,
 *     `toolSchemas`, `toolSchemaHash`
 *
 * The `null` backfill strategy is intentional: old baselines must not
 * fabricate data for metrics they never measured.
 */
function migrate09to10(baseline: RawBaseline): RawBaseline {
  const out = { ...baseline, schemaVersion: '1.0' };

  // Backfill optional fields that were introduced after "0.9"
  const newFields: string[] = [
    'binaryHash',
    'systemPromptHash',
    'hookCount',
    'hookSourceHash',
    'modelPool',
    'contextWindowHeadroom',
    'possibleCauses',
    'toolSchemas',
    'toolSchemaHash',
  ];

  for (const field of newFields) {
    if (!(field in out)) {
      // Explicitly set to null so diff tools can distinguish "absent" from
      // "captured as null" (e.g. hook source unavailable).
      (out as Record<string, unknown>)[field] = null;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Version comparator
// ---------------------------------------------------------------------------

/** Returns the index of `version` in VERSION_ORDER, or -1 if unknown. */
function versionIndex(version: string): number {
  return VERSION_ORDER.indexOf(version);
}

/**
 * Determine the effective schema version of a raw baseline object.
 *
 * - Missing or non-string `schemaVersion` → "0.9" (legacy, pre-versioning).
 * - A string value that is NOT in VERSION_ORDER (e.g. a future "1.1") →
 *   throws, because silently treating it as 0.9 would corrupt newer fields.
 */
export function effectiveSchemaVersion(baseline: RawBaseline): string {
  const v = baseline['schemaVersion'];
  if (v === undefined || v === null) return '0.9';
  if (typeof v !== 'string') return '0.9';
  if (versionIndex(v) !== -1) return v;
  throw new Error(
    `Unrecognised schemaVersion "${v}". This baseline was produced by a newer version of the migrator. ` +
    `Known versions: ${VERSION_ORDER.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Migrate a raw baseline object (parsed JSON, unknown schema) to
 * `targetVersion`, applying each intermediate migration step in sequence.
 *
 * Throws if `targetVersion` is not a known version.
 *
 * Returns the migrated object cast to `MetricSnapshot`.  The caller is
 * responsible for validating the result if strict correctness is required.
 */
export function migrate(
  baseline: unknown,
  targetVersion: string = CURRENT_SCHEMA_VERSION,
): MetricSnapshot {
  if (versionIndex(targetVersion) === -1) {
    throw new Error(
      `Unknown target schema version "${targetVersion}". Known versions: ${VERSION_ORDER.join(', ')}`,
    );
  }

  let current = (
    baseline !== null && typeof baseline === 'object' && !Array.isArray(baseline)
      ? { ...(baseline as RawBaseline) }
      : (() => { throw new Error('Baseline must be a non-null JSON object'); })()
  ) as RawBaseline;

  const from = effectiveSchemaVersion(current);
  const fromIdx = versionIndex(from);
  const toIdx = versionIndex(targetVersion);

  if (toIdx < fromIdx) {
    throw new Error(
      `Cannot downgrade baseline from schema version "${from}" to "${targetVersion}". ` +
      `Downgrades are not supported.`,
    );
  }

  // Apply each step between current and target.
  // steps[i] is the migration from VERSION_ORDER[i] to VERSION_ORDER[i+1].
  // If a step is missing in the array, throw rather than silently skip.
  const steps: Array<(b: RawBaseline) => RawBaseline> = [
    migrate09to10, // 0.9 → 1.0  (index 0→1)
  ];

  for (let i = fromIdx; i < toIdx; i++) {
    const step = steps[i];
    if (!step) {
      throw new Error(
        `No migration step defined for ${VERSION_ORDER[i]} → ${VERSION_ORDER[i + 1]}. ` +
        `This is a bug in the migrator.`,
      );
    }
    current = step(current);
  }

  return current as unknown as MetricSnapshot;
}

/**
 * Returns true when the baseline already matches `targetVersion` and no
 * migration is needed.
 */
export function isCurrent(
  baseline: unknown,
  targetVersion: string = CURRENT_SCHEMA_VERSION,
): boolean {
  if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return false;
  }
  return effectiveSchemaVersion(baseline as RawBaseline) === targetVersion;
}
