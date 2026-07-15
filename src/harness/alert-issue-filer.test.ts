import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractAlertTriggers,
  buildAlertIssueTitle,
  buildAlertIssueBody,
  buildCompareCommits,
  filterCandidateCommits,
  fileAlertIssuesIfNeeded,
  findExistingAlertIssue,
  createAlertIssue,
  SIGNAL_KEYWORDS,
} from './alert-issue-filer.js';
import type { DriftMagnitude } from './digest-tier.js';
import type { MetricSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    capturedAt: '2026-07-07T00:00:00.000Z',
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

function makeMagnitude(overrides: Partial<DriftMagnitude> = {}): DriftMagnitude {
  return {
    systemPromptDeltaPct: 0,
    toolCountDelta: 0,
    probeRefusalDeltaPp: 0,
    hasSectionChanges: false,
    hasAnyDrift: false,
    toolSurfaceChanges: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractAlertTriggers
// ---------------------------------------------------------------------------

describe('extractAlertTriggers', () => {
  it('returns empty array when no alert conditions are met', () => {
    const magnitude = makeMagnitude({ systemPromptDeltaPct: 3, toolCountDelta: 0, probeRefusalDeltaPp: 2 });
    const prior = makeSnapshot();
    const current = makeSnapshot();
    const triggers = extractAlertTriggers(magnitude, prior, current);
    expect(triggers).toHaveLength(0);
  });

  it('returns toolCount trigger when toolCountDelta is non-zero (negative)', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 156_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 39_000, unit: 'tokens', description: '' },
            toolCount: { value: 18, unit: 'tools', description: '' },
          },
        },
      },
    });
    const magnitude = makeMagnitude({ toolCountDelta: -3 });
    const triggers = extractAlertTriggers(magnitude, prior, current);

    expect(triggers).toHaveLength(1);
    const t = triggers[0];
    expect(t.metric).toBe('toolCount');
    expect(t.fromValue).toBe('21 tools');
    expect(t.toValue).toBe('18 tools');
    expect(t.delta).toBe('-3 tools');
  });

  it('returns toolCount trigger with + sign when toolCountDelta is positive', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 156_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 39_000, unit: 'tokens', description: '' },
            toolCount: { value: 24, unit: 'tools', description: '' },
          },
        },
      },
    });
    const magnitude = makeMagnitude({ toolCountDelta: 3 });
    const triggers = extractAlertTriggers(magnitude, prior, current);
    expect(triggers[0].delta).toBe('+3 tools');
  });

  it('returns systemPromptChars trigger when delta is at or above threshold', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 164_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 41_000, unit: 'tokens', description: '' },
            toolCount: { value: 21, unit: 'tools', description: '' },
          },
        },
      },
    });
    const magnitude = makeMagnitude({ systemPromptDeltaPct: 5.13 });
    const triggers = extractAlertTriggers(magnitude, prior, current);

    expect(triggers).toHaveLength(1);
    const t = triggers[0];
    expect(t.metric).toBe('systemPromptChars');
    expect(t.fromValue).toBe('156,000 chars');
    expect(t.toValue).toBe('164,000 chars');
    expect(t.delta).toContain('%');
  });

  it('returns systemPromptChars trigger only when >= threshold (not when below)', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot();
    const magnitude = makeMagnitude({ systemPromptDeltaPct: 4.9 });
    const triggers = extractAlertTriggers(magnitude, prior, current);
    expect(triggers).toHaveLength(0);
  });

  it('respects custom alertSystemPromptDeltaPct threshold', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot();
    const magnitude = makeMagnitude({ systemPromptDeltaPct: 3 });
    const triggers = extractAlertTriggers(magnitude, prior, current, { alertSystemPromptDeltaPct: 2 });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].metric).toBe('systemPromptChars');
  });

  it('returns injectionRefusedRate trigger when probeRefusalDeltaPp >= threshold', () => {
    const prior = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 156_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 39_000, unit: 'tokens', description: '' },
            toolCount: { value: 21, unit: 'tools', description: '' },
            injectionRefusedRate: { value: 0.9, unit: 'fraction', description: '' },
          },
        },
      },
    });
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 156_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 39_000, unit: 'tokens', description: '' },
            toolCount: { value: 21, unit: 'tools', description: '' },
            injectionRefusedRate: { value: 0.8, unit: 'fraction', description: '' },
          },
        },
      },
    });
    const magnitude = makeMagnitude({ probeRefusalDeltaPp: 10 });
    const triggers = extractAlertTriggers(magnitude, prior, current);

    expect(triggers).toHaveLength(1);
    const t = triggers[0];
    expect(t.metric).toBe('injectionRefusedRate');
    expect(t.fromValue).toBe('90.0%');
    expect(t.toValue).toBe('80.0%');
    expect(t.delta).toContain('-');
    expect(t.delta).toContain('pp');
  });

  it('returns multiple triggers when several conditions fire simultaneously', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 170_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 42_500, unit: 'tokens', description: '' },
            toolCount: { value: 18, unit: 'tools', description: '' },
          },
        },
      },
    });
    const magnitude = makeMagnitude({
      toolCountDelta: -3,
      systemPromptDeltaPct: 9.0,
    });
    const triggers = extractAlertTriggers(magnitude, prior, current);
    expect(triggers.length).toBeGreaterThanOrEqual(2);
    const metrics = triggers.map((t) => t.metric);
    expect(metrics).toContain('toolCount');
    expect(metrics).toContain('systemPromptChars');
  });
});

