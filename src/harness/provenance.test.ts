import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchProvenanceLinks } from './provenance.js';

describe('fetchProvenanceLinks', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv['GITHUB_TOKEN'] = process.env['GITHUB_TOKEN'];
    savedEnv['GH_TOKEN'] = process.env['GH_TOKEN'];
    savedEnv['GITHUB_API_TOKEN'] = process.env['GITHUB_API_TOKEN'];
    delete process.env['GITHUB_TOKEN'];
    delete process.env['GH_TOKEN'];
    delete process.env['GITHUB_API_TOKEN'];
  });

  afterEach(() => {
    // Restore env
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    vi.restoreAllMocks();
  });

  it('returns [] when no token is available', async () => {
    const result = await fetchProvenanceLinks(
      '2026-06-01T00:00:00Z',
      '2026-06-19T00:00:00Z',
    );
    expect(result).toEqual([]);
  });

  it('returns [] on search API network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const result = await fetchProvenanceLinks(
      '2026-06-01T00:00:00Z',
      '2026-06-19T00:00:00Z',
      'fake-token',
    );
    expect(result).toEqual([]);
  });

  it('returns [] when search API returns error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({}),
      }),
    );
    const result = await fetchProvenanceLinks(
      '2026-06-01T00:00:00Z',
      '2026-06-19T00:00:00Z',
      'fake-token',
    );
    expect(result).toEqual([]);
  });

  it('returns [] when no PRs match provenance paths', async () => {
    const mockFetch = vi.fn();
    // Search API returns one PR
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            number: 100,
            title: 'Fix docs',
            pull_request: { merged_at: '2026-06-10T12:00:00Z' },
          },
        ],
      }),
    });
    // Files for PR #100: doesn't touch provenance paths
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ filename: 'README.md' }, { filename: 'docs/foo.md' }],
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchProvenanceLinks(
      '2026-06-01T00:00:00Z',
      '2026-06-19T00:00:00Z',
      'fake-token',
    );
    expect(result).toEqual([]);
  });

  it('matches PR touching src/tools/builtin/', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            number: 612,
            title: 'Add tool: verify_deploy',
            pull_request: { merged_at: '2026-06-15T10:00:00Z' },
          },
        ],
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { filename: 'src/tools/builtin/verify-deploy.ts' },
        { filename: 'src/tools/builtin/index.ts' },
        { filename: 'README.md' },
      ],
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchProvenanceLinks(
      '2026-06-01T00:00:00Z',
      '2026-06-19T00:00:00Z',
      'fake-token',
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      pr: 'JackywithaWhiteDog/autogent#612',
      title: 'Add tool: verify_deploy',
      mergedAt: '2026-06-15',
      touchedPaths: ['src/tools/builtin/'],
    });
  });

  it('matches PR touching multiple provenance paths', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            number: 700,
            title: 'Big refactor',
            pull_request: { merged_at: '2026-06-17T08:00:00Z' },
          },
        ],
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { filename: 'src/workspace/index.ts' },
        { filename: 'src/hooks/index.ts' },
        { filename: 'src/tools/builtin/new-tool.ts' },
      ],
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchProvenanceLinks(
      '2026-06-01T00:00:00Z',
      '2026-06-19T00:00:00Z',
      'fake-token',
    );
    expect(result).toHaveLength(1);
    expect(result[0].touchedPaths).toHaveLength(3);
    expect(result[0].touchedPaths).toContain('src/workspace/');
    expect(result[0].touchedPaths).toContain('src/hooks/');
    expect(result[0].touchedPaths).toContain('src/tools/builtin/');
  });

  it('skips PRs where file fetch fails and still returns others', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            number: 501,
            title: 'Fix A',
            pull_request: { merged_at: '2026-06-10T00:00:00Z' },
          },
          {
            number: 502,
            title: 'Fix B',
            pull_request: { merged_at: '2026-06-11T00:00:00Z' },
          },
        ],
      }),
    });
    // PR 501 files: network error
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    // PR 502 files: touches hooks
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ filename: 'src/hooks/index.ts' }],
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchProvenanceLinks(
      '2026-06-01T00:00:00Z',
      '2026-06-19T00:00:00Z',
      'fake-token',
    );
    expect(result).toHaveLength(1);
    expect(result[0].pr).toBe('JackywithaWhiteDog/autogent#502');
  });

  it('uses GH_TOKEN env var when no explicit token passed', async () => {
    process.env['GH_TOKEN'] = 'env-token';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchProvenanceLinks('2026-06-01T00:00:00Z', '2026-06-19T00:00:00Z');

    const calls = mockFetch.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const headers = calls[0][1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer env-token');
  });
});
