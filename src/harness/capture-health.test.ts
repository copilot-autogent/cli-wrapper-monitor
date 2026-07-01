import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appendHealthLog,
  readHealthLog,
  consecutiveFailureCount,
  hasFailureStreak,
  FAILURE_STREAK_THRESHOLD,
} from './capture-health.js';
import type { HealthLogEntry } from './capture-health.js';

// ---------------------------------------------------------------------------
// fs mock
// ---------------------------------------------------------------------------
const mockFileStore: Map<string, string> = new Map();
const appendedCalls: Array<{ path: string; data: string }> = [];
let mkdirCalled = false;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockImplementation((p: unknown) => mockFileStore.has(String(p)) || String(p).endsWith('/logs')),
    mkdirSync: vi.fn().mockImplementation(() => { mkdirCalled = true; }),
    appendFileSync: vi.fn().mockImplementation((p: unknown, data: unknown) => {
      const key = String(p);
      appendedCalls.push({ path: key, data: String(data) });
      mockFileStore.set(key, (mockFileStore.get(key) ?? '') + String(data));
    }),
    readFileSync: vi.fn().mockImplementation((p: unknown) => {
      const key = String(p);
      if (mockFileStore.has(key)) return mockFileStore.get(key)!;
      const err = Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
      throw err;
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOG_PATH = '/tmp/test-logs/capture-health.jsonl';

function makeEntry(status: 'success' | 'error', overrides: Partial<HealthLogEntry> = {}): HealthLogEntry {
  return {
    capturedAt: new Date().toISOString(),
    status,
    durationMs: 500,
    baselinesDir: '/baselines',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFileStore.clear();
  appendedCalls.length = 0;
  mkdirCalled = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('appendHealthLog', () => {
  it('appends a JSON line followed by newline', () => {
    const entry = makeEntry('success', { snapshotPath: '/baselines/snapshot-foo.json' });
    appendHealthLog(LOG_PATH, entry);

    expect(appendedCalls).toHaveLength(1);
    const written = appendedCalls[0]!.data;
    expect(written.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(written.trimEnd()) as HealthLogEntry;
    expect(parsed.status).toBe('success');
    expect(parsed.snapshotPath).toBe('/baselines/snapshot-foo.json');
  });

  it('appends an error entry with errorType and errorMessage', () => {
    const entry = makeEntry('error', { errorType: 'AuthError', errorMessage: 'bad token' });
    appendHealthLog(LOG_PATH, entry);

    const parsed = JSON.parse(appendedCalls[0]!.data.trimEnd()) as HealthLogEntry;
    expect(parsed.status).toBe('error');
    expect(parsed.errorType).toBe('AuthError');
    expect(parsed.errorMessage).toBe('bad token');
  });

  it('accumulates multiple entries in the store', () => {
    appendHealthLog(LOG_PATH, makeEntry('success'));
    appendHealthLog(LOG_PATH, makeEntry('error'));

    const raw = mockFileStore.get(LOG_PATH) ?? '';
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });
});

describe('readHealthLog', () => {
  it('returns empty array when file does not exist', () => {
    const entries = readHealthLog('/nonexistent/path.jsonl');
    expect(entries).toEqual([]);
  });

  it('parses all entries written by appendHealthLog', () => {
    appendHealthLog(LOG_PATH, makeEntry('success'));
    appendHealthLog(LOG_PATH, makeEntry('error', { errorType: 'NetworkError' }));

    const entries = readHealthLog(LOG_PATH);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.status).toBe('success');
    expect(entries[1]!.status).toBe('error');
    expect(entries[1]!.errorType).toBe('NetworkError');
  });

  it('skips malformed lines and returns remaining valid entries', () => {
    // Manually inject a bad line between two good ones
    const goodLine1 = JSON.stringify(makeEntry('success')) + '\n';
    const badLine = '{not valid json\n';
    const goodLine2 = JSON.stringify(makeEntry('error', { errorType: 'Timeout' })) + '\n';
    mockFileStore.set(LOG_PATH, goodLine1 + badLine + goodLine2);

    const entries = readHealthLog(LOG_PATH);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.status).toBe('success');
    expect(entries[1]!.status).toBe('error');
  });
});

describe('consecutiveFailureCount', () => {
  it('returns 0 for empty log', () => {
    expect(consecutiveFailureCount([])).toBe(0);
  });

  it('returns 0 when last entry is success', () => {
    const entries = [makeEntry('error'), makeEntry('success')];
    expect(consecutiveFailureCount(entries)).toBe(0);
  });

  it('counts trailing errors correctly', () => {
    const entries = [makeEntry('success'), makeEntry('error'), makeEntry('error')];
    expect(consecutiveFailureCount(entries)).toBe(2);
  });

  it('counts all-error log', () => {
    const entries = [makeEntry('error'), makeEntry('error'), makeEntry('error')];
    expect(consecutiveFailureCount(entries)).toBe(3);
  });
});

describe('hasFailureStreak', () => {
  it('returns false when fewer than threshold consecutive failures', () => {
    const entries = Array.from({ length: FAILURE_STREAK_THRESHOLD - 1 }, () => makeEntry('error'));
    expect(hasFailureStreak(entries)).toBe(false);
  });

  it('returns true when exactly threshold consecutive failures at tail', () => {
    const entries = Array.from({ length: FAILURE_STREAK_THRESHOLD }, () => makeEntry('error'));
    expect(hasFailureStreak(entries)).toBe(true);
  });

  it('returns true when more than threshold consecutive failures', () => {
    const entries = Array.from({ length: FAILURE_STREAK_THRESHOLD + 2 }, () => makeEntry('error'));
    expect(hasFailureStreak(entries)).toBe(true);
  });

  it('returns false when streak is broken by a success', () => {
    const entries = [
      ...Array.from({ length: FAILURE_STREAK_THRESHOLD }, () => makeEntry('error')),
      makeEntry('success'),
    ];
    expect(hasFailureStreak(entries)).toBe(false);
  });
});