// ---------------------------------------------------------------------------
// buildAlertIssueTitle
// ---------------------------------------------------------------------------

describe('buildAlertIssueTitle', () => {
  it('formats the canonical title for a toolCount trigger', () => {
    const trigger = {
      metric: 'toolCount',
      fromValue: '21 tools',
      toValue: '18 tools',
      delta: '-3 tools',
    };
    const title = buildAlertIssueTitle(trigger, '2026-07-07');
    expect(title).toBe('[ALERT] toolCount drifted 21 tools → 18 tools (2026-07-07 capture)');
  });

  it('formats the canonical title for a systemPromptChars trigger', () => {
    const trigger = {
      metric: 'systemPromptChars',
      fromValue: '156,000 chars',
      toValue: '164,000 chars',
      delta: '+5.1%',
    };
    const title = buildAlertIssueTitle(trigger, '2026-07-07');
    expect(title).toBe(
      '[ALERT] systemPromptChars drifted 156,000 chars → 164,000 chars (2026-07-07 capture)',
    );
  });
});

// ---------------------------------------------------------------------------
// buildAlertIssueBody
// ---------------------------------------------------------------------------

describe('buildAlertIssueBody', () => {
  const trigger = { metric: 'toolCount', fromValue: '21 tools', toValue: '18 tools', delta: '-3 tools' };
  const prior = makeSnapshot({ capturedAt: '2026-06-30T00:00:00.000Z' });
  const current = makeSnapshot({ capturedAt: '2026-07-07T00:00:00.000Z' });

  it('includes the metric name in the body', () => {
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest content here', prior, current);
    expect(body).toContain('toolCount');
  });

  it('includes prior and current values', () => {
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', prior, current);
    expect(body).toContain('21 tools');
    expect(body).toContain('18 tools');
  });

  it('includes the delta', () => {
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', prior, current);
    expect(body).toContain('-3 tools');
  });

  it('includes the digest message in a code block', () => {
    const body = buildAlertIssueBody(trigger, '2026-07-07', '🚨 ALERT digest message', prior, current);
    expect(body).toContain('🚨 ALERT digest message');
    expect(body).toContain('```');
  });

  it('includes the auto-filed footer', () => {
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', prior, current);
    expect(body).toContain('Auto-filed by weekly-stability-digest');
  });

  it('includes an Investigate section with a date-based compare URL when binaryHash is sha256 format', () => {
    // makeSnapshot uses binaryHash: 'sha256:aabbcc' → date-based fallback
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', prior, current);
    expect(body).toContain('## Investigate');
    expect(body).toContain('Autogent commits in this window:');
    expect(body).toContain('https://github.com/JackywithaWhiteDog/autogent/compare/main@{2026-06-30}...main@{2026-07-07}');
  });

  it('uses SHA-based compare URL when both snapshots have a git-SHA binaryHash', () => {
    const priorWithSha = makeSnapshot({ capturedAt: '2026-06-30T00:00:00.000Z', binaryHash: 'abc1234' });
    const currentWithSha = makeSnapshot({ capturedAt: '2026-07-07T00:00:00.000Z', binaryHash: 'def5678' });
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', priorWithSha, currentWithSha);
    expect(body).toContain('https://github.com/JackywithaWhiteDog/autogent/compare/abc1234...def5678');
    expect(body).not.toContain('main@{');
  });

  it('falls back to date-based compare URL when one snapshot has an unknown binaryHash', () => {
    const priorUnknown = makeSnapshot({ capturedAt: '2026-06-30T00:00:00.000Z', binaryHash: 'unknown' });
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', priorUnknown, current);
    expect(body).toContain('main@{2026-06-30}...main@{2026-07-07}');
  });

  it('falls back to date-based compare URL when binaryHash is absent', () => {
    const priorNoBinaryHash = makeSnapshot({ capturedAt: '2026-06-30T00:00:00.000Z', binaryHash: undefined });
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', priorNoBinaryHash, current);
    expect(body).toContain('main@{2026-06-30}...main@{2026-07-07}');
  });

  it('uses "unknown" date segment when capturedAt is malformed', () => {
    const priorBad = makeSnapshot({ capturedAt: 'not-a-date', binaryHash: undefined });
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', priorBad, current);
    expect(body).toContain('main@{unknown}...main@{2026-07-07}');
  });

  it('rejects non-hex binaryHash strings (e.g. "pending") and uses date-based URL', () => {
    const priorPending = makeSnapshot({ capturedAt: '2026-06-30T00:00:00.000Z', binaryHash: 'pending' });
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', priorPending, current);
    expect(body).toContain('main@{2026-06-30}...main@{2026-07-07}');
  });

  it('compare URL is a plain URL (not markdown link)', () => {
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', prior, current);
    const urlLine = body.split('\n').find(l => l.includes('github.com/JackywithaWhiteDog/autogent/compare'));
    expect(urlLine).toBeDefined();
    // Plain URL — not wrapped in []() markdown syntax
    expect(urlLine).not.toMatch(/\[.*\]\(.*\)/);
  });
});

