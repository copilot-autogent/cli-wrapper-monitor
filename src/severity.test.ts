import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  classifyDeltaPct,
  BREAKING_THRESHOLD_PCT,
  WARNING_THRESHOLD_PCT,
  SEVERITY_EMOJI,
  sendSeveritySummaryWebhook,
  type SeverityLevel,
  type SeveritySummary,
} from './severity.js';

// ---------------------------------------------------------------------------
// classifyDeltaPct
// ---------------------------------------------------------------------------

describe('classifyDeltaPct', () => {
  it('returns INFO for 0% change', () => {
    expect(classifyDeltaPct(0)).toBe('INFO');
  });

  it('returns INFO for 2% change', () => {
    expect(classifyDeltaPct(2)).toBe('INFO');
  });

  it('returns INFO just below WARNING threshold', () => {
    expect(classifyDeltaPct(WARNING_THRESHOLD_PCT - 0.001)).toBe('INFO');
  });

  it('returns WARNING at exactly the WARNING threshold', () => {
    expect(classifyDeltaPct(WARNING_THRESHOLD_PCT)).toBe('WARNING');
  });

  it('returns WARNING for 10% change', () => {
    expect(classifyDeltaPct(10)).toBe('WARNING');
  });

  it('returns WARNING just below BREAKING threshold', () => {
    expect(classifyDeltaPct(BREAKING_THRESHOLD_PCT - 0.001)).toBe('WARNING');
  });

  it('returns WARNING at exactly the BREAKING threshold', () => {
    // threshold is strict >BREAKING, so exactly BREAKING_THRESHOLD_PCT is still WARNING
    expect(classifyDeltaPct(BREAKING_THRESHOLD_PCT)).toBe('WARNING');
  });

  it('returns BREAKING just above BREAKING threshold', () => {
    expect(classifyDeltaPct(BREAKING_THRESHOLD_PCT + 0.001)).toBe('BREAKING');
  });

  it('returns BREAKING for large change (30%)', () => {
    expect(classifyDeltaPct(30)).toBe('BREAKING');
  });

  it('exports correct threshold constants', () => {
    expect(BREAKING_THRESHOLD_PCT).toBe(15);
    expect(WARNING_THRESHOLD_PCT).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// SEVERITY_EMOJI
// ---------------------------------------------------------------------------

describe('SEVERITY_EMOJI', () => {
  it('has emoji for all severity levels', () => {
    const levels: SeverityLevel[] = ['BREAKING', 'WARNING', 'INFO'];
    for (const level of levels) {
      expect(SEVERITY_EMOJI[level]).toBeTruthy();
    }
  });

  it('uses 🔴 for BREAKING', () => {
    expect(SEVERITY_EMOJI.BREAKING).toBe('🔴');
  });

  it('uses 🟡 for WARNING', () => {
    expect(SEVERITY_EMOJI.WARNING).toBe('🟡');
  });

  it('uses 🟢 for INFO', () => {
    expect(SEVERITY_EMOJI.INFO).toBe('🟢');
  });
});

// ---------------------------------------------------------------------------
// sendSeveritySummaryWebhook
// ---------------------------------------------------------------------------

describe('sendSeveritySummaryWebhook', () => {
  let originalEnv: string | undefined;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalEnv = process.env['DISCORD_WEBHOOK_URL'];
    mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['DISCORD_WEBHOOK_URL'];
    } else {
      process.env['DISCORD_WEBHOOK_URL'] = originalEnv;
    }
    vi.unstubAllGlobals();
  });

  const makeSummary = (overrides: Partial<SeveritySummary> = {}): SeveritySummary => ({
    breaking: 0,
    warning: 0,
    info: 0,
    ...overrides,
  });

  it('does NOT call fetch when DISCORD_WEBHOOK_URL is not set', async () => {
    delete process.env['DISCORD_WEBHOOK_URL'];
    await sendSeveritySummaryWebhook(makeSummary({ breaking: 1 }), '2026-05-01', '2026-06-01');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when DISCORD_WEBHOOK_URL is whitespace-only', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = '   ';
    await sendSeveritySummaryWebhook(makeSummary({ breaking: 1 }), '2026-05-01', '2026-06-01');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when all counts are zero', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendSeveritySummaryWebhook(makeSummary(), '2026-05-01', '2026-06-01');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when only INFO deltas (no actionable signal)', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendSeveritySummaryWebhook(makeSummary({ info: 5 }), '2026-05-01', '2026-06-01');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs when there is at least one BREAKING delta', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendSeveritySummaryWebhook(makeSummary({ breaking: 1 }), '2026-05-01', '2026-06-01');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('POSTs when there are only WARNING deltas', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendSeveritySummaryWebhook(makeSummary({ warning: 2 }), '2026-05-01', '2026-06-01');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('body includes BREAKING count when breaking > 0', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendSeveritySummaryWebhook(makeSummary({ breaking: 1, warning: 2 }), '2026-05-01', '2026-06-01');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('1 BREAKING');
    expect(body.content).toContain('2 WARNING');
  });

  it('body includes date range', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendSeveritySummaryWebhook(makeSummary({ breaking: 1 }), '2026-05-01', '2026-06-01');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('2026-05-01');
    expect(body.content).toContain('2026-06-01');
  });

  it('body includes CI run URL when provided', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    const ciUrl = 'https://github.com/org/repo/actions/runs/999';
    await sendSeveritySummaryWebhook(makeSummary({ breaking: 1 }), '2026-05-01', '2026-06-01', ciUrl);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain(ciUrl);
  });

  it('does NOT throw on network error (graceful no-op)', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      sendSeveritySummaryWebhook(makeSummary({ breaking: 1 }), '2026-05-01', '2026-06-01'),
    ).resolves.toBeUndefined();
  });

  it('does NOT throw on non-2xx response', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    mockFetch.mockResolvedValue(new Response(null, { status: 429 }));
    await expect(
      sendSeveritySummaryWebhook(makeSummary({ breaking: 1 }), '2026-05-01', '2026-06-01'),
    ).resolves.toBeUndefined();
  });

  it('truncates content at 2000 chars for very long URLs', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    const longUrl = 'https://github.com/' + 'x'.repeat(2000);
    await sendSeveritySummaryWebhook(makeSummary({ breaking: 1 }), '2026-05-01', '2026-06-01', longUrl);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content.length).toBeLessThanOrEqual(2000);
  });
});

