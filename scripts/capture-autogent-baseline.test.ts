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

import { captureBaseline } from './capture-autogent-baseline.js';

describe('capture-autogent-baseline --dry-run', () => {
  afterEach(() => {
    vi.clearAllMocks();
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