// ---------------------------------------------------------------------------
// fileAlertIssuesIfNeeded — no-token path
// ---------------------------------------------------------------------------

describe('fileAlertIssuesIfNeeded — no GITHUB_TOKEN', () => {
  beforeEach(() => {
    delete process.env['GITHUB_TOKEN'];
  });

  it('returns no-token outcomes for all triggers without calling API', async () => {
    const magnitude = makeMagnitude({ toolCountDelta: -3 });
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 156_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 39_000, unit: 'tokens', description: '' },
            toolCount: { value: 18, unit: 'tools', description: '' },
          },
        },
      },
    });

    const results = await fileAlertIssuesIfNeeded({
      magnitude,
      prior,
      current,
      digestMessage: 'test digest',
      captureDate: '2026-07-07',
      githubApi: { token: '' }, // explicit empty string = no token
      verbose: false,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('no-token');
  });

  it('returns empty array when no triggers fired', async () => {
    const magnitude = makeMagnitude(); // all zeros → no triggers
    const prior = makeSnapshot();
    const current = makeSnapshot();

    const results = await fileAlertIssuesIfNeeded({
      magnitude,
      prior,
      current,
      digestMessage: 'stable',
      captureDate: '2026-07-07',
      githubApi: { token: '' },
      verbose: false,
    });

    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fileAlertIssuesIfNeeded — mocked GitHub API
// ---------------------------------------------------------------------------

describe('fileAlertIssuesIfNeeded — mocked GitHub API', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('files a new issue when no existing alert issue is found', async () => {
    const mockFetch = vi.fn();

    // First call: commit fetch → empty list
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    // Second call: search → 0 results (no existing issue)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ total_count: 0, items: [] }),
    });
    // Third call: create issue → returns new issue number
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 42 }),
    });

    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const magnitude = makeMagnitude({ toolCountDelta: -3 });
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 156_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 39_000, unit: 'tokens', description: '' },
            toolCount: { value: 18, unit: 'tools', description: '' },
          },
        },
      },
    });

    const results = await fileAlertIssuesIfNeeded({
      magnitude,
      prior,
      current,
      digestMessage: '🚨 ALERT digest',
      captureDate: '2026-07-07',
      githubApi: { token: 'fake-token', repo: 'owner/repo', baseUrl: 'https://api.github.com' },
      verbose: false,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('filed');
    expect(results[0].issueNumber).toBe(42);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify the create-issue call has correct labels
    const createCall = mockFetch.mock.calls[2];
    const createBody = JSON.parse(createCall[1].body as string);
    expect(createBody.labels).toContain('status:needs-input');
    expect(createBody.labels).toContain('type:regression-alert');
    expect(createBody.title).toContain('[ALERT]');
    expect(createBody.title).toContain('toolCount');
  });

  it('deduplicates when an existing open alert issue is found', async () => {
    const mockFetch = vi.fn();

    // First call: commit fetch → empty list
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    // Search → existing issue found
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ total_count: 1, items: [{ number: 99 }] }),
    });

    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const magnitude = makeMagnitude({ toolCountDelta: -3 });
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 156_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 39_000, unit: 'tokens', description: '' },
            toolCount: { value: 18, unit: 'tools', description: '' },
          },
        },
      },
    });

    const results = await fileAlertIssuesIfNeeded({
      magnitude,
      prior,
      current,
      digestMessage: 'digest',
      captureDate: '2026-07-07',
      githubApi: { token: 'fake-token', repo: 'owner/repo', baseUrl: 'https://api.github.com' },
      verbose: false,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('deduped');
    expect(results[0].issueNumber).toBe(99);
    // No create-issue call should have been made
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns error outcome when GitHub search API fails', async () => {
    const mockFetch = vi.fn();
    // Commit fetch succeeds with empty list
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    // Search fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Service unavailable',
    });

    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const magnitude = makeMagnitude({ toolCountDelta: -3 });
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 156_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 39_000, unit: 'tokens', description: '' },
            toolCount: { value: 18, unit: 'tools', description: '' },
          },
        },
      },
    });

    const results = await fileAlertIssuesIfNeeded({
      magnitude,
      prior,
      current,
      digestMessage: 'digest',
      captureDate: '2026-07-07',
      githubApi: { token: 'fake-token', repo: 'owner/repo', baseUrl: 'https://api.github.com' },
      verbose: false,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('error');
    expect(results[0].error).toContain('503');
  });

  it('handles multiple triggers independently (both filed)', async () => {
    const mockFetch = vi.fn();
    // Commit fetch → empty list
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    // toolCount search → 0 results → file new issue
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ total_count: 0, items: [] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ number: 50 }) });
    // systemPromptChars search → 0 results → file new issue
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ total_count: 0, items: [] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ number: 51 }) });

    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const magnitude = makeMagnitude({ toolCountDelta: -3, systemPromptDeltaPct: 9.0 });
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 170_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 42_500, unit: 'tokens', description: '' },
            toolCount: { value: 18, unit: 'tools', description: '' },
          },
        },
      },
    });

    const results = await fileAlertIssuesIfNeeded({
      magnitude,
      prior,
      current,
      digestMessage: 'digest',
      captureDate: '2026-07-07',
      githubApi: { token: 'fake-token', repo: 'owner/repo', baseUrl: 'https://api.github.com' },
      verbose: false,
    });

    expect(results).toHaveLength(2);
    const outcomes = results.map((r) => r.outcome);
    expect(outcomes).toEqual(['filed', 'filed']);
    expect(mockFetch).toHaveBeenCalledTimes(5); // 1 commit fetch + 2 search + 2 create
  });

  it('continues processing remaining triggers even when one fails', async () => {
    const mockFetch = vi.fn();
    // Commit fetch → empty list
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    // toolCount search fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'error' });
    // systemPromptChars search → 0 results → filed
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ total_count: 0, items: [] }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ number: 55 }) });

    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const magnitude = makeMagnitude({ toolCountDelta: -3, systemPromptDeltaPct: 9.0 });
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 170_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 42_500, unit: 'tokens', description: '' },
            toolCount: { value: 18, unit: 'tools', description: '' },
          },
        },
      },
    });

    const results = await fileAlertIssuesIfNeeded({
      magnitude,
      prior,
      current,
      digestMessage: 'digest',
      captureDate: '2026-07-07',
      githubApi: { token: 'fake-token', repo: 'owner/repo', baseUrl: 'https://api.github.com' },
      verbose: false,
    });

    expect(results).toHaveLength(2);
    expect(results[0].outcome).toBe('error');
    expect(results[1].outcome).toBe('filed');
    expect(results[1].issueNumber).toBe(55);
  });
});

