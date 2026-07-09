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
  // Use systemPromptHash diff to force CHANGE tier (no regressions, but drift detected)
  // so metric bullets still appear in the verbose format.
  function makeChangePair() {
    return {
      prior: makeSnapshot({ systemPromptHash: 'sha256:aaaa' }),
      current: makeSnapshot({ systemPromptHash: 'sha256:bbbb' }),
    };
  }

  it('includes the digest header with run date', () => {
    const { prior, current } = makeChangePair();
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('📊 **CLI Wrapper Monitor — Weekly Digest** (2026-07-07)');
  });

  it('shows ✅ when no regressions', () => {
    const { prior, current } = makeChangePair();
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('✅ No regressions detected');
  });

  it('includes tool count bullet', () => {
    const { prior, current } = makeChangePair();
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('• Tools: 21');
  });

  it('includes hook count bullet with "stable" when unchanged', () => {
    const { prior, current } = makeChangePair();
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('• Hooks: 3 (fingerprint stable)');
  });

  it('includes system prompt stats', () => {
    const { prior, current } = makeChangePair();
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toMatch(/• System prompt:.*156/);
    expect(msg).toMatch(/• System prompt:.*39/);
  });

  it('produces single-line stable message when truly nothing changed', () => {
    const snap = makeSnapshot();
    const { message: msg, tier } = buildDigestMessage(snap, snap, '2026-07-07');
    expect(tier).toBe('stable');
    expect(msg).toMatch(/✅ Stable — no significant changes detected \(2026-07-07\)/);
    expect(msg).not.toContain('• Tools:');
  });
});

// ---------------------------------------------------------------------------
// buildDigestMessage — BREAKING regression
// ---------------------------------------------------------------------------

describe('buildDigestMessage — BREAKING regression', () => {
  it('classifies as ALERT (🚨) when tool count drops', () => {
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
    const { message: msg, tier } = buildDigestMessage(current, prior, '2026-07-07');
    // A tool count change is an ALERT condition — 🚨 is the stronger regression signal
    expect(tier).toBe('alert');
    expect(msg).toContain('🚨');
    expect(msg).toContain('ALERT');
  });
});

// ---------------------------------------------------------------------------
// buildDigestMessage — WARNING
// ---------------------------------------------------------------------------

describe('buildDigestMessage — WARNING (hook body change)', () => {
  it('shows 🟡 when hook body changes without count change', () => {
    const prior = makeSnapshot({ hookSourceHash: 'sha256:aaaa' });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb' });
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('🟡');
  });

  it('shows hook fingerprint changed marker', () => {
    const prior = makeSnapshot({ hookSourceHash: 'sha256:aaaa' });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb' });
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('fingerprint changed');
  });
});

// ---------------------------------------------------------------------------
// buildDigestMessage — null prior (first capture)
// ---------------------------------------------------------------------------

describe('buildDigestMessage — no prior baseline', () => {
  it('handles null prior gracefully', () => {
    const snap = makeSnapshot();
    const { message: msg } = buildDigestMessage(snap, null, '2026-07-07');
    expect(msg).toContain('✅ First baseline captured');
    expect(msg).not.toContain('🔴');
  });
});

// ---------------------------------------------------------------------------
// buildDigestMessage — headroom
// ---------------------------------------------------------------------------

describe('buildDigestMessage — headroom', () => {
  it('shows headroom percentage when contextWindowHeadroom is present', () => {
    const headroom = [
      {
        modelId: 'claude-sonnet',
        state: 'enabled',
        contextWindow: 200_000,
        systemPromptTokens: 40_000,
        headroomTokens: 160_000,
        promptFillPct: 20,
        status: 'ok' as const,
      },
    ];
    const prior = makeSnapshot({ systemPromptHash: 'sha256:aaaa', contextWindowHeadroom: headroom });
    const current = makeSnapshot({ systemPromptHash: 'sha256:bbbb', contextWindowHeadroom: headroom });
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toMatch(/Headroom.*80%/);
    expect(msg).toContain('✅');
  });

  it('shows ⚠️ when headroom is below 50%', () => {
    const prior = makeSnapshot({ systemPromptHash: 'sha256:aaaa', contextWindowHeadroom: [{
      modelId: 'claude-sonnet',
      state: 'enabled',
      contextWindow: 200_000,
      systemPromptTokens: 150_000,
      headroomTokens: 50_000,
      promptFillPct: 75,
      status: 'high-fill' as const,
    }] });
    const current = makeSnapshot({ systemPromptHash: 'sha256:bbbb', contextWindowHeadroom: [{
      modelId: 'claude-sonnet',
      state: 'enabled',
      contextWindow: 200_000,
      systemPromptTokens: 150_000,
      headroomTokens: 50_000,
      promptFillPct: 75,
      status: 'high-fill' as const,
    }] });
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('⚠️');
    expect(msg).toContain('below 50% threshold');
  });
});

// ---------------------------------------------------------------------------
// buildDigestMessage — section changes (section-diff-present path)
// ---------------------------------------------------------------------------

