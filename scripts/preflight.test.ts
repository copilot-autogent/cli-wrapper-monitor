/**
 * Unit tests for the pre-flight validator (scripts/preflight.ts).
 *
 * Each of the 4 checks is tested with mocked dependencies so no real
 * auth/webhook/disk/process calls are made.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  checkAuth,
  checkWebhook,
  checkDiskSpace,
  checkTypeScript,
  runPreflight,
} from './preflight.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(overrides: {
  start?: () => Promise<void>;
  listModels?: () => Promise<unknown[]>;
  disconnect?: () => Promise<void>;
} = {}) {
  return {
    start: overrides.start ?? vi.fn().mockResolvedValue(undefined),
    listModels: overrides.listModels ?? vi.fn().mockResolvedValue([{ id: 'model-a' }]),
    disconnect: overrides.disconnect ?? vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// checkAuth
// ---------------------------------------------------------------------------

describe('checkAuth', () => {
  it('returns ok=true when listModels resolves', async () => {
    const client = makeClient();
    const result = await checkAuth({ createClient: () => client });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('✅');
    expect(client.listModels).toHaveBeenCalledOnce();
  });

  it('returns ok=false when start() rejects', async () => {
    const client = makeClient({ start: vi.fn().mockRejectedValue(new Error('ENOENT: auth binary')) });
    const result = await checkAuth({ createClient: () => client });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('❌');
    expect(result.message).toContain('run /login in Copilot CLI first');
    expect(result.message).toContain('ENOENT: auth binary');
  });

  it('returns ok=false when listModels() rejects with Authorization error', async () => {
    const client = makeClient({
      listModels: vi.fn().mockRejectedValue(new Error('Authorization failed')),
    });
    const result = await checkAuth({ createClient: () => client });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Authorization failed');
  });

  it('returns ok=false when listModels() times out', async () => {
    // Mock listModels to reject quickly to simulate timeout-like behaviour.
    const clientTimeout = makeClient({
      listModels: vi.fn().mockImplementation(
        () =>
          new Promise<never>((_, reject) => {
            setImmediate(() => reject(new Error('timeout')));
          }),
      ),
    });

    const result = await checkAuth({ createClient: () => clientTimeout });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('timeout');
  });

  it('calls disconnect() after a successful check', async () => {
    const client = makeClient();
    await checkAuth({ createClient: () => client });
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it('calls disconnect() even after a failed listModels()', async () => {
    const client = makeClient({
      listModels: vi.fn().mockRejectedValue(new Error('fail')),
    });
    await checkAuth({ createClient: () => client });
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// checkWebhook
// ---------------------------------------------------------------------------

describe('checkWebhook', () => {
  it('returns ok=true (skipped) when webhookUrl is undefined', async () => {
    const result = await checkWebhook(undefined);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('skipped');
  });

  it('returns ok=true (skipped) when webhookUrl is empty string', async () => {
    const result = await checkWebhook('');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('skipped');
  });

  it('returns ok=true (skipped) when webhookUrl is whitespace-only', async () => {
    const result = await checkWebhook('   ');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('skipped');
  });

  it('returns ok=true when fetch returns 2xx', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const result = await checkWebhook('https://discord.example/webhook', { fetchFn });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('✅');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('sends a POST with correct body', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await checkWebhook('https://discord.example/webhook', { fetchFn });

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.example/webhook');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ content: 'preflight-test' });
  });

  it('returns ok=false when fetch returns non-2xx', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await checkWebhook('https://discord.example/webhook', { fetchFn });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('❌');
    expect(result.message).toContain('401');
  });

  it('returns ok=false when fetch throws (network error)', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkWebhook('https://discord.example/webhook', { fetchFn });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('unreachable');
    expect(result.message).toContain('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// checkDiskSpace
// ---------------------------------------------------------------------------

describe('checkDiskSpace', () => {
  it('returns ok=true when free bytes >= 10 MB', async () => {
    const getFreeBytesSync = vi.fn().mockReturnValue(50 * 1024 * 1024); // 50 MB
    const result = await checkDiskSpace('/fake/baselines', { getFreeBytesSync });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('✅');
    expect(result.message).toContain('50.0 MB');
  });

  it('returns ok=false when free bytes < 10 MB', async () => {
    const getFreeBytesSync = vi.fn().mockReturnValue(5 * 1024 * 1024); // 5 MB
    const result = await checkDiskSpace('/fake/baselines', { getFreeBytesSync });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('❌');
    expect(result.message).toContain('5.0 MB free');
    expect(result.message).toContain('≥10 MB');
  });

  it('returns ok=false when getFreeBytesSync returns -1 (df unavailable)', async () => {
    const getFreeBytesSync = vi.fn().mockReturnValue(-1);
    const result = await checkDiskSpace('/fake/baselines', { getFreeBytesSync });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('❌');
    expect(result.message).toContain('could not determine free space');
  });

  it('passes the baselines directory to getFreeBytesSync', async () => {
    const getFreeBytesSync = vi.fn().mockReturnValue(100 * 1024 * 1024);
    await checkDiskSpace('/custom/baselines', { getFreeBytesSync });
    expect(getFreeBytesSync).toHaveBeenCalledWith('/custom/baselines');
  });
});

// ---------------------------------------------------------------------------
// checkTypeScript
// ---------------------------------------------------------------------------

describe('checkTypeScript', () => {
  it('returns ok=true when tsc exits with code 0', async () => {
    const runTscSync = vi.fn().mockReturnValue({ exitCode: 0, stderr: '' });
    const result = await checkTypeScript('/fake/project', { runTscSync });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('✅');
  });

  it('returns ok=false when tsc exits with non-zero code', async () => {
    const runTscSync = vi.fn().mockReturnValue({
      exitCode: 1,
      stderr: 'src/foo.ts(12,5): error TS2345: Argument of type ...',
    });
    const result = await checkTypeScript('/fake/project', { runTscSync });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('❌');
    expect(result.message).toContain('tsc --noEmit errors');
    expect(result.message).toContain('TS2345');
  });

  it('returns ok=false when runTscSync throws', async () => {
    const runTscSync = vi.fn().mockImplementation(() => {
      throw new Error('tsc not found');
    });
    const result = await checkTypeScript('/fake/project', { runTscSync });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('could not run tsc');
    expect(result.message).toContain('tsc not found');
  });
});

// ---------------------------------------------------------------------------
// runPreflight
// ---------------------------------------------------------------------------

describe('runPreflight', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const allPassDeps = {
    auth: {
      createClient: () => makeClient(),
    },
    webhook: {
      fetchFn: vi.fn().mockResolvedValue({ ok: true, status: 204 }),
    },
    disk: {
      getFreeBytesSync: vi.fn().mockReturnValue(50 * 1024 * 1024),
    },
    tsc: {
      runTscSync: vi.fn().mockReturnValue({ exitCode: 0, stderr: '' }),
    },
  };

  it('returns true and prints success message when all checks pass', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runPreflight({
      baselinesDir: '/fake/baselines',
      webhookUrl: 'https://discord.example/webhook',
      projectRoot: '/fake/project',
      deps: allPassDeps,
    });

    expect(result).toBe(true);
    const messages = logSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('✅ Pre-flight checks passed — ready to capture.'))).toBe(true);
  });

  it('returns false when auth check fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runPreflight({
      baselinesDir: '/fake/baselines',
      webhookUrl: undefined,
      projectRoot: '/fake/project',
      deps: {
        ...allPassDeps,
        auth: {
          createClient: () =>
            makeClient({
              start: vi.fn().mockRejectedValue(new Error('auth failed')),
            }),
        },
      },
    });

    expect(result).toBe(false);
  });

  it('returns false when disk check fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runPreflight({
      baselinesDir: '/fake/baselines',
      webhookUrl: undefined,
      projectRoot: '/fake/project',
      deps: {
        ...allPassDeps,
        disk: {
          getFreeBytesSync: vi.fn().mockReturnValue(1024), // 1 KB — not enough
        },
      },
    });

    expect(result).toBe(false);
  });

  it('returns false when TypeScript check fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runPreflight({
      baselinesDir: '/fake/baselines',
      webhookUrl: undefined,
      projectRoot: '/fake/project',
      deps: {
        ...allPassDeps,
        tsc: {
          runTscSync: vi.fn().mockReturnValue({ exitCode: 1, stderr: 'error TS2345' }),
        },
      },
    });

    expect(result).toBe(false);
  });

  it('skips webhook check and still passes when DISCORD_WEBHOOK_URL is unset', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const webhookFetchFn = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const result = await runPreflight({
      baselinesDir: '/fake/baselines',
      webhookUrl: undefined,
      projectRoot: '/fake/project',
      deps: {
        ...allPassDeps,
        webhook: { fetchFn: webhookFetchFn },
      },
    });

    expect(result).toBe(true);
    // fetch should NOT be called since webhookUrl is undefined
    expect(webhookFetchFn).not.toHaveBeenCalled();
  });
});
