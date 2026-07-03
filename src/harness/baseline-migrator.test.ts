/**
 * Unit tests for the baseline schema migrator.
 */
import { describe, it, expect } from 'vitest';
import {
  migrate,
  isCurrent,
  effectiveSchemaVersion,
  CURRENT_SCHEMA_VERSION,
} from './baseline-migrator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal legacy baseline (no schemaVersion — implicitly "0.9") */
function legacyBaseline09(): Record<string, unknown> {
  return {
    capturedAt: '2026-06-03T12:00:00.000Z',
    monitorVersion: 'abc1234',
    sdkVersion: '^0.2.2',
    model: 'claude-sonnet-4.6',
    experiments: {
      'context-tax': {
        name: 'context-tax',
        description: 'Measures context overhead',
        metrics: {
          systemPromptChars: { value: 50000, unit: 'chars', description: 'System prompt length' },
        },
      },
    },
  };
}

/** Baseline already at version 1.0 */
function currentBaseline10(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    capturedAt: '2026-07-01T12:00:00.000Z',
    monitorVersion: 'def5678',
    sdkVersion: '^0.2.2',
    model: 'claude-sonnet-4.6',
    binaryHash: 'sha256:aabbcc',
    systemPromptHash: 'sha256:ddeeff',
    hookCount: 3,
    hookSourceHash: 'sha256:112233',
    modelPool: null,
    contextWindowHeadroom: null,
    possibleCauses: null,
    toolSchemas: null,
    toolSchemaHash: null,
    experiments: {
      'context-tax': {
        name: 'context-tax',
        description: 'Measures context overhead',
        metrics: {
          systemPromptChars: { value: 51000, unit: 'chars', description: 'System prompt length' },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// effectiveSchemaVersion
// ---------------------------------------------------------------------------

describe('effectiveSchemaVersion', () => {
  it('returns "0.9" for a baseline without schemaVersion', () => {
    expect(effectiveSchemaVersion(legacyBaseline09())).toBe('0.9');
  });

  it('returns "1.0" for a 1.0 baseline', () => {
    expect(effectiveSchemaVersion({ schemaVersion: '1.0' })).toBe('1.0');
  });

  it('returns "0.9" for unknown version (treats as legacy)', () => {
    expect(effectiveSchemaVersion({ schemaVersion: 'X.Y' })).toBe('0.9');
  });
});

// ---------------------------------------------------------------------------
// isCurrent
// ---------------------------------------------------------------------------

describe('isCurrent', () => {
  it('returns false for a legacy 0.9 baseline', () => {
    expect(isCurrent(legacyBaseline09())).toBe(false);
  });

  it('returns true for a 1.0 baseline', () => {
    expect(isCurrent(currentBaseline10())).toBe(true);
  });

  it('returns false for null', () => {
    expect(isCurrent(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// migrate — 0.9 → 1.0
// ---------------------------------------------------------------------------

describe('migrate 0.9 → 1.0', () => {
  it('sets schemaVersion to "1.0"', () => {
    const result = migrate(legacyBaseline09());
    expect(result.schemaVersion).toBe('1.0');
  });

  it('backfills null for binaryHash when absent', () => {
    const result = migrate(legacyBaseline09()) as unknown as Record<string, unknown>;
    expect(result['binaryHash']).toBeNull();
  });

  it('backfills null for systemPromptHash when absent', () => {
    const result = migrate(legacyBaseline09()) as unknown as Record<string, unknown>;
    expect(result['systemPromptHash']).toBeNull();
  });

  it('backfills null for hookCount when absent', () => {
    const result = migrate(legacyBaseline09()) as unknown as Record<string, unknown>;
    expect(result['hookCount']).toBeNull();
  });

  it('backfills null for hookSourceHash when absent', () => {
    const result = migrate(legacyBaseline09()) as unknown as Record<string, unknown>;
    expect(result['hookSourceHash']).toBeNull();
  });

  it('backfills null for modelPool when absent', () => {
    const result = migrate(legacyBaseline09()) as unknown as Record<string, unknown>;
    expect(result['modelPool']).toBeNull();
  });

  it('backfills null for contextWindowHeadroom when absent', () => {
    const result = migrate(legacyBaseline09()) as unknown as Record<string, unknown>;
    expect(result['contextWindowHeadroom']).toBeNull();
  });

  it('backfills null for possibleCauses when absent', () => {
    const result = migrate(legacyBaseline09()) as unknown as Record<string, unknown>;
    expect(result['possibleCauses']).toBeNull();
  });

  it('backfills null for toolSchemas when absent', () => {
    const result = migrate(legacyBaseline09()) as unknown as Record<string, unknown>;
    expect(result['toolSchemas']).toBeNull();
  });

  it('backfills null for toolSchemaHash when absent', () => {
    const result = migrate(legacyBaseline09()) as unknown as Record<string, unknown>;
    expect(result['toolSchemaHash']).toBeNull();
  });

  it('preserves existing experiment data', () => {
    const result = migrate(legacyBaseline09());
    expect(result.experiments['context-tax']).toBeDefined();
    expect(result.experiments['context-tax'].metrics['systemPromptChars'].value).toBe(50000);
  });

  it('does not overwrite existing binaryHash when present', () => {
    const baseline = { ...legacyBaseline09(), binaryHash: 'sha256:existing' };
    const result = migrate(baseline) as unknown as Record<string, unknown>;
    expect(result['binaryHash']).toBe('sha256:existing');
  });

  it('is idempotent: migrating twice produces the same result', () => {
    const once = migrate(legacyBaseline09());
    const twice = migrate(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('preserves capturedAt, monitorVersion, sdkVersion, model', () => {
    const result = migrate(legacyBaseline09());
    expect(result.capturedAt).toBe('2026-06-03T12:00:00.000Z');
    expect(result.monitorVersion).toBe('abc1234');
    expect(result.sdkVersion).toBe('^0.2.2');
    expect(result.model).toBe('claude-sonnet-4.6');
  });
});

// ---------------------------------------------------------------------------
// migrate — already at target version
// ---------------------------------------------------------------------------

describe('migrate — already at target', () => {
  it('is a no-op for a 1.0 baseline migrated to 1.0', () => {
    const baseline = currentBaseline10();
    const result = migrate(baseline, '1.0') as unknown as Record<string, unknown>;
    // schemaVersion must still be 1.0
    expect(result['schemaVersion']).toBe('1.0');
    // Existing fields must be unchanged
    expect(result['binaryHash']).toBe('sha256:aabbcc');
    expect(result['hookCount']).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// migrate — error cases
// ---------------------------------------------------------------------------

describe('migrate — error cases', () => {
  it('throws for unknown target version', () => {
    expect(() => migrate(legacyBaseline09(), 'X.Y')).toThrow(/Unknown target schema version/);
  });

  it('throws for null input', () => {
    expect(() => migrate(null)).toThrow(/must be a non-null JSON object/);
  });

  it('throws for array input', () => {
    expect(() => migrate([])).toThrow(/must be a non-null JSON object/);
  });

  it('throws for string input', () => {
    expect(() => migrate('not-a-baseline')).toThrow(/must be a non-null JSON object/);
  });
});

// ---------------------------------------------------------------------------
// CURRENT_SCHEMA_VERSION constant
// ---------------------------------------------------------------------------

describe('CURRENT_SCHEMA_VERSION', () => {
  it('is "1.0"', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe('1.0');
  });
});