// ---------------------------------------------------------------------------
// findExistingAlertIssue — unit tests
// ---------------------------------------------------------------------------

describe('findExistingAlertIssue', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null when no issues found', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ total_count: 0, items: [] }),
    });
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const result = await findExistingAlertIssue('toolCount', {
      token: 'fake-token',
      repo: 'owner/repo',
      baseUrl: 'https://api.github.com',
    });

    expect(result).toBeNull();
  });

  it('returns the issue number when a matching issue is found', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ total_count: 1, items: [{ number: 77 }] }),
    });
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const result = await findExistingAlertIssue('toolCount', {
      token: 'fake-token',
      repo: 'owner/repo',
      baseUrl: 'https://api.github.com',
    });

    expect(result).toBe(77);
  });

  it('returns null when token is empty (no API call)', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const result = await findExistingAlertIssue('toolCount', { token: '', repo: 'owner/repo' });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws when API returns a non-OK status', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => 'Validation failed',
    });
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    await expect(
      findExistingAlertIssue('toolCount', { token: 'fake-token', repo: 'owner/repo', baseUrl: 'https://api.github.com' }),
    ).rejects.toThrow('422');
  });
});

// ---------------------------------------------------------------------------
// createAlertIssue — unit tests
// ---------------------------------------------------------------------------

