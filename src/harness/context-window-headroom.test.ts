import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeContextWindowHeadroom,
  formatHeadroomTable,
  detectFirstTimeCrossings,
  extractSystemPromptTokens,
  sendHeadroomAlertWebhook,
  HEADROOM_HIGH_FILL_PCT,
  HEADROOM_OVERFLOW_RISK_PCT,
} from './context-window-headroom.js';
import type { ContextWindowHeadroomEntry, ModelPool, MetricSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(models: Array<{ id: string; contextWindow: number; state?: string }>): ModelPool {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    models: models.map((m) => ({ id: m.id, state: m.state ?? 'enabled', contextWindow: m.contextWindow })),
  };
}

function makeSnapshot(tokens: number): MetricSnapshot {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    monitorVersion: 'abc1234',
    sdkVersion: '^0.2.0',
    model: 'claude-opus-4.6',
    experiments: {
      'context-tax': {
        name: 'context-tax',
        description: 'test',
        metrics: {
          systemPromptTokensEstimated: { value: tokens, unit: 'tokens', description: '' },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// computeContextWindowHeadroom
// ---------------------------------------------------------------------------

describe('computeContextWindowHeadroom', () => {
  it('exports HEADROOM_HIGH_FILL_PCT = 50 and HEADROOM_OVERFLOW_RISK_PCT = 90', () => {
    expect(HEADROOM_HIGH_FILL_PCT).toBe(50);
    expect(HEADROOM_OVERFLOW_RISK_PCT).toBe(90);
  });

  it('returns one entry per model in the pool', () => {
    const pool = makePool([
      { id: 'model-a', contextWindow: 200_000 },
      { id: 'model-b', contextWindow: 128_000 },
    ]);
    const entries = computeContextWindowHeadroom(pool, 45_887);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.modelId)).toEqual(['model-a', 'model-b']);
  });

  it('computes headroomTokens correctly', () => {
    const pool = makePool([{ id: 'claude-opus', contextWindow: 200_000 }]);
    const [entry] = computeContextWindowHeadroom(pool, 45_887);
    expect(entry.headroomTokens).toBe(200_000 - 45_887);
  });

  it('computes promptFillPct correctly (rounded to 2 decimal places)', () => {
    const pool = makePool([{ id: 'model', contextWindow: 200_000 }]);
    const [entry] = computeContextWindowHeadroom(pool, 45_887);
    // 45887 / 200000 * 100 = 22.9435 → 22.94 (2dp)
    expect(entry.promptFillPct).toBe(22.94);
  });

  it('assigns status ok for ≤50% fill', () => {
    const pool = makePool([{ id: 'big-model', contextWindow: 200_000 }]);
    const [entry] = computeContextWindowHeadroom(pool, 50_000); // exactly 25%
    expect(entry.status).toBe('ok');
  });

  it('assigns status high-fill for fill > 50% and ≤ 90%', () => {
    const pool = makePool([{ id: 'mid-model', contextWindow: 64_000 }]);
    const [entry] = computeContextWindowHeadroom(pool, 45_887); // ~71.7%
    expect(entry.status).toBe('high-fill');
    expect(entry.promptFillPct).toBeGreaterThan(50);
    expect(entry.promptFillPct).toBeLessThanOrEqual(90);
  });

  it('assigns status overflow-risk for fill > 90%', () => {
    const pool = makePool([{ id: 'tiny-model', contextWindow: 50_000 }]);
    const [entry] = computeContextWindowHeadroom(pool, 46_000); // 92%
    expect(entry.status).toBe('overflow-risk');
    expect(entry.promptFillPct).toBeGreaterThan(90);
  });

  it('handles zero context window: returns unknown status', () => {
    const pool = makePool([{ id: 'broken-model', contextWindow: 0 }]);
    expect(() => computeContextWindowHeadroom(pool, 45_887)).not.toThrow();
    const [entry] = computeContextWindowHeadroom(pool, 45_887);
    expect(entry.promptFillPct).toBe(0);
    expect(entry.status).toBe('unknown');
    expect(entry.headroomTokens).toBe(-45_887);
  });

  it('attaches systemPromptTokens from the argument onto every entry', () => {
    const pool = makePool([
      { id: 'a', contextWindow: 200_000 },
      { id: 'b', contextWindow: 128_000 },
    ]);
    const entries = computeContextWindowHeadroom(pool, 45_887);
    for (const e of entries) {
      expect(e.systemPromptTokens).toBe(45_887);
    }
  });

  it('propagates state from the model pool entry', () => {
    const pool = makePool([
      { id: 'enabled-model', contextWindow: 200_000, state: 'enabled' },
      { id: 'disabled-model', contextWindow: 128_000, state: 'disabled' },
    ]);
    const entries = computeContextWindowHeadroom(pool, 45_887);
    expect(entries.find((e) => e.modelId === 'enabled-model')?.state).toBe('enabled');
    expect(entries.find((e) => e.modelId === 'disabled-model')?.state).toBe('disabled');
  });

  it('marks exactly 50% fill as ok (not high-fill)', () => {
    const pool = makePool([{ id: 'model', contextWindow: 100_000 }]);
    const [entry] = computeContextWindowHeadroom(pool, 50_000); // exactly 50%
    expect(entry.status).toBe('ok');
  });

  it('marks just above 50% fill as high-fill', () => {
    const pool = makePool([{ id: 'model', contextWindow: 100_000 }]);
    const [entry] = computeContextWindowHeadroom(pool, 50_001); // 50.001%
    expect(entry.status).toBe('high-fill');
  });

  it('marks exactly 90% fill as high-fill (not overflow-risk)', () => {
    const pool = makePool([{ id: 'model', contextWindow: 100_000 }]);
    const [entry] = computeContextWindowHeadroom(pool, 90_000); // exactly 90%
    expect(entry.status).toBe('high-fill');
  });

  it('marks just above 90% fill as overflow-risk', () => {
    const pool = makePool([{ id: 'model', contextWindow: 100_000 }]);
    const [entry] = computeContextWindowHeadroom(pool, 90_001); // 90.001%
    expect(entry.status).toBe('overflow-risk');
  });
});

// ---------------------------------------------------------------------------
// formatHeadroomTable
// ---------------------------------------------------------------------------

describe('formatHeadroomTable', () => {
  it('returns empty string for an empty entries array', () => {
    expect(formatHeadroomTable([])).toBe('');
  });

  it('includes the model ID in the table', () => {
    const pool = makePool([{ id: 'claude-opus-4.7', contextWindow: 200_000 }]);
    const entries = computeContextWindowHeadroom(pool, 45_887);
    const table = formatHeadroomTable(entries);
    expect(table).toContain('claude-opus-4.7');
  });

  it('shows fill percentage', () => {
    const pool = makePool([{ id: 'model', contextWindow: 200_000 }]);
    const entries = computeContextWindowHeadroom(pool, 45_887);
    const table = formatHeadroomTable(entries);
    expect(table).toContain('22.94%');
  });

  it('shows OK status for low-fill model', () => {
    const pool = makePool([{ id: 'model', contextWindow: 200_000 }]);
    const entries = computeContextWindowHeadroom(pool, 45_887);
    const table = formatHeadroomTable(entries);
    expect(table).toContain('✅ OK');
  });

  it('shows HIGH FILL status for >50% model', () => {
    const pool = makePool([{ id: 'small', contextWindow: 64_000 }]);
    const entries = computeContextWindowHeadroom(pool, 45_887);
    const table = formatHeadroomTable(entries);
    expect(table).toContain('HIGH FILL');
    expect(table).toContain('⚠️');
  });

  it('shows OVERFLOW RISK status for >90% model', () => {
    const pool = makePool([{ id: 'tiny', contextWindow: 50_000 }]);
    const entries = computeContextWindowHeadroom(pool, 46_000);
    const table = formatHeadroomTable(entries);
    expect(table).toContain('OVERFLOW RISK');
    expect(table).toContain('🚨');
  });

  it('includes HIGH FILL banner when any model is high-fill', () => {
    const pool = makePool([{ id: 'small', contextWindow: 64_000 }]);
    const entries = computeContextWindowHeadroom(pool, 45_887); // ~71.7%
    const table = formatHeadroomTable(entries);
    expect(table).toContain('HIGH FILL:');
  });

  it('includes OVERFLOW RISK banner when any model is overflow-risk', () => {
    const pool = makePool([{ id: 'tiny', contextWindow: 50_000 }]);
    const entries = computeContextWindowHeadroom(pool, 46_000); // 92%
    const table = formatHeadroomTable(entries);
    expect(table).toContain('OVERFLOW RISK:');
  });

  it('does not include any banner when all models are ok', () => {
    const pool = makePool([{ id: 'big', contextWindow: 200_000 }]);
    const entries = computeContextWindowHeadroom(pool, 45_887);
    const table = formatHeadroomTable(entries);
    expect(table).not.toContain('HIGH FILL:');
    expect(table).not.toContain('OVERFLOW RISK:');
  });

  it('sorts overflow-risk models first in the table', () => {
    const pool = makePool([
      { id: 'ok-model', contextWindow: 200_000 },
      { id: 'overflow-model', contextWindow: 50_000 },
      { id: 'highfill-model', contextWindow: 64_000 },
    ]);
    const entries = computeContextWindowHeadroom(pool, 46_000);
    const table = formatHeadroomTable(entries);
    const overflowIdx = table.indexOf('overflow-model');
    const highFillIdx = table.indexOf('highfill-model');
    const okIdx = table.indexOf('ok-model');
    expect(overflowIdx).toBeLessThan(highFillIdx);
    expect(highFillIdx).toBeLessThan(okIdx);
  });
});

// ---------------------------------------------------------------------------
// detectFirstTimeCrossings
// ---------------------------------------------------------------------------

describe('detectFirstTimeCrossings', () => {
  function makeEntry(
    modelId: string,
    status: 'ok' | 'high-fill' | 'overflow-risk' | 'unknown',
    state = 'enabled',
  ): ContextWindowHeadroomEntry {
    return {
      modelId,
      state,
      contextWindow: 200_000,
      systemPromptTokens: 45_887,
      headroomTokens: 154_113,
      promptFillPct: 22.9,
      status,
    };
  }

  it('returns empty when current has no flagged models', () => {
    const current = [makeEntry('a', 'ok'), makeEntry('b', 'ok')];
    expect(detectFirstTimeCrossings(current, undefined)).toHaveLength(0);
  });

  it('returns empty when previous is undefined (first run after rollout)', () => {
    // No prior headroom data → avoid alerting on all currently-flagged models.
    const current = [makeEntry('small', 'high-fill')];
    expect(detectFirstTimeCrossings(current, undefined)).toHaveLength(0);
  });

  it('returns flagged model when previous is an empty array (pool known, model is new)', () => {
    const current = [makeEntry('new-model', 'high-fill')];
    const previous: ContextWindowHeadroomEntry[] = [];
    const crossings = detectFirstTimeCrossings(current, previous);
    expect(crossings).toHaveLength(1);
    expect(crossings[0].modelId).toBe('new-model');
  });

  it('returns flagged model not present in previous snapshot', () => {
    const current = [makeEntry('new-model', 'high-fill')];
    const previous = [makeEntry('other-model', 'ok')];
    const crossings = detectFirstTimeCrossings(current, previous);
    expect(crossings).toHaveLength(1);
    expect(crossings[0].modelId).toBe('new-model');
  });

  it('does NOT return model that was already high-fill in previous snapshot', () => {
    const current = [makeEntry('small', 'high-fill')];
    const previous = [makeEntry('small', 'high-fill')];
    const crossings = detectFirstTimeCrossings(current, previous);
    expect(crossings).toHaveLength(0);
  });

  it('does NOT alert for disabled models that cross the threshold', () => {
    const current = [makeEntry('disabled-small', 'high-fill', 'disabled')];
    const crossings = detectFirstTimeCrossings(current, undefined);
    expect(crossings).toHaveLength(0);
  });

  it('does NOT alert for unconfigured models that cross the threshold', () => {
    const current = [makeEntry('unconfigured', 'overflow-risk', 'unconfigured')];
    const crossings = detectFirstTimeCrossings(current, undefined);
    expect(crossings).toHaveLength(0);
  });

  it('does NOT return model that was overflow-risk before and still is', () => {
    const current = [makeEntry('tiny', 'overflow-risk')];
    const previous = [makeEntry('tiny', 'overflow-risk')];
    const crossings = detectFirstTimeCrossings(current, previous);
    expect(crossings).toHaveLength(0);
  });

  it('returns model that escalated from ok to overflow-risk', () => {
    const current = [makeEntry('model', 'overflow-risk')];
    const previous = [makeEntry('model', 'ok')];
    const crossings = detectFirstTimeCrossings(current, previous);
    expect(crossings).toHaveLength(1);
  });

  it('returns model that escalated from ok to high-fill', () => {
    const current = [makeEntry('model', 'high-fill')];
    const previous = [makeEntry('model', 'ok')];
    const crossings = detectFirstTimeCrossings(current, previous);
    expect(crossings).toHaveLength(1);
  });

  it('does NOT return model that was high-fill and is now overflow-risk (already crossed 50%)', () => {
    const current = [makeEntry('model', 'overflow-risk')];
    const previous = [makeEntry('model', 'high-fill')];
    const crossings = detectFirstTimeCrossings(current, previous);
    expect(crossings).toHaveLength(0);
  });

  it('handles empty previous array gracefully', () => {
    const current = [makeEntry('model', 'high-fill')];
    const crossings = detectFirstTimeCrossings(current, []);
    expect(crossings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// extractSystemPromptTokens
// ---------------------------------------------------------------------------

describe('extractSystemPromptTokens', () => {
  it('returns 0 when context-tax experiment is absent', () => {
    const snapshot = makeSnapshot(0);
    snapshot.experiments = {};
    expect(extractSystemPromptTokens(snapshot)).toBe(0);
  });

  it('returns 0 when context-tax experiment has error', () => {
    const snapshot = makeSnapshot(45_887);
    snapshot.experiments['context-tax'].error = 'Failed';
    expect(extractSystemPromptTokens(snapshot)).toBe(0);
  });

  it('returns token count from context-tax experiment', () => {
    const snapshot = makeSnapshot(45_887);
    expect(extractSystemPromptTokens(snapshot)).toBe(45_887);
  });
});

// ---------------------------------------------------------------------------
// sendHeadroomAlertWebhook
// ---------------------------------------------------------------------------

describe('sendHeadroomAlertWebhook', () => {
  let originalEnv: string | undefined;
  let mockFetch: ReturnType<typeof vi.fn>;

  function makeCrossing(
    modelId: string,
    contextWindow: number,
    fill: number,
    status: 'high-fill' | 'overflow-risk' = 'high-fill',
    state = 'enabled',
  ): ContextWindowHeadroomEntry {
    const systemPromptTokens = Math.round((contextWindow * fill) / 100);
    return {
      modelId,
      state,
      contextWindow,
      systemPromptTokens,
      headroomTokens: contextWindow - systemPromptTokens,
      promptFillPct: fill,
      status,
    };
  }

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

  it('does NOT call fetch when crossings is empty', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendHeadroomAlertWebhook([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when DISCORD_WEBHOOK_URL is not set', async () => {
    delete process.env['DISCORD_WEBHOOK_URL'];
    await sendHeadroomAlertWebhook([makeCrossing('small', 64_000, 71.7)]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when DISCORD_WEBHOOK_URL is whitespace-only', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = '   ';
    await sendHeadroomAlertWebhook([makeCrossing('small', 64_000, 71.7)]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT throw when DISCORD_WEBHOOK_URL is absent (graceful no-op)', async () => {
    delete process.env['DISCORD_WEBHOOK_URL'];
    await expect(
      sendHeadroomAlertWebhook([makeCrossing('small', 64_000, 71.7)]),
    ).resolves.toBeUndefined();
  });

  it('POSTs to the webhook URL when crossings exist', async () => {
    const webhookUrl = 'https://discord.com/api/webhooks/123/abc';
    process.env['DISCORD_WEBHOOK_URL'] = webhookUrl;
    await sendHeadroomAlertWebhook([makeCrossing('small', 64_000, 71.7)]);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      webhookUrl,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('POST body contains HEADROOM ALERT and model name', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendHeadroomAlertWebhook([makeCrossing('some-small-model', 64_000, 71.7)]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('HEADROOM ALERT');
    expect(body.content).toContain('some-small-model');
  });

  it('POST body contains fill percentage', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendHeadroomAlertWebhook([makeCrossing('model', 64_000, 71.7)]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('71.70%');
  });

  it('POST body includes CI run URL when provided', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    const ciUrl = 'https://github.com/copilot-autogent/cli-wrapper-monitor/actions/runs/99';
    await sendHeadroomAlertWebhook([makeCrossing('model', 64_000, 71.7)], ciUrl);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain(ciUrl);
  });

  it('POST body does NOT include CI link when ciRunUrl is omitted', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    await sendHeadroomAlertWebhook([makeCrossing('model', 64_000, 71.7)]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).not.toContain('actions/runs');
  });

  it('does NOT throw when fetch rejects (network error = graceful no-op)', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      sendHeadroomAlertWebhook([makeCrossing('model', 64_000, 71.7)]),
    ).resolves.toBeUndefined();
  });

  it('does NOT throw on non-2xx response (logged as warning, no CI failure)', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    mockFetch.mockResolvedValue(new Response(null, { status: 429 }));
    await expect(
      sendHeadroomAlertWebhook([makeCrossing('model', 64_000, 71.7)]),
    ).resolves.toBeUndefined();
  });

  it('truncates content at 2000 code points when many crossings', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    const crossings = Array.from({ length: 50 }, (_, i) =>
      makeCrossing(`model-${'x'.repeat(60)}-${i}`, 64_000, 71.7),
    );
    await sendHeadroomAlertWebhook(crossings, 'https://github.com/' + 'x'.repeat(1000));
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect([...body.content].length).toBeLessThanOrEqual(2000);
  });
});
