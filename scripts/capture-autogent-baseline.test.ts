/**
 * Unit tests for --dry-run mode in capture-autogent-baseline.ts.
 *
 * Verifies that no files are written when --dry-run is active by mocking
 * the node:fs module and asserting writeFileSync is never called.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// ── SDK mock ──────────────────────────────────────────────────────────────
// Prevent real CopilotClient subprocess spawning during tests.
vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([]),
    disconnect: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ── models-api-client mock ─────────────────────────────────────────────────
// Return false so the refusal-rate experiment is not registered and no
// live API calls are made during the test.
vi.mock('../src/harness/models-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/harness/models-api-client.js')>();
  return { ...actual, hasGitHubToken: vi.fn().mockReturnValue(false) };
});

// ── fs mock ───────────────────────────────────────────────────────────────
// Use vi.hoisted so the spy is available inside the hoisted vi.mock factory.
const { writeFileSyncSpy } = vi.hoisted(() => ({
  writeFileSyncSpy: vi.fn(),
}));

// Intercept all file writes; existsSync returns false so autogent extraction
// short-circuits cleanly. readFileSync handles the one real read needed by
// ExperimentRunner (package.json) and throws ENOENT for everything else.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: writeFileSyncSpy,
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockImplementation((p: unknown) => {
      if (String(p).endsWith('package.json')) {
        return JSON.stringify({
          dependencies: { '@github/copilot-sdk': '^0.2.2' },
        });
      }
      const err = Object.assign(new Error(`ENOENT: no such file or directory, open '${String(p)}'`), {
        code: 'ENOENT',
      });
      throw err;
    }),
  };
});

import {
  captureBaseline,
  classifyRefusalCaptureStatus,
  captureToolSearchFromEnvironment,
} from './capture-autogent-baseline.js';
import type { ExperimentResult } from '../src/harness/types.js';

describe('capture-autogent-baseline --dry-run', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('captureToolSearchFromEnvironment', () => {
    const tools = [{ name: 'search_code' }, { name: 'read_file' }];

    it('returns no field when runtime tool-search data was not supplied', () => {
      expect(captureToolSearchFromEnvironment(tools, {})).toBeUndefined();
      expect(
        captureToolSearchFromEnvironment(tools, { TOOL_SEARCH_ENABLED: 'true' }),
      ).toBeUndefined();
    });

    it('normalizes deterministic deferred-tool and reference capture data', () => {
      expect(
        captureToolSearchFromEnvironment(tools, {
          TOOL_SEARCH_ENABLED: 'true',
          DEFERRED_TOOL_NAMES: 'read_file, search_code, missing_tool, read_file',
          TOOL_REFERENCES: 'search_code,read_file,search_code',
        }),
      ).toEqual({
        enabled: true,
        deferredToolNames: ['missing_tool', 'read_file', 'search_code'],
        toolReferences: ['read_file', 'search_code'],
      });
    });
  });

  describe('classifyRefusalCaptureStatus', () => {
    const result = (
      probes?: Array<{ apiError?: boolean }>,
      error?: string,
    ): ExperimentResult => ({
      name: 'refusal-rate',
      description: 'test',
      metrics: {},
      rawData: probes === undefined ? undefined : { probes },
      ...(error !== undefined && { error }),
    });

    it('marks an absent probe array as an error', () => {
      expect(classifyRefusalCaptureStatus(result())).toBe('error');
    });

    it('marks an empty probe array as an error', () => {
      expect(classifyRefusalCaptureStatus(result([]))).toBe('error');
    });

    it('marks an errored run with no probes as an error', () => {
      expect(classifyRefusalCaptureStatus(result([], 'capture failed'))).toBe('error');
    });

    it('preserves existing partial status for usable probes', () => {
      expect(
        classifyRefusalCaptureStatus(result([{ apiError: false }]), 'partial'),
      ).toBe('partial');
    });

    it('preserves existing status when an errored run has partial probe data', () => {
      expect(
        classifyRefusalCaptureStatus(
          result([{ apiError: false }], 'transient failure'),
          'partial',
        ),
      ).toBe('partial');
    });

    it('marks a capture invalid when half of probes are API errors', () => {
      expect(
        classifyRefusalCaptureStatus(
          result([{ apiError: true }, { apiError: false }]),
        ),
      ).toBe('error');
    });
  });

  it('does not call fs.writeFileSync when dryRun is true', async () => {
    await captureBaseline({ dryRun: true });
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('prints "DRY RUN — no files written" to stdout', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await captureBaseline({ dryRun: true });
      const messages = consoleSpy.mock.calls.map((c) => String(c[0]));
      expect(messages).toContain('DRY RUN — no files written');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