describe('createAlertIssue', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends the correct labels in the request body', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 100 }),
    });
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    await createAlertIssue('Test title', 'Test body', {
      token: 'fake-token',
      repo: 'owner/repo',
      baseUrl: 'https://api.github.com',
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(callBody.labels).toEqual(['status:needs-input', 'type:regression-alert']);
  });

  it('returns the created issue number', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ number: 123 }),
    });
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const issueNumber = await createAlertIssue('title', 'body', {
      token: 'fake-token',
      repo: 'owner/repo',
      baseUrl: 'https://api.github.com',
    });

    expect(issueNumber).toBe(123);
  });

  it('throws when API returns a non-OK status', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    await expect(
      createAlertIssue('title', 'body', { token: 'fake-token', repo: 'owner/repo', baseUrl: 'https://api.github.com' }),
    ).rejects.toThrow('404');
  });
});

// ---------------------------------------------------------------------------
// SIGNAL_KEYWORDS
// ---------------------------------------------------------------------------

describe('SIGNAL_KEYWORDS', () => {
  it('defines keywords for all three alert signal types', () => {
    expect(SIGNAL_KEYWORDS['systemPromptChars']).toBeDefined();
    expect(SIGNAL_KEYWORDS['toolCount']).toBeDefined();
    expect(SIGNAL_KEYWORDS['injectionRefusedRate']).toBeDefined();
  });

  it('systemPromptChars keywords include "prompt" and "hook"', () => {
    expect(SIGNAL_KEYWORDS['systemPromptChars']).toContain('prompt');
    expect(SIGNAL_KEYWORDS['systemPromptChars']).toContain('hook');
  });

  it('toolCount keywords include "tool" and "schema"', () => {
    expect(SIGNAL_KEYWORDS['toolCount']).toContain('tool');
    expect(SIGNAL_KEYWORDS['toolCount']).toContain('schema');
  });

  it('injectionRefusedRate keywords include "safety" and "refusal"', () => {
    expect(SIGNAL_KEYWORDS['injectionRefusedRate']).toContain('safety');
    expect(SIGNAL_KEYWORDS['injectionRefusedRate']).toContain('refusal');
  });
});

// ---------------------------------------------------------------------------
// filterCandidateCommits
// ---------------------------------------------------------------------------

