import { describe, it, expect } from 'vitest';
import {
  computeSizeDelta,
  formatSizeDeltaTable,
  SIZE_ALERT_THRESHOLD_PCT,
} from './size-delta.js';
import type { MetricSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(
  systemPromptChars: number,
  tokens: number,
  toolCount: number,
  capturedAt = '2026-01-01T00:00:00.000Z',
): MetricSnapshot {
  return {
    capturedAt,
    monitorVersion: 'abc1234',
    sdkVersion: '^0.2.0',
    model: 'claude-opus-4.6',
    experiments: {
      'context-tax': {
        name: 'context-tax',
        description: 'test',
        metrics: {
          systemPromptChars: { value: systemPromptChars, unit: 'chars', description: '' },
          systemPromptTokensEstimated: { value: tokens, unit: 'tokens', description: '' },
          toolCount: { value: toolCount, unit: 'tools', description: '' },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// computeSizeDelta
// ---------------------------------------------------------------------------

describe('computeSizeDelta', () => {
  it('returns null deltas when no prior baseline', () => {
    const current = makeSnapshot(100_000, 25_000, 10);
    const result = computeSizeDelta(current, null);

    expect(result.previousCapturedAt).toBeNull();
    expect(result.hasAlert).toBe(false);
    for (const m of result.metrics) {
      expect(m.deltaAbsolute).toBeNull();
      expect(m.deltaPct).toBeNull();
      expect(m.alert).toBe(false);
      expect(m.previous).toBeNull();
    }
  });

  it('computes correct absolute delta and percentage', () => {
    const latest = makeSnapshot(100_000, 25_000, 10, '2026-01-01T00:00:00.000Z');
    const current = makeSnapshot(105_000, 26_250, 10, '2026-02-01T00:00:00.000Z');

    const result = computeSizeDelta(current, latest);

    const chars = result.metrics.find((m) => m.key === 'systemPromptChars')!;
    expect(chars.current).toBe(105_000);
    expect(chars.previous).toBe(100_000);
    expect(chars.deltaAbsolute).toBe(5_000);
    expect(chars.deltaPct).toBeCloseTo(5, 1);
    expect(chars.alert).toBe(false); // 5% < 10% threshold
  });

  it('sets alert flag when systemPromptChars grows > 10%', () => {
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(111_001, 27_750, 10); // +11.001%

    const result = computeSizeDelta(current, latest);

    const chars = result.metrics.find((m) => m.key === 'systemPromptChars')!;
    expect(chars.alert).toBe(true);
    expect(result.hasAlert).toBe(true);
  });

  it('does NOT alert at exactly the threshold', () => {
    // Strictly greater than 10%, so exactly 10% should NOT trigger
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(110_000, 27_500, 10); // exactly +10%

    const result = computeSizeDelta(current, latest);

    const chars = result.metrics.find((m) => m.key === 'systemPromptChars')!;
    expect(chars.alert).toBe(false);
    expect(result.hasAlert).toBe(false);
  });

  it('alerts on decrease > threshold too', () => {
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(88_000, 22_000, 10); // -12%

    const result = computeSizeDelta(current, latest);

    const chars = result.metrics.find((m) => m.key === 'systemPromptChars')!;
    expect(chars.alert).toBe(true);
    expect(result.hasAlert).toBe(true);
  });

  it('reports previousCapturedAt from latest baseline', () => {
    const latest = makeSnapshot(100_000, 25_000, 10, '2026-05-01T12:00:00.000Z');
    const current = makeSnapshot(100_000, 25_000, 10, '2026-06-01T12:00:00.000Z');

    const result = computeSizeDelta(current, latest);

    expect(result.previousCapturedAt).toBe('2026-05-01T12:00:00.000Z');
  });

  it('tracks all three key metrics', () => {
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(100_000, 25_000, 10);

    const result = computeSizeDelta(current, latest);

    const keys = result.metrics.map((m) => m.key);
    expect(keys).toContain('systemPromptChars');
    expect(keys).toContain('systemPromptTokensEstimated');
    expect(keys).toContain('toolCount');
  });

  it('handles missing context-tax experiment gracefully', () => {
    const snapshotNoExp: MetricSnapshot = {
      capturedAt: '2026-06-01T00:00:00.000Z',
      monitorVersion: 'abc',
      sdkVersion: '^0.2.0',
      model: 'claude',
      experiments: {},
    };

    expect(() => computeSizeDelta(snapshotNoExp, null)).not.toThrow();
    const result = computeSizeDelta(snapshotNoExp, null);
    expect(result.hasAlert).toBe(false);
    for (const m of result.metrics) {
      expect(m.current).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// formatSizeDeltaTable
// ---------------------------------------------------------------------------

describe('formatSizeDeltaTable', () => {
  it('includes SIZE ALERT text when hasAlert is true', () => {
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(120_000, 30_000, 10); // +20%

    const result = computeSizeDelta(current, latest);
    const table = formatSizeDeltaTable(result);

    expect(result.hasAlert).toBe(true);
    expect(table).toContain('SIZE ALERT');
    expect(table).toContain('⚠️');
  });

  it('does NOT include SIZE ALERT when growth is within threshold', () => {
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(105_000, 26_000, 10); // +5%

    const result = computeSizeDelta(current, latest);
    const table = formatSizeDeltaTable(result);

    expect(result.hasAlert).toBe(false);
    expect(table).not.toContain('SIZE ALERT');
  });

  it('shows "no prior baseline" label when latest is null', () => {
    const current = makeSnapshot(100_000, 25_000, 10);
    const result = computeSizeDelta(current, null);
    const table = formatSizeDeltaTable(result);

    expect(table).toContain('no prior baseline');
  });

  it('includes the comparison date in the header', () => {
    const latest = makeSnapshot(100_000, 25_000, 10, '2026-05-20T10:00:00.000Z');
    const current = makeSnapshot(100_000, 25_000, 10, '2026-06-03T10:00:00.000Z');

    const result = computeSizeDelta(current, latest);
    const table = formatSizeDeltaTable(result);

    expect(table).toContain('2026-05-20');
  });

  it('shows the delta percentage in the since-last column', () => {
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(105_000, 26_250, 10); // +5%

    const result = computeSizeDelta(current, latest);
    const table = formatSizeDeltaTable(result);

    expect(table).toContain('+5,000');
    expect(table).toContain('+5.0%');
  });

  it('exports SIZE_ALERT_THRESHOLD_PCT as a public constant', () => {
    expect(SIZE_ALERT_THRESHOLD_PCT).toBe(10);
  });
});
