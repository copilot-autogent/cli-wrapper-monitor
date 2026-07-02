import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  classifyDeltaPct,
  BREAKING_THRESHOLD_PCT,
  WARNING_THRESHOLD_PCT,
  SEVERITY_EMOJI,
  sendSeveritySummaryWebhook,
  sendToolRemovedWebhook,
  sendModelRemovedWebhook,
  sendHookChangedWebhook,
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
    structuralBreakCount: 0,
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

  it('POSTs when only structural breaks are present', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendSeveritySummaryWebhook(makeSummary({ structuralBreakCount: 1 }), '2026-05-01', '2026-06-01');
    expect(mockFetch).toHaveBeenCalledOnce();
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
    vi.useFakeTimers();
    try {
      process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const promise = sendSeveritySummaryWebhook(makeSummary({ breaking: 1 }), '2026-05-01', '2026-06-01');
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT throw on non-2xx response', async () => {
    vi.useFakeTimers();
    try {
      process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
      mockFetch.mockResolvedValue(new Response(null, { status: 429 }));
      const promise = sendSeveritySummaryWebhook(makeSummary({ breaking: 1 }), '2026-05-01', '2026-06-01');
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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
// sendToolRemovedWebhook (issue #57)
// ---------------------------------------------------------------------------

describe('sendToolRemovedWebhook', () => {
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

  it('does NOT call fetch when DISCORD_WEBHOOK_URL is not set', async () => {
    delete process.env['DISCORD_WEBHOOK_URL'];
    await sendToolRemovedWebhook(['bash'], '2026-05-01', '2026-06-01');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when removedTools is empty', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendToolRemovedWebhook([], '2026-05-01', '2026-06-01');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs when at least one tool is removed', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendToolRemovedWebhook(['bash'], '2026-05-01', '2026-06-01');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('body contains BREAKING label', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendToolRemovedWebhook(['bash'], '2026-05-01', '2026-06-01');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('BREAKING');
  });

  it('body contains removed tool name(s)', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendToolRemovedWebhook(['my_tool', 'other_tool'], '2026-05-01', '2026-06-01');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('my_tool');
    expect(body.content).toContain('other_tool');
  });

  it('body contains date range', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendToolRemovedWebhook(['bash'], '2026-05-01', '2026-06-01');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('2026-05-01');
    expect(body.content).toContain('2026-06-01');
  });

  it('body includes CI run URL when provided', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    const ciUrl = 'https://github.com/org/repo/actions/runs/42';
    await sendToolRemovedWebhook(['bash'], '2026-05-01', '2026-06-01', ciUrl);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain(ciUrl);
  });

  it('does NOT throw on network error (graceful no-op)', async () => {
    vi.useFakeTimers();
    try {
      process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const promise = sendToolRemovedWebhook(['bash'], '2026-05-01', '2026-06-01');
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT throw on non-2xx response', async () => {
    vi.useFakeTimers();
    try {
      process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
      mockFetch.mockResolvedValue(new Response(null, { status: 429 }));
      const promise = sendToolRemovedWebhook(['bash'], '2026-05-01', '2026-06-01');
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('truncates content with "…and N more" when tool list is very long', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    const manyTools = Array.from({ length: 200 }, (_, i) => `tool_${i}`);
    await sendToolRemovedWebhook(manyTools, '2026-05-01', '2026-06-01');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.content).toContain('more');
  });
});

// ---------------------------------------------------------------------------
// sendModelRemovedWebhook (issue #67)
// ---------------------------------------------------------------------------

describe('sendModelRemovedWebhook', () => {
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

  it('does NOT call fetch when DISCORD_WEBHOOK_URL is not set', async () => {
    delete process.env['DISCORD_WEBHOOK_URL'];
    await sendModelRemovedWebhook(['claude-opus-4.6'], '2026-05-01', '2026-06-01');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when DISCORD_WEBHOOK_URL is whitespace-only', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = '   ';
    await sendModelRemovedWebhook(['claude-opus-4.6'], '2026-05-01', '2026-06-01');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when removedModels is empty', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendModelRemovedWebhook([], '2026-05-01', '2026-06-01');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs when at least one model is removed', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendModelRemovedWebhook(['claude-opus-4.6'], '2026-05-01', '2026-06-01');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('body contains BREAKING label', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendModelRemovedWebhook(['claude-opus-4.6'], '2026-05-01', '2026-06-01');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('BREAKING');
  });

  it('body contains removed model name(s)', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendModelRemovedWebhook(['claude-opus-4.6', 'gpt-5.3-codex'], '2026-05-01', '2026-06-01');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('claude-opus-4.6');
    expect(body.content).toContain('gpt-5.3-codex');
  });

  it('body contains date range', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendModelRemovedWebhook(['claude-opus-4.6'], '2026-05-01', '2026-06-01');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('2026-05-01');
    expect(body.content).toContain('2026-06-01');
  });

  it('body includes CI run URL when provided', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    const ciUrl = 'https://github.com/org/repo/actions/runs/42';
    await sendModelRemovedWebhook(['claude-opus-4.6'], '2026-05-01', '2026-06-01', ciUrl);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain(ciUrl);
  });

  it('does NOT throw on network error (graceful no-op)', async () => {
    vi.useFakeTimers();
    try {
      process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const promise = sendModelRemovedWebhook(['claude-opus-4.6'], '2026-05-01', '2026-06-01');
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT throw on non-2xx response', async () => {
    vi.useFakeTimers();
    try {
      process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
      mockFetch.mockResolvedValue(new Response(null, { status: 429 }));
      const promise = sendModelRemovedWebhook(['claude-opus-4.6'], '2026-05-01', '2026-06-01');
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('truncates content with "…and N more" when model list is very long', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    const manyModels = Array.from({ length: 200 }, (_, i) => `model-${i}`);
    await sendModelRemovedWebhook(manyModels, '2026-05-01', '2026-06-01');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.content).toContain('more');
  });
});


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

  it('marks BREAKING when hook count increases (hook added)', () => {
    const baseline = makeSnapshot({ hookCount: 3 });
    const current = makeSnapshot({ hookCount: 4 }); // hook added
    const report = diffSnapshots(baseline, current);
    expect(report.structuralBreaks.filter((s) => s.includes('Hook count increased'))).toHaveLength(1);
    expect(report.hasBreaking).toBe(true);
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
    // severitySummary counts only metric-change rows; structural breaks are in structuralBreakCount
    expect(totalFromChanges).toBe(report.changes.length);
    expect(report.severitySummary.structuralBreakCount).toBe(report.structuralBreaks.length);
  });
});

// ---------------------------------------------------------------------------
// sendHookChangedWebhook (issue #68)
// ---------------------------------------------------------------------------

describe('sendHookChangedWebhook', () => {
  let originalEnv: string | undefined;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalEnv = process.env['DISCORD_WEBHOOK_URL'];
    mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['DISCORD_WEBHOOK_URL'];
    else process.env['DISCORD_WEBHOOK_URL'] = originalEnv;
    vi.restoreAllMocks();
  });

  it('does NOT call fetch when DISCORD_WEBHOOK_URL is not set', async () => {
    delete process.env['DISCORD_WEBHOOK_URL'];
    await sendHookChangedWebhook('removed', { before: 3, after: 2 }, { before: 'sha256:aabb', after: 'sha256:ccdd' }, '2026-05-01', '2026-06-01');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when DISCORD_WEBHOOK_URL is whitespace-only', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = '   ';
    await sendHookChangedWebhook('added', { before: 2, after: 4 }, { before: 'sha256:aabb', after: 'sha256:ccdd' }, '2026-05-01', '2026-06-01');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs when hook is removed (BREAKING)', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.example/webhook';
    await sendHookChangedWebhook('removed', { before: 3, after: 2 }, { before: 'sha256:aaaa', after: 'sha256:bbbb' }, '2026-05-01', '2026-06-01');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('POSTs when hook is added (BREAKING)', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.example/webhook';
    await sendHookChangedWebhook('added', { before: 2, after: 3 }, { before: 'sha256:aaaa', after: 'sha256:bbbb' }, '2026-05-01', '2026-06-01');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('POSTs when hook body changed (WARNING)', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.example/webhook';
    await sendHookChangedWebhook('body_changed', { before: 3, after: 3 }, { before: 'sha256:aaaa', after: 'sha256:bbbb' }, '2026-05-01', '2026-06-01');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('body contains BREAKING label for removed hook', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.example/webhook';
    await sendHookChangedWebhook('removed', { before: 3, after: 2 }, { before: 'sha256:aaaa', after: 'sha256:bbbb' }, '2026-05-01', '2026-06-01');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.content).toContain('BREAKING');
    expect(body.content).toContain('hook removed');
  });

  it('body contains WARNING label for body_changed hook', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.example/webhook';
    await sendHookChangedWebhook('body_changed', { before: 3, after: 3 }, { before: 'sha256:aaaa', after: 'sha256:bbbb' }, '2026-05-01', '2026-06-01');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.content).toContain('WARNING');
    expect(body.content).toContain('hook body changed');
  });

  it('body contains date range', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.example/webhook';
    await sendHookChangedWebhook('removed', { before: 3, after: 2 }, { before: 'sha256:aaaa', after: 'sha256:bbbb' }, '2026-05-01', '2026-06-01');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.content).toContain('2026-05-01');
    expect(body.content).toContain('2026-06-01');
  });

  it('body includes hash snippet', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.example/webhook';
    await sendHookChangedWebhook('body_changed', { before: 3, after: 3 }, { before: 'sha256:aabb1234567890ef', after: 'sha256:ccdd0011223344ff' }, '2026-05-01', '2026-06-01');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.content).toContain('aabb12345678');
    expect(body.content).toContain('ccdd00112233');
  });

  it('body includes CI run URL when provided', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.example/webhook';
    const ciUrl = 'https://github.com/org/repo/actions/runs/999';
    await sendHookChangedWebhook('removed', { before: 3, after: 2 }, { before: 'sha256:aaaa', after: 'sha256:bbbb' }, '2026-05-01', '2026-06-01', ciUrl);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.content).toContain(ciUrl);
  });

  it('body contains count delta for added/removed', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.example/webhook';
    await sendHookChangedWebhook('removed', { before: 3, after: 2 }, { before: 'sha256:aaaa', after: 'sha256:bbbb' }, '2026-05-01', '2026-06-01');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.content).toContain('3 →');
    expect(body.content).toContain('→ 2');
  });

  it('does NOT throw on network error (graceful no-op)', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.example/webhook';
    mockFetch.mockRejectedValue(new Error('network failure'));
    await expect(
      sendHookChangedWebhook('removed', { before: 3, after: 2 }, { before: 'sha256:aaaa', after: 'sha256:bbbb' }, '2026-05-01', '2026-06-01'),
    ).resolves.toBeUndefined();
  });

  it('content length is within Discord 2000-char limit', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.example/webhook';
    const longUrl = 'https://github.com/' + 'x'.repeat(1800) + '/actions/runs/999';
    await sendHookChangedWebhook('removed', { before: 3, after: 2 }, { before: 'sha256:aaaa', after: 'sha256:bbbb' }, '2026-05-01', '2026-06-01', longUrl);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.content.length).toBeLessThanOrEqual(2000);
  });
});