describe('filterCandidateCommits', () => {
  const commits = [
    { sha: 'aaaaaaa1111111111111111111111111111111111', message: 'feat: update system prompt instructions' },
    { sha: 'bbbbbbb2222222222222222222222222222222222', message: 'fix: add new tool definition' },
    { sha: 'ccccccc3333333333333333333333333333333333', message: 'refactor: improve safety filter' },
    { sha: 'ddddddd4444444444444444444444444444444444', message: 'chore: update readme' },
    { sha: 'eeeeeee5555555555555555555555555555555555', message: 'feat: new hook handler for context' },
  ];

  it('matches commits by keyword for systemPromptChars signal', () => {
    const groups = filterCandidateCommits(commits, ['systemPromptChars']);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.signal).toBe('systemPromptChars');
    // "system prompt instructions" matches "system prompt" and "prompt" and "instruction"
    // "new hook handler for context" matches "hook" and "context"
    const messages = group.candidates.map((c) => c.message);
    expect(messages).toContain('feat: update system prompt instructions');
    expect(messages).toContain('feat: new hook handler for context');
    // "chore: update readme" should NOT match
    expect(messages).not.toContain('chore: update readme');
  });

  it('matches commits by keyword for toolCount signal', () => {
    const groups = filterCandidateCommits(commits, ['toolCount']);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    const messages = group.candidates.map((c) => c.message);
    expect(messages).toContain('fix: add new tool definition');
  });

  it('matches commits by keyword for injectionRefusedRate signal', () => {
    const groups = filterCandidateCommits(commits, ['injectionRefusedRate']);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    const messages = group.candidates.map((c) => c.message);
    expect(messages).toContain('refactor: improve safety filter');
  });

  it('matching is case-insensitive', () => {
    const upperCommits = [
      { sha: 'aaaaaaa1111111111111111111111111111111111', message: 'feat: Update SYSTEM PROMPT size' },
    ];
    const groups = filterCandidateCommits(upperCommits, ['systemPromptChars']);
    expect(groups[0].candidates).toHaveLength(1);
    expect(groups[0].candidates[0].message).toContain('SYSTEM PROMPT');
  });

  it('returns empty candidates array when no commits match keywords', () => {
    const unrelatedCommits = [
      { sha: 'aaaaaaa1111111111111111111111111111111111', message: 'chore: update dependencies' },
      { sha: 'bbbbbbb2222222222222222222222222222222222', message: 'docs: fix typo in readme' },
    ];
    const groups = filterCandidateCommits(unrelatedCommits, ['toolCount']);
    expect(groups[0].candidates).toHaveLength(0);
  });

  it('handles multiple signals in one call, returning one group per signal', () => {
    const groups = filterCandidateCommits(commits, ['toolCount', 'injectionRefusedRate']);
    expect(groups).toHaveLength(2);
    expect(groups[0].signal).toBe('toolCount');
    expect(groups[1].signal).toBe('injectionRefusedRate');
  });

  it('caps candidates at 10 per signal', () => {
    const manyToolCommits = Array.from({ length: 15 }, (_, i) => ({
      sha: `${'a'.repeat(39)}${i}`,
      message: `feat: add tool ${i}`,
    }));
    const groups = filterCandidateCommits(manyToolCommits, ['toolCount']);
    expect(groups[0].candidates).toHaveLength(10);
  });

  it('returns empty candidates for unknown signal with no keyword mapping', () => {
    const groups = filterCandidateCommits(commits, ['unknownSignal']);
    expect(groups[0].candidates).toHaveLength(0);
  });

  it('returns empty groups array when signals is empty', () => {
    const groups = filterCandidateCommits(commits, []);
    expect(groups).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildCompareCommits
// ---------------------------------------------------------------------------

describe('buildCompareCommits', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const prior = { capturedAt: '2026-06-30T00:00:00.000Z' } as MetricSnapshot;
  const current = { capturedAt: '2026-07-07T00:00:00.000Z' } as MetricSnapshot;

  it('returns CommitEntry array with sha and subject line from API response', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          sha: 'abcdef1234567890abcdef1234567890abcdef12',
          commit: { message: 'feat: add new tool\n\nBody text here.' },
        },
        {
          sha: 'deadbeef1234567890abcdef1234567890abcdef',
          commit: { message: 'fix: update prompt' },
        },
      ],
    });
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const commits = await buildCompareCommits(prior, current, {
      token: 'fake-token',
      baseUrl: 'https://api.github.com',
    });

    expect(commits).toHaveLength(2);
    expect(commits![0].sha).toBe('abcdef1234567890abcdef1234567890abcdef12');
    // Only subject line (before first \n)
    expect(commits![0].message).toBe('feat: add new tool');
    expect(commits![1].sha).toBe('deadbeef1234567890abcdef1234567890abcdef');
    expect(commits![1].message).toBe('fix: update prompt');
  });

  it('returns null when token is absent', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const commits = await buildCompareCommits(prior, current, { token: '' });

    expect(commits).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null when API returns non-OK status (graceful degradation)', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
    });
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const commits = await buildCompareCommits(prior, current, {
      token: 'fake-token',
      baseUrl: 'https://api.github.com',
    });

    expect(commits).toBeNull();
  });

  it('returns null when fetch throws (graceful degradation)', async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const commits = await buildCompareCommits(prior, current, {
      token: 'fake-token',
      baseUrl: 'https://api.github.com',
    });

    expect(commits).toBeNull();
  });

  it('paginates when first page is full (100 items)', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      sha: `${'a'.repeat(39)}${i % 10}`,
      commit: { message: `feat: commit ${i}` },
    }));
    const page2 = [
      { sha: 'b'.repeat(40), commit: { message: 'fix: last commit' } },
    ];

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, json: async () => page2 });
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    const commits = await buildCompareCommits(prior, current, {
      token: 'fake-token',
      baseUrl: 'https://api.github.com',
    });

    expect(commits).toHaveLength(101);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('includes since and until params in request URL', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    await buildCompareCommits(prior, current, {
      token: 'fake-token',
      baseUrl: 'https://api.github.com',
    });

    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain('since=');
    expect(url).toContain('until=');
    expect(url).toContain('/repos/JackywithaWhiteDog/autogent/commits');
  });
});