// ---------------------------------------------------------------------------
// Integration: diffSnapshots severity classification
// ---------------------------------------------------------------------------

import { diffSnapshots } from './harness/diff.js';
import type { MetricSnapshot } from './harness/types.js';

function makeSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    monitorVersion: 'abc1234',
    sdkVersion: '^0.2.0',
    model: 'claude-sonnet-4.6',
    hookCount: 3,
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

describe('diffSnapshots — severity classification', () => {
  it('classifies 2% growth as INFO', () => {
    const baseline = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax', description: 'test',
          metrics: {
            systemPromptChars: { value: 102_000, unit: 'chars', description: '' }, // +2%
            toolCount: { value: 10, unit: 'tools', description: '' },
          },
        },
      },
    });
    const report = diffSnapshots(baseline, current);
    const chars = report.changes.find((c) => c.metric === 'systemPromptChars')!;
    expect(chars.severity).toBe('INFO');
    expect(report.hasBreaking).toBe(false);
  });

  it('classifies 10% growth as WARNING', () => {
    const baseline = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax', description: 'test',
          metrics: {
            systemPromptChars: { value: 110_000, unit: 'chars', description: '' }, // +10%
            toolCount: { value: 10, unit: 'tools', description: '' },
          },
        },
      },
    });
    const report = diffSnapshots(baseline, current);
    const chars = report.changes.find((c) => c.metric === 'systemPromptChars')!;
    expect(chars.severity).toBe('WARNING');
    expect(report.hasBreaking).toBe(false);
    expect(report.severitySummary.warning).toBeGreaterThan(0);
  });

  it('classifies >15% growth as BREAKING', () => {
    const baseline = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax', description: 'test',
          metrics: {
            systemPromptChars: { value: 120_000, unit: 'chars', description: '' }, // +20%
            toolCount: { value: 10, unit: 'tools', description: '' },
          },
        },
      },
    });
    const report = diffSnapshots(baseline, current);
    const chars = report.changes.find((c) => c.metric === 'systemPromptChars')!;
    expect(chars.severity).toBe('BREAKING');
    expect(report.hasBreaking).toBe(true);
    expect(report.severitySummary.breaking).toBeGreaterThan(0);
  });

  it('marks hasBreaking when tool count drops (structural BREAKING)', () => {
    const baseline = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax', description: 'test',
          metrics: {
            systemPromptChars: { value: 100_000, unit: 'chars', description: '' }, // no change
            toolCount: { value: 8, unit: 'tools', description: '' }, // dropped from 10 to 8
          },
        },
      },
    });
    const report = diffSnapshots(baseline, current);
    expect(report.hasBreaking).toBe(true);
    expect(report.structuralBreaks.length).toBeGreaterThan(0);
    expect(report.structuralBreaks[0]).toContain('Tool count dropped');
    expect(report.structuralBreaks[0]).toContain('10');
    expect(report.structuralBreaks[0]).toContain('8');
  });

  it('marks hasBreaking when hook count drops (structural BREAKING)', () => {
    const baseline = makeSnapshot({ hookCount: 3 });
    const current = makeSnapshot({ hookCount: 2 }); // hook removed
    const report = diffSnapshots(baseline, current);
    expect(report.hasBreaking).toBe(true);
    expect(report.structuralBreaks.some((s) => s.includes('Hook count dropped'))).toBe(true);
  });

  it('does NOT mark BREAKING when tool count increases', () => {
    const baseline = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax', description: 'test',
          metrics: {
            systemPromptChars: { value: 100_000, unit: 'chars', description: '' },
            toolCount: { value: 12, unit: 'tools', description: '' }, // tools added
          },
        },
      },
    });
    const report = diffSnapshots(baseline, current);
    // Tool count increase is not a structural BREAKING condition
    expect(report.structuralBreaks.filter((s) => s.includes('Tool count'))).toHaveLength(0);
  });

  it('does NOT mark BREAKING when hook count increases', () => {
    const baseline = makeSnapshot({ hookCount: 3 });
    const current = makeSnapshot({ hookCount: 4 }); // hook added
    const report = diffSnapshots(baseline, current);
    expect(report.structuralBreaks.filter((s) => s.includes('Hook count'))).toHaveLength(0);
  });

  it('severitySummary counts match changes array', () => {
    const baseline = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax', description: 'test',
          metrics: {
            systemPromptChars: { value: 120_000, unit: 'chars', description: '' }, // +20% → BREAKING
            toolCount: { value: 10, unit: 'tools', description: '' },
          },
        },
      },
    });
    const report = diffSnapshots(baseline, current);
    const totalFromChanges =
      report.severitySummary.breaking + report.severitySummary.warning + report.severitySummary.info;
    // severitySummary.breaking = metric BREAKING rows + structural breaks
    expect(totalFromChanges).toBeGreaterThanOrEqual(report.changes.length);
  });
});
