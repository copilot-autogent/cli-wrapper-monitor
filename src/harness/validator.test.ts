/**
 * Unit tests for the baseline integrity validator.
 */
import { describe, it, expect, vi } from 'vitest';
import { validateSnapshot, validateBaselineFile } from './validator.js';

// Minimal valid MetricSnapshot for use in tests
function validSnapshot(): Record<string, unknown> {
  return {
    capturedAt: '2026-05-20T17:00:00.000Z',
    monitorVersion: 'abc1234',
    sdkVersion: '^0.2.2',
    model: 'claude-sonnet-4.6',
    experiments: {
      'context-tax': {
        name: 'context-tax',
        description: 'Measures context overhead',
        metrics: {
          systemPromptChars: { value: 56963, unit: 'chars', description: 'System prompt length' },
          toolCount: { value: 29, unit: 'tools', description: 'Number of tools' },
        },
      },
    },
  };
}

describe('validateSnapshot', () => {
  it('accepts a fully valid snapshot', () => {
    const result = validateSnapshot(validSnapshot());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a snapshot with no experiments (empty object)', () => {
    const snap = { ...validSnapshot(), experiments: {} };
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(true);
  });

  it('rejects non-object input (array)', () => {
    const result = validateSnapshot([]);
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('<root>');
  });

  it('rejects null input', () => {
    const result = validateSnapshot(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('<root>');
  });

  // Missing required fields
  it('fails when capturedAt is missing', () => {
    const snap = validSnapshot();
    delete snap.capturedAt;
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'capturedAt')).toBe(true);
  });

  it('fails when monitorVersion is missing', () => {
    const snap = validSnapshot();
    delete snap.monitorVersion;
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'monitorVersion')).toBe(true);
  });

  it('fails when sdkVersion is missing', () => {
    const snap = validSnapshot();
    delete snap.sdkVersion;
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'sdkVersion')).toBe(true);
  });

  it('fails when model is missing', () => {
    const snap = validSnapshot();
    delete snap.model;
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'model')).toBe(true);
  });

  it('fails when experiments is missing', () => {
    const snap = validSnapshot();
    delete snap.experiments;
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'experiments')).toBe(true);
  });

  // Wrong types
  it('fails when capturedAt is a number', () => {
    const snap = { ...validSnapshot(), capturedAt: 123 };
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'capturedAt')).toBe(true);
  });

  it('fails when experiments is an array', () => {
    const snap = { ...validSnapshot(), experiments: [] };
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'experiments')).toBe(true);
  });

  it('fails when experiments is null', () => {
    const snap = { ...validSnapshot(), experiments: null };
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'experiments')).toBe(true);
  });

  // ISO 8601 validation
  it('fails when capturedAt is not a valid ISO 8601 date', () => {
    const snap = { ...validSnapshot(), capturedAt: '2026-13-45' };
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'capturedAt')).toBe(true);
  });

  it('accepts a valid ISO 8601 date with timezone offset', () => {
    const snap = { ...validSnapshot(), capturedAt: '2026-05-20T17:00:00+05:30' };
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(true);
  });

  it('accepts a valid ISO 8601 date with negative offset crossing UTC day boundary', () => {
    const snap = { ...validSnapshot(), capturedAt: '2026-05-20T23:30:00-02:00' };
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(true);
  });

  it('fails when capturedAt has trailing junk after a valid datetime prefix', () => {
    const snap = { ...validSnapshot(), capturedAt: '2026-05-20T17:00:00junk' };
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'capturedAt')).toBe(true);
  });

  it('fails when capturedAt is missing timezone designator', () => {
    const snap = { ...validSnapshot(), capturedAt: '2026-05-20T17:00:00' };
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'capturedAt')).toBe(true);
  });

  it('fails when capturedAt has an out-of-range timezone offset', () => {
    const snap = { ...validSnapshot(), capturedAt: '2026-05-20T17:00:00+99:99' };
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'capturedAt')).toBe(true);
  });

  // NaN / null in numeric fields
  it('fails when a metric value is NaN (serialized as null in JSON)', () => {
    const snap = validSnapshot();
    const exp = snap.experiments as Record<string, unknown>;
    const metrics = (exp['context-tax'] as Record<string, unknown>).metrics as Record<string, unknown>;
    metrics['toolCount'] = { value: null, unit: 'tools', description: 'Tool count' };
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    const valueError = result.errors.find((e) => e.field.endsWith('.value'));
    expect(valueError).toBeDefined();
  });

  it('fails when a metric value is a string instead of number', () => {
    const snap = validSnapshot();
    const exp = snap.experiments as Record<string, unknown>;
    const metrics = (exp['context-tax'] as Record<string, unknown>).metrics as Record<string, unknown>;
    metrics['toolCount'] = { value: 'twenty-nine', unit: 'tools', description: 'Tool count' };
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    const valueError = result.errors.find((e) => e.field.endsWith('.value'));
    expect(valueError).toBeDefined();
  });

  // Missing metric sub-fields
  it('fails when a metric is missing the "unit" field', () => {
    const snap = validSnapshot();
    const exp = snap.experiments as Record<string, unknown>;
    const metrics = (exp['context-tax'] as Record<string, unknown>).metrics as Record<string, unknown>;
    metrics['toolCount'] = { value: 29, description: 'Tool count' }; // no unit
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.includes('unit'))).toBe(true);
  });

  // Missing experiment sub-fields
  it('fails when an experiment is missing the "name" field', () => {
    const snap = validSnapshot();
    const exp = snap.experiments as Record<string, unknown>;
    const ctax = exp['context-tax'] as Record<string, unknown>;
    delete ctax.name;
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.endsWith('.name'))).toBe(true);
  });

  it('reports multiple errors at once', () => {
    const snap = validSnapshot();
    delete snap.capturedAt;
    delete snap.model;
    const result = validateSnapshot(snap);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ── validateBaselineFile ─────────────────────────────────────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn().mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('valid.json')) {
        return JSON.stringify({
          capturedAt: '2026-05-20T17:00:00.000Z',
          monitorVersion: 'abc1234',
          sdkVersion: '^0.2.2',
          model: 'claude-sonnet-4.6',
          experiments: {},
        });
      }
      if (path.endsWith('missing-field.json')) {
        return JSON.stringify({
          monitorVersion: 'abc1234',
          sdkVersion: '^0.2.2',
          model: 'claude-sonnet-4.6',
          experiments: {},
          // capturedAt is missing
        });
      }
      if (path.endsWith('bad-json.json')) {
        return '{ invalid json ;;;';
      }
      if (path.endsWith('missing.json')) {
        const err = Object.assign(new Error(`ENOENT: no such file: ${path}`), { code: 'ENOENT' });
        throw err;
      }
      return actual.readFileSync(path, 'utf-8');
    }),
  };
});

describe('validateBaselineFile', () => {
  it('returns valid=true for a valid baseline file', () => {
    const result = validateBaselineFile('/baselines/valid.json');
    expect(result.valid).toBe(true);
  });

  it('returns valid=false with a clear error when a required field is missing', () => {
    const result = validateBaselineFile('/baselines/missing-field.json');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'capturedAt')).toBe(true);
    expect(result.errors[0].message).toMatch(/capturedAt/);
  });

  it('returns valid=false with a JSON parse error for malformed files', () => {
    const result = validateBaselineFile('/baselines/bad-json.json');
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('<json>');
  });

  it('returns valid=false when the file cannot be read', () => {
    const result = validateBaselineFile('/baselines/missing.json');
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('<file>');
  });
});