// ---------------------------------------------------------------------------
// buildAlertIssueBody — Likely culprits section
// ---------------------------------------------------------------------------

describe('buildAlertIssueBody — Likely culprits section', () => {
  const trigger = { metric: 'toolCount', fromValue: '21 tools', toValue: '18 tools', delta: '-3 tools' };
  const prior = { capturedAt: '2026-06-30T00:00:00.000Z', binaryHash: 'sha256:abc', experiments: {} } as unknown as MetricSnapshot;
  const current = { capturedAt: '2026-07-07T00:00:00.000Z', binaryHash: 'sha256:def', experiments: {} } as unknown as MetricSnapshot;

  it('does NOT include Likely culprits section when candidateGroups is undefined', () => {
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', prior, current);
    expect(body).not.toContain('## Likely culprits');
  });

  it('includes Likely culprits section when candidateGroups is provided', () => {
    const groups = [
      {
        signal: 'toolCount',
        candidates: [
          { sha: 'abc12345678901234567890123456789012345678', message: 'feat: add new tool' },
        ],
      },
    ];
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', prior, current, groups);
    expect(body).toContain('## Likely culprits');
    expect(body).toContain('### toolCount');
  });

  it('shows candidate commits with 7-char SHA and linked message', () => {
    const groups = [
      {
        signal: 'toolCount',
        candidates: [
          { sha: 'abc12345678901234567890123456789012345678', message: 'feat: add new tool definition' },
        ],
      },
    ];
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', prior, current, groups);
    expect(body).toContain('`abc1234`');
    expect(body).toContain('feat: add new tool definition');
    expect(body).toContain('https://github.com/JackywithaWhiteDog/autogent/commit/abc12345678901234567890123456789012345678');
  });

  it('shows empty-match note when candidates array is empty', () => {
    const groups = [{ signal: 'toolCount', candidates: [] }];
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', prior, current, groups);
    expect(body).toContain('No commits matched keywords for this signal');
  });

  it('shows Likely culprits section with empty-match note when candidateGroups is empty array', () => {
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', prior, current, []);
    expect(body).toContain('## Likely culprits');
  });

  it('Likely culprits section appears after Investigate section', () => {
    const groups = [{ signal: 'toolCount', candidates: [] }];
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', prior, current, groups);
    const investigateIdx = body.indexOf('## Investigate');
    const culpritsIdx = body.indexOf('## Likely culprits');
    expect(investigateIdx).toBeGreaterThan(-1);
    expect(culpritsIdx).toBeGreaterThan(investigateIdx);
  });

  it('renders multiple signal groups', () => {
    const groups = [
      {
        signal: 'toolCount',
        candidates: [
          { sha: 'abc12345678901234567890123456789012345678', message: 'feat: add tool' },
        ],
      },
      { signal: 'systemPromptChars', candidates: [] },
    ];
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest', prior, current, groups);
    expect(body).toContain('### toolCount');
    expect(body).toContain('### systemPromptChars');
    expect(body).toContain('No commits matched keywords for this signal');
  });
});
