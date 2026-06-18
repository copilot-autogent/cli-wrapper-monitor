import { describe, it, expect } from 'vitest';
import { diffSnapshots, formatDiffReport } from './diff.js';
import type { MetricSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    monitorVersion: 'abc1234',
    sdkVersion: '^0.2.0',
    model: 'claude-sonnet-4.6',
    binaryHash: 'sha256:aabbcc',
    systemPromptHash: 'sha256:ddeeff',
    hookCount: 3,
    hookSourceHash: 'sha256:112233',
    experiments: {
      'context-tax': {
        name: 'context-tax',
        description: 'test',
        metrics: {
          systemPromptChars: { value: 100_000, unit: 'chars', description: '' },
          toolCount: { value: 10, unit: 'tools', description: '' },
        },
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// hookChanged
// ---------------------------------------------------------------------------

describe('diffSnapshots — hookChanged', () => {
  it('is false when hook hashes are identical', () => {
    const baseline = makeSnapshot();
    const current = makeSnapshot();
    const diff = diffSnapshots(baseline, current);
    expect(diff.hookChanged).toBe(false);
  });

  it('is true when hookSourceHash differs', () => {
    const baseline = makeSnapshot({ hookSourceHash: 'sha256:aaaa' });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb' });
    const diff = diffSnapshots(baseline, current);
    expect(diff.hookChanged).toBe(true);
  });

  it('is false when either hash is "unknown"', () => {
    const baseline = makeSnapshot({ hookSourceHash: 'unknown' });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb' });
    expect(diffSnapshots(baseline, current).hookChanged).toBe(false);

    const baseline2 = makeSnapshot({ hookSourceHash: 'sha256:aaaa' });
    const current2 = makeSnapshot({ hookSourceHash: 'unknown' });
    expect(diffSnapshots(baseline2, current2).hookChanged).toBe(false);
  });

  it('is false when hookSourceHash is absent on either snapshot', () => {
    const baseline = makeSnapshot({ hookSourceHash: undefined });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb' });
    expect(diffSnapshots(baseline, current).hookChanged).toBe(false);

    const baseline2 = makeSnapshot({ hookSourceHash: 'sha256:aaaa' });
    const current2 = makeSnapshot({ hookSourceHash: undefined });
    expect(diffSnapshots(baseline2, current2).hookChanged).toBe(false);
  });

  it('is false when both hashes are absent (old baseline without hook tracking)', () => {
    const baseline = makeSnapshot({ hookSourceHash: undefined, hookCount: undefined });
    const current = makeSnapshot({ hookSourceHash: undefined, hookCount: undefined });
    expect(diffSnapshots(baseline, current).hookChanged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatDiffReport — hook change rendering
// ---------------------------------------------------------------------------

describe('formatDiffReport — hook change', () => {
  it('includes hook-changed warning when hookChanged is true', () => {
    const baseline = makeSnapshot({ hookSourceHash: 'sha256:aaaabbbbcccc' });
    const current = makeSnapshot({ hookSourceHash: 'sha256:ddddeeeeffffgg', hookCount: 2 });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('Hook definitions changed');
    // formatDiffReport uses slice(0, 8) — full strings are longer, so check prefix
    expect(report).toContain('sha256:a');
    expect(report).toContain('sha256:d');
  });

  it('includes count delta when hookCount changes', () => {
    const baseline = makeSnapshot({ hookSourceHash: 'sha256:aaaa1234', hookCount: 3 });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb5678', hookCount: 2 });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('count: 3 → 2');
  });

  it('omits count delta note when hookCount is unchanged', () => {
    const baseline = makeSnapshot({ hookSourceHash: 'sha256:aaaa1234', hookCount: 3 });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb5678', hookCount: 3 });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('Hook definitions changed');
    expect(report).not.toContain('count:');
  });

  it('does not include hook-changed warning when hashes are identical', () => {
    const baseline = makeSnapshot();
    const current = makeSnapshot();
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).not.toContain('Hook definitions changed');
  });
});

// ---------------------------------------------------------------------------
// binaryChanged / systemPromptChanged (regression guard)
// ---------------------------------------------------------------------------

describe('diffSnapshots — other hash tracking', () => {
  it('detects binary hash change', () => {
    const baseline = makeSnapshot({ binaryHash: 'sha256:aaaa' });
    const current = makeSnapshot({ binaryHash: 'sha256:bbbb' });
    expect(diffSnapshots(baseline, current).binaryChanged).toBe(true);
  });

  it('detects system prompt hash change', () => {
    const baseline = makeSnapshot({ systemPromptHash: 'sha256:aaaa' });
    const current = makeSnapshot({ systemPromptHash: 'sha256:bbbb' });
    expect(diffSnapshots(baseline, current).systemPromptChanged).toBe(true);
  });
});
