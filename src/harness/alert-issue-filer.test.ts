import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractAlertTriggers,
  buildAlertIssueTitle,
  buildAlertIssueBody,
  fileAlertIssuesIfNeeded,
  findExistingAlertIssue,
  createAlertIssue,
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
  it('includes the metric name in the body', () => {
    const trigger = { metric: 'toolCount', fromValue: '21 tools', toValue: '18 tools', delta: '-3 tools' };
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest content here');
    expect(body).toContain('toolCount');
  });

  it('includes prior and current values', () => {
    const trigger = { metric: 'toolCount', fromValue: '21 tools', toValue: '18 tools', delta: '-3 tools' };
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest');
    expect(body).toContain('21 tools');
    expect(body).toContain('18 tools');
  });

  it('includes the delta', () => {
    const trigger = { metric: 'toolCount', fromValue: '21 tools', toValue: '18 tools', delta: '-3 tools' };
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest');
    expect(body).toContain('-3 tools');
  });

  it('includes the digest message in a code block', () => {
    const trigger = { metric: 'toolCount', fromValue: '21 tools', toValue: '18 tools', delta: '-3 tools' };
    const body = buildAlertIssueBody(trigger, '2026-07-07', '🚨 ALERT digest message');
    expect(body).toContain('🚨 ALERT digest message');
    expect(body).toContain('```');
  });

  it('includes the auto-filed footer', () => {
    const trigger = { metric: 'toolCount', fromValue: '21 tools', toValue: '18 tools', delta: '-3 tools' };
    const body = buildAlertIssueBody(trigger, '2026-07-07', 'digest');
    expect(body).toContain('Auto-filed by weekly-stability-digest');
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

    // First call: search → 0 results (no existing issue)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ total_count: 0, items: [] }),
    });
    // Second call: create issue → returns new issue number
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
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify the create-issue call has correct labels
    const createCall = mockFetch.mock.calls[1];
    const createBody = JSON.parse(createCall[1].body as string);
    expect(createBody.labels).toContain('status:needs-input');
    expect(createBody.labels).toContain('type:regression-alert');
    expect(createBody.title).toContain('[ALERT]');
    expect(createBody.title).toContain('toolCount');
  });

  it('deduplicates when an existing open alert issue is found', async () => {
    const mockFetch = vi.fn();

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
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns error outcome when GitHub search API fails', async () => {
    const mockFetch = vi.fn();
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
    expect(mockFetch).toHaveBeenCalledTimes(4); // 2 search + 2 create
  });

  it('continues processing remaining triggers even when one fails', async () => {
    const mockFetch = vi.fn();
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