describe('buildDigestMessage — section changes present', () => {
  it('includes "Section changes:" block when a section grew', () => {
    const prior = makeSnapshot({
      promptSections: [
        { name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 },
        { name: 'Introduction', charCount: 5_000, tokenEstimate: 1_250 },
      ],
    });
    const current = makeSnapshot({
      promptSections: [
        { name: 'Tools', charCount: 12_000, tokenEstimate: 3_000 }, // +2000 chars
        { name: 'Introduction', charCount: 5_000, tokenEstimate: 1_250 },
      ],
    });
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('**Section changes:**');
    expect(msg).toContain('• Tools:');
    expect(msg).toContain('+2,000 chars');
  });

  it('includes delta percentage when baseline section is present', () => {
    const prior = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 }],
    });
    const current = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 11_000, tokenEstimate: 2_750 }],
    });
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('+10.0%');
  });

  it('shows "new" for a section that did not exist in prior baseline', () => {
    const prior = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 }],
    });
    const current = makeSnapshot({
      promptSections: [
        { name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 },
        { name: 'Safety', charCount: 2_000, tokenEstimate: 500 },
      ],
    });
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('Safety');
    expect(msg).toContain('new');
  });

  it('shows "removed" for a section that no longer exists in current', () => {
    const prior = makeSnapshot({
      promptSections: [
        { name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 },
        { name: 'Safety', charCount: 2_000, tokenEstimate: 500 },
      ],
    });
    const current = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 }],
    });
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('Safety');
    expect(msg).toContain('removed');
  });

  it('truncates to MAX 5 sections and appends "…and N more"', () => {
    const priorSections = Array.from({ length: 7 }, (_, i) => ({
      name: `Section${i}`,
      charCount: 1_000,
      tokenEstimate: 250,
    }));
    const currentSections = priorSections.map((s) => ({
      ...s,
      charCount: s.charCount + 100, // all sections grew → 7 changes
    }));
    const prior = makeSnapshot({ promptSections: priorSections });
    const current = makeSnapshot({ promptSections: currentSections });
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('**Section changes:**');
    expect(msg).toContain('…and 2 more sections changed');
  });

  it('shows negative delta for a section that shrank', () => {
    const prior = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 }],
    });
    const current = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 9_500, tokenEstimate: 2_375 }],
    });
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('Section changes:');
    expect(msg).toContain('Tools:');
    expect(msg).toContain('-500 chars');
    expect(msg).toContain('-5.0%');
  });

  it('reports a newly added zero-length section (null baselineCharCount)', () => {
    const prior = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 1_000, tokenEstimate: 250 }],
    });
    const current = makeSnapshot({
      promptSections: [
        { name: 'Tools', charCount: 1_000, tokenEstimate: 250 },
        { name: 'Safety', charCount: 0, tokenEstimate: 0 }, // zero-length, new
      ],
    });
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('Section changes:');
    expect(msg).toContain('Safety');
    expect(msg).toContain('new');
    // Should NOT include "(+0 chars)" noise for a zero-length new section
    expect(msg).not.toContain('+0 chars');
  });

  it('truncates to MAX 5 sections and appends "…and 1 more" (singular)', () => {
    const priorSections = Array.from({ length: 6 }, (_, i) => ({
      name: `Section${i}`,
      charCount: 1_000 + i * 10, // different sizes so sort is deterministic
      tokenEstimate: 250,
    }));
    const currentSections = priorSections.map((s) => ({
      ...s,
      charCount: s.charCount + 100, // all 6 sections grew
    }));
    const prior = makeSnapshot({ promptSections: priorSections });
    const current = makeSnapshot({ promptSections: currentSections });
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('…and 1 more section changed');
  });


  it('detects text rewrite when char count is unchanged but section text differs', () => {
    // Use different systemPromptHash to ensure CHANGE tier (text rewrites don't affect charCount)
    const prior = makeSnapshot({
      systemPromptHash: 'sha256:before',
      promptSections: [
        { name: 'Introduction', charCount: 100, tokenEstimate: 25, text: 'Hello world\nLine two\n' },
      ],
    });
    const current = makeSnapshot({
      systemPromptHash: 'sha256:after',
      promptSections: [
        { name: 'Introduction', charCount: 100, tokenEstimate: 25, text: 'Hello earth\nLine two\n' },
      ],
    });
    const { message: msg } = buildDigestMessage(current, prior, '2026-07-07');
    expect(msg).toContain('Section changes:');
    expect(msg).toContain('Introduction');
    expect(msg).toContain('same size, text rewritten');
  });
});

// ---------------------------------------------------------------------------
// buildDigestMessage — section-diff-absent paths
// ---------------------------------------------------------------------------

describe('buildDigestMessage — no section changes', () => {
  it('omits "Section changes:" block when sections are identical', () => {
    const sections = [
      { name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 },
      { name: 'Introduction', charCount: 5_000, tokenEstimate: 1_250 },
    ];
    const snap = makeSnapshot({ promptSections: sections });
    const { message: msg } = buildDigestMessage(snap, snap, '2026-07-07');
    expect(msg).not.toContain('Section changes:');
  });

  it('omits "Section changes:" block when neither snapshot has promptSections', () => {
    const snap = makeSnapshot(); // no promptSections field
    const { message: msg } = buildDigestMessage(snap, snap, '2026-07-07');
    expect(msg).not.toContain('Section changes:');
  });

  it('omits "Section changes:" block when prior is null (first capture)', () => {
    const snap = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 }],
    });
    const { message: msg } = buildDigestMessage(snap, null, '2026-07-07');
    expect(msg).not.toContain('Section changes:');
  });
});


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
