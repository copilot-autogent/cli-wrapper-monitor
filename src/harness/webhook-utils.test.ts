import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdirSync } from 'node:fs';
import { sendWebhookWithRetry, MAX_ATTEMPTS } from './webhook-utils.js';

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
