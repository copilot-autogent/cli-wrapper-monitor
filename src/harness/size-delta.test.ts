import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeSizeDelta,
  formatSizeDeltaTable,
  sendSizeAlertWebhook,
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
    // Issue spec says ">10%", so exactly 10% should NOT trigger
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

  it('does NOT fire alert when context-tax experiment errors', () => {
    // Simulates runner recording metrics: {} on experiment failure.
    // Without this guard, all metrics → 0 vs previous 100k → -100% → false alert.
    const latest = makeSnapshot(100_000, 25_000, 10);
    const errorSnapshot: MetricSnapshot = {
      capturedAt: '2026-06-01T00:00:00.000Z',
      monitorVersion: 'abc',
      sdkVersion: '^0.2.0',
      model: 'claude',
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {},
          error: 'Failed to connect',
        },
      },
    };

    const result = computeSizeDelta(errorSnapshot, latest);
    expect(result.hasAlert).toBe(false);
    for (const m of result.metrics) {
      expect(m.alert).toBe(false);
      expect(m.deltaAbsolute).toBeNull();
    }
  });

  it('alerts when toolCount grows from 0 to non-zero', () => {
    const latest = makeSnapshot(100_000, 25_000, 0); // toolCount was 0
    const current = makeSnapshot(100_000, 25_000, 5);

    const result = computeSizeDelta(current, latest);

    const tools = result.metrics.find((m) => m.key === 'toolCount')!;
    expect(tools.alert).toBe(true);
    expect(result.hasAlert).toBe(true);
  });

  it('shows (∞%) in table when previous was 0', () => {
    const latest = makeSnapshot(100_000, 25_000, 0);
    const current = makeSnapshot(100_000, 25_000, 5);

    const result = computeSizeDelta(current, latest);
    const table = formatSizeDeltaTable(result);

    expect(table).toContain('∞%');
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

    // toLocaleString('en-US') is used in the formatter, so thousands separator is ','
    expect(table).toContain('+5,000');
    expect(table).toContain('+5.0%');
  });

  it('exports SIZE_ALERT_THRESHOLD_PCT as a public constant', () => {
    expect(SIZE_ALERT_THRESHOLD_PCT).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// sendSizeAlertWebhook
// ---------------------------------------------------------------------------

describe('sendSizeAlertWebhook', () => {
  // Restore env and fetch mock after each test
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

  it('does NOT call fetch when hasAlert is false', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(105_000, 26_000, 10); // +5% — no alert
    const result = computeSizeDelta(current, latest);

    await sendSizeAlertWebhook(result);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when DISCORD_WEBHOOK_URL is not set', async () => {
    delete process.env['DISCORD_WEBHOOK_URL'];
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(120_000, 30_000, 10); // +20% — alert
    const result = computeSizeDelta(current, latest);

    await sendSizeAlertWebhook(result);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT throw when DISCORD_WEBHOOK_URL is absent (graceful no-op)', async () => {
    delete process.env['DISCORD_WEBHOOK_URL'];
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(120_000, 30_000, 10);
    const result = computeSizeDelta(current, latest);

    await expect(sendSizeAlertWebhook(result)).resolves.toBeUndefined();
  });

  it('POSTs to the webhook URL when SIZE ALERT fires', async () => {
    const webhookUrl = 'https://discord.com/api/webhooks/123/abc';
    process.env['DISCORD_WEBHOOK_URL'] = webhookUrl;
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(120_000, 30_000, 10); // +20%
    const result = computeSizeDelta(current, latest);

    await sendSizeAlertWebhook(result);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(webhookUrl, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
    }));
  });

  it('POST body contains metric name, % change, and SIZE ALERT text', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(120_000, 30_000, 10); // +20%
    const result = computeSizeDelta(current, latest);

    await sendSizeAlertWebhook(result);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('SIZE ALERT');
    expect(body.content).toContain('System prompt chars');
    expect(body.content).toContain('+20.0%');
  });

  it('POST body includes CI run URL when provided', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(120_000, 30_000, 10);
    const result = computeSizeDelta(current, latest);
    const ciUrl = 'https://github.com/copilot-autogent/cli-wrapper-monitor/actions/runs/12345';

    await sendSizeAlertWebhook(result, ciUrl);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain(ciUrl);
  });

  it('POST body does NOT include CI link when ciRunUrl is omitted', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(120_000, 30_000, 10);
    const result = computeSizeDelta(current, latest);

    await sendSizeAlertWebhook(result);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).not.toContain('actions/runs');
  });

  it('only includes alerting metrics in the POST body', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    // Only systemPromptChars crosses the threshold
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(120_000, 25_500, 10); // chars +20%, tokens +2%, tools unchanged
    const result = computeSizeDelta(current, latest);

    await sendSizeAlertWebhook(result);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('System prompt chars');
    // Tokens (est.) grew only 2% — should NOT be in the alert
    expect(body.content).not.toContain('Tokens (est.)');
  });

  it('does NOT throw when fetch rejects (network error = graceful no-op)', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(120_000, 30_000, 10);
    const result = computeSizeDelta(current, latest);

    await expect(sendSizeAlertWebhook(result)).resolves.toBeUndefined();
  });

  it('does NOT throw on non-2xx response (logged as warning, no CI failure)', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    mockFetch.mockResolvedValue(new Response(null, { status: 429 }));
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(120_000, 30_000, 10);
    const result = computeSizeDelta(current, latest);

    await expect(sendSizeAlertWebhook(result)).resolves.toBeUndefined();
  });

  it('truncates content at 2000 chars when many metrics alert', async () => {
    process.env['DISCORD_WEBHOOK_URL'] = 'https://discord.com/api/webhooks/test/token';
    // All three metrics alert; add a very long CI URL to push near the limit
    const latest = makeSnapshot(100_000, 25_000, 10);
    const current = makeSnapshot(120_000, 30_000, 20); // all three metrics change >10%
    const result = computeSizeDelta(current, latest);
    const longCiUrl = 'https://github.com/' + 'x'.repeat(2000);

    await sendSizeAlertWebhook(result, longCiUrl);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content.length).toBeLessThanOrEqual(2000);
  });
});
