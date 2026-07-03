import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdirSync } from 'node:fs';
import { sendWebhookWithRetry, bundleWebhooks, MAX_ATTEMPTS, type WebhookAlert } from './webhook-utils.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK_URL = 'https://discord.com/api/webhooks/test/token';
const PAYLOAD = { content: 'Test alert message' };
const ALERT_TYPE = 'test-alert';

function makeOkResponse(status = 204): Response {
  return new Response(null, { status });
}

function makeErrorResponse(status: number): Response {
  return new Response(null, { status });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sendWebhookWithRetry', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ---- Happy path --------------------------------------------------------

  it('calls fetch once on first-attempt success', async () => {
    await sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('POSTs to the correct URL with JSON body', async () => {
    await sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    expect((init as RequestInit & { method: string }).method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(PAYLOAD);
  });

  it('succeeds on second attempt after first attempt returns non-2xx', async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(429))
      .mockResolvedValueOnce(makeOkResponse());

    const promise = sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);
    // Advance past the first backoff delay (1 s)
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(appendFileSync).not.toHaveBeenCalled();
  });

  it('succeeds on third attempt after two failures', async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeErrorResponse(503))
      .mockResolvedValueOnce(makeOkResponse());

    const promise = sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(appendFileSync).not.toHaveBeenCalled();
  });

  // ---- Retry count -------------------------------------------------------

  it('retries exactly MAX_ATTEMPTS times on persistent non-2xx responses', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(429));

    const promise = sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('retries exactly MAX_ATTEMPTS times on persistent network errors', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const promise = sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('does NOT retry on non-retryable 4xx (e.g. 404) — stops after first attempt', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(404));

    const promise = sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 401 Unauthorized', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(401));

    await sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // ---- Dead-letter log ---------------------------------------------------

  it('writes to dead-letter log after all retries fail (non-2xx)', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(429));

    const promise = sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);
    await vi.runAllTimersAsync();
    await promise;

    expect(mkdirSync).toHaveBeenCalledOnce();
    expect(appendFileSync).toHaveBeenCalledOnce();

    const [, written] = (appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
    ];
    const entry = JSON.parse(written.trim());
    expect(entry.alertType).toBe(ALERT_TYPE);
    expect(entry.payload).toEqual(PAYLOAD);
    expect(entry.attempts).toBe(MAX_ATTEMPTS);
    expect(typeof entry.timestamp).toBe('string');
    expect(entry.error).toContain('429');
  });

  it('writes to dead-letter log after all retries fail (network error)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const promise = sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);
    await vi.runAllTimersAsync();
    await promise;

    expect(appendFileSync).toHaveBeenCalledOnce();
    const [, written] = (appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      string,
    ];
    const entry = JSON.parse(written.trim());
    expect(entry.error).toContain('ECONNREFUSED');
  });

  it('does NOT write dead-letter on success', async () => {
    mockFetch.mockResolvedValue(makeOkResponse(204));
    await sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);
    expect(appendFileSync).not.toHaveBeenCalled();
  });

  // ---- Console output ----------------------------------------------------

  it('calls console.error on final failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValue(makeErrorResponse(500));

    const promise = sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);
    await vi.runAllTimersAsync();
    await promise;

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0][0]).toContain(`${MAX_ATTEMPTS} attempt`);
    consoleSpy.mockRestore();
  });

  it('does NOT call console.error on success', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValue(makeOkResponse());

    await sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  // ---- Dead-letter fs errors swallowed -----------------------------------

  it('does not throw when appendFileSync fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (appendFileSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    mockFetch.mockResolvedValue(makeErrorResponse(500));

    const promise = sendWebhookWithRetry(WEBHOOK_URL, PAYLOAD, ALERT_TYPE);
    await vi.runAllTimersAsync();
    // Should resolve without throwing despite FS error
    await expect(promise).resolves.toBeUndefined();
    // console.error should mention that dead-letter write also failed
    expect(consoleSpy.mock.calls[0][0]).toContain('Dead-letter write also failed');
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// bundleWebhooks
// ---------------------------------------------------------------------------

describe('bundleWebhooks', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', mockFetch);
    vi.stubEnv('DISCORD_WEBHOOK_URL', WEBHOOK_URL);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  const makeAlert = (
    content: string,
    severity: WebhookAlert['severity'] = 'INFO',
    alertType = 'test-alert',
  ): WebhookAlert => ({ content, alertType, severity });

  // ---- No-op cases -------------------------------------------------------

  it('does not call fetch when alerts list is empty', async () => {
    await bundleWebhooks([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not call fetch when DISCORD_WEBHOOK_URL is absent', async () => {
    vi.stubEnv('DISCORD_WEBHOOK_URL', '');
    await bundleWebhooks([makeAlert('hello', 'BREAKING')]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not call fetch when DISCORD_WEBHOOK_URL is whitespace-only', async () => {
    vi.stubEnv('DISCORD_WEBHOOK_URL', '   ');
    await bundleWebhooks([makeAlert('hello', 'BREAKING')]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ---- Single alert pass-through -----------------------------------------

  it('single alert: calls fetch once with the original content', async () => {
    const alert = makeAlert('Tool removed: `edit`', 'BREAKING', 'tool-removed');
    await bundleWebhooks([alert]);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toBe(alert.content);
  });

  it('single alert: clamps oversized content to 2000 chars', async () => {
    const oversized = 'x'.repeat(2500);
    await bundleWebhooks([makeAlert(oversized, 'INFO')]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.content.endsWith('…')).toBe(true);
  });

  it('single alert: passes through the original alertType to sendWebhookWithRetry (dead-letter label)', async () => {
    // alertType is passed as the 3rd arg to sendWebhookWithRetry for dead-letter entries.
    // To verify it is forwarded correctly, trigger a delivery failure and inspect the dead-letter
    // log entry written by appendFileSync.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValue(new Response(null, { status: 500 }));
    const alert = makeAlert('Model removed: gpt-4', 'BREAKING', 'model-removed');

    const promise = bundleWebhooks([alert]);
    await vi.runAllTimersAsync();
    await promise;

    const written = (appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    const entry = JSON.parse(written?.trim() ?? '{}') as { alertType: string };
    expect(entry.alertType).toBe('model-removed');
    consoleSpy.mockRestore();
  });

  // ---- Multi-alert merging -----------------------------------------------

  it('multiple alerts: calls fetch exactly once', async () => {
    await bundleWebhooks([
      makeAlert('Alert A', 'BREAKING'),
      makeAlert('Alert B', 'WARNING'),
      makeAlert('Alert C', 'INFO'),
    ]);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('multiple alerts: merged content contains all individual alert contents', async () => {
    const alerts = [
      makeAlert('Content alpha', 'BREAKING'),
      makeAlert('Content beta', 'WARNING'),
    ];
    await bundleWebhooks(alerts);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('Content alpha');
    expect(body.content).toContain('Content beta');
  });

  it('multiple alerts: header shows BREAKING when any alert is BREAKING', async () => {
    await bundleWebhooks([
      makeAlert('A', 'WARNING'),
      makeAlert('B', 'BREAKING'),
    ]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('BREAKING');
    expect(body.content).toContain('🚨');
  });

  it('multiple alerts: header shows WARNING when highest is WARNING', async () => {
    await bundleWebhooks([
      makeAlert('A', 'INFO'),
      makeAlert('B', 'WARNING'),
    ]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('WARNING');
    expect(body.content).toContain('⚠️');
    expect(body.content).not.toContain('🚨');
  });

  it('multiple alerts: header shows INFO when all alerts are INFO', async () => {
    await bundleWebhooks([makeAlert('A', 'INFO'), makeAlert('B', 'INFO')]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('INFO');
    expect(body.content).toContain('🟢');
  });

  it('multiple alerts: header includes the issue count with correct pluralisation', async () => {
    await bundleWebhooks([
      makeAlert('A', 'BREAKING'),
      makeAlert('B', 'WARNING'),
      makeAlert('C', 'INFO'),
    ]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('3 issues detected');
  });

  it('multiple alerts: issueCount=1 uses singular "issue detected"', async () => {
    await bundleWebhooks(
      [makeAlert('Summary', 'BREAKING'), makeAlert('Tool removed', 'BREAKING')],
      undefined,
      1,
    );
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('1 issue detected');
    expect(body.content).not.toContain('1 issues detected');
    expect(body.content).not.toContain('2 issue');
  });

  it('multiple alerts: issueCount=0 falls back to alert count for pluralisation', async () => {
    // issueCount=0 → issueCount ?? alerts.length uses 0, which is falsy but valid;
    // 0 is treated as "0 issues detected"
    await bundleWebhooks(
      [makeAlert('Summary only', 'WARNING'), makeAlert('Another', 'WARNING')],
      undefined,
      0,
    );
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('0 issues detected');
  });

  // ---- Webhook URL override ----------------------------------------------

  it('uses provided webhookUrl override instead of env var', async () => {
    const overrideUrl = 'https://discord.com/api/webhooks/override/xyz';
    vi.stubEnv('DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/should-not-use/token');
    await bundleWebhooks([makeAlert('hi', 'INFO')], overrideUrl);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(overrideUrl);
  });

  // ---- 2000-char truncation / section omission ---------------------------

  it('omits sections that would overflow the 2000-char limit and appends an informative note', async () => {
    // Each alert body is long enough that both can't fit together with the header.
    const longContent = 'x'.repeat(1500);
    await bundleWebhooks([makeAlert(longContent, 'INFO'), makeAlert(longContent, 'INFO')]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content.length).toBeLessThanOrEqual(2000);
    // The dropped section should produce an informative note, not a silent mid-text slice.
    expect(body.content).toContain('section omitted');
  });

  it('does not add omission note when all sections fit', async () => {
    await bundleWebhooks([makeAlert('Short A', 'INFO'), makeAlert('Short B', 'INFO')]);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).not.toContain('sections omitted');
    expect(body.content).toContain('Short A');
    expect(body.content).toContain('Short B');
  });
});
