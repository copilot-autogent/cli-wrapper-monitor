import { describe, it, expect } from 'vitest';
import { buildDigestMessage, resolveLatestBaselinePair } from './weekly-digest.js';
import type { MetricSnapshot } from './types.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    monitorVersion: 'abc1234',
    sdkVersion: '^0.2.2',
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
          systemPromptChars: { value: 156_000, unit: 'chars', description: '' },
          systemPromptTokensEstimated: { value: 39_000, unit: 'tokens', description: '' },
          toolCount: { value: 21, unit: 'tools', description: '' },
        },
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildDigestMessage — stable (no regressions)
// ---------------------------------------------------------------------------

describe('buildDigestMessage — stable baseline', () => {
  it('includes the digest header with run date', () => {
    const snap = makeSnapshot();
    const msg = buildDigestMessage(snap, snap, '2026-07-07');
    expect(msg).toContain('📊 **CLI Wrapper Monitor — Weekly Digest** (2026-07-07)');
  });

  it('shows ✅ when no regressions', () => {
    const snap = makeSnapshot();
    const msg = buildDigestMessage(snap, snap, '2026-07-07');
    expect(msg).toContain('✅ No regressions detected');
  });

  it('includes tool count bullet', () => {
    const snap = makeSnapshot();
    const msg = buildDigestMessage(snap, snap, '2026-07-07');
    expect(msg).toContain('• Tools: 21');
  });

  it('includes hook count bullet with "stable" when unchanged', () => {
    const snap = makeSnapshot();
    const msg = buildDigestMessage(snap, snap, '2026-07-07');
    expect(msg).toContain('• Hooks: 3 (fingerprint stable)');
  });

  it('includes system prompt stats', () => {
    const snap = makeSnapshot();
    const msg = buildDigestMessage(snap, snap, '2026-07-07');
    expect(msg).toMatch(/• System prompt:.*156/);
    expect(msg).toMatch(/• System prompt:.*39/);
  });
});

// ---------------------------------------------------------------------------
// buildDigestMessage — BREAKING regression
// ---------------------------------------------------------------------------

describe('buildDigestMessage — BREAKING regression', () => {
  it('shows 🔴 when tool count drops', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 156_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 39_000, unit: 'tokens', description: '' },
            toolCount: { value: 10, unit: 'tools', description: '' }, // dropped from 21
          },
        },
      },
    });
    const msg = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('🔴');
    expect(msg).toMatch(/BREAKING/i);
  });
});

// ---------------------------------------------------------------------------
// buildDigestMessage — WARNING
// ---------------------------------------------------------------------------

describe('buildDigestMessage — WARNING (hook body change)', () => {
  it('shows 🟡 when hook body changes without count change', () => {
    const prior = makeSnapshot({ hookSourceHash: 'sha256:aaaa' });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb' });
    const msg = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('🟡');
  });

  it('shows hook fingerprint changed marker', () => {
    const prior = makeSnapshot({ hookSourceHash: 'sha256:aaaa' });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb' });
    const msg = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('fingerprint changed');
  });
});

// ---------------------------------------------------------------------------
// buildDigestMessage — null prior (first capture)
// ---------------------------------------------------------------------------

describe('buildDigestMessage — no prior baseline', () => {
  it('handles null prior gracefully', () => {
    const snap = makeSnapshot();
    const msg = buildDigestMessage(snap, null, '2026-07-07');
    expect(msg).toContain('✅ First baseline captured');
    expect(msg).not.toContain('🔴');
  });
});

// ---------------------------------------------------------------------------
// buildDigestMessage — headroom
// ---------------------------------------------------------------------------

describe('buildDigestMessage — headroom', () => {
  it('shows headroom percentage when contextWindowHeadroom is present', () => {
    const snap = makeSnapshot({
      contextWindowHeadroom: [
        {
          modelId: 'claude-sonnet',
          state: 'enabled',
          contextWindow: 200_000,
          systemPromptTokens: 40_000,
          headroomTokens: 160_000,
          promptFillPct: 20,
          status: 'ok',
        },
      ],
    });
    const msg = buildDigestMessage(snap, snap, '2026-07-07');
    expect(msg).toMatch(/Headroom.*80%/);
    expect(msg).toContain('✅');
  });

  it('shows ⚠️ when headroom is below 50%', () => {
    const snap = makeSnapshot({
      contextWindowHeadroom: [
        {
          modelId: 'claude-sonnet',
          state: 'enabled',
          contextWindow: 200_000,
          systemPromptTokens: 150_000,
          headroomTokens: 50_000,
          promptFillPct: 75,
          status: 'high-fill',
        },
      ],
    });
    const msg = buildDigestMessage(snap, snap, '2026-07-07');
    expect(msg).toContain('⚠️');
    expect(msg).toContain('below 50% threshold');
  });
});

// ---------------------------------------------------------------------------
// resolveLatestBaselinePair
// ---------------------------------------------------------------------------

describe('resolveLatestBaselinePair', () => {
  // Each test gets its own unique temp dir to ensure full isolation.
  function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'weekly-digest-test-'));
  }

  it('returns [null, latest] when only one file exists', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, '2026-01-01.json'), '{}');
      const [prior, latest] = resolveLatestBaselinePair(dir);
      expect(prior).toBeNull();
      expect(latest).toContain('2026-01-01.json');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('returns the two latest files sorted ascending', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, '2026-01-01.json'), '{}');
      writeFileSync(join(dir, '2026-02-01.json'), '{}');
      writeFileSync(join(dir, '2026-03-01.json'), '{}');
      const [prior, latest] = resolveLatestBaselinePair(dir);
      expect(prior).toContain('2026-02-01.json');
      expect(latest).toContain('2026-03-01.json');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('excludes schema.json and latest.json', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'schema.json'), '{}');
      writeFileSync(join(dir, 'latest.json'), '{}');
      writeFileSync(join(dir, '2026-05-01.json'), '{}');
      const [prior, latest] = resolveLatestBaselinePair(dir);
      expect(prior).toBeNull();
      expect(latest).toContain('2026-05-01.json');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('throws when no baseline files exist', () => {
    const dir = makeTmpDir();
    try {
      expect(() => resolveLatestBaselinePair(dir)).toThrow(/No baseline files found/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
