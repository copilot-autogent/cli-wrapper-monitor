/**
 * Unit tests for archive-baselines.ts
 *
 * Tests core logic functions using real temporary directories so no fs mocking
 * is needed. The `now` parameter is injected so time-sensitive boundary cases
 * can be validated deterministically.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseDateFromFilename,
  computeCutoffDate,
  archiveBaselines,
} from './archive-baselines.js';

// ---------------------------------------------------------------------------
// parseDateFromFilename
// ---------------------------------------------------------------------------

describe('parseDateFromFilename', () => {
  it('parses a plain YYYY-MM-DD filename', () => {
    const d = parseDateFromFilename('2026-01-15.json');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(0); // January
    expect(d!.getDate()).toBe(15);
  });

  it('parses a filename with a suffix (e.g. 2026-06-14-pre-migration.json)', () => {
    const d = parseDateFromFilename('2026-06-14-pre-migration.json');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(5); // June
    expect(d!.getDate()).toBe(14);
  });

  it('returns null for schema.json', () => {
    expect(parseDateFromFilename('schema.json')).toBeNull();
  });

  it('returns null for latest.json', () => {
    expect(parseDateFromFilename('latest.json')).toBeNull();
  });

  it('returns null for filenames without a leading date', () => {
    expect(parseDateFromFilename('report-2026-01-01.json')).toBeNull();
  });

  it('returns null for invalid month', () => {
    expect(parseDateFromFilename('2026-13-01.json')).toBeNull();
  });

  it('returns null for invalid day', () => {
    expect(parseDateFromFilename('2026-01-00.json')).toBeNull();
  });

  it('returns null for impossible date (Feb 30)', () => {
    expect(parseDateFromFilename('2026-02-30.json')).toBeNull();
  });

  it('returns null for filenames where garbage immediately follows the date (no dash or .json)', () => {
    expect(parseDateFromFilename('2026-01-15garbage.json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeCutoffDate
// ---------------------------------------------------------------------------

describe('computeCutoffDate', () => {
  it('subtracts N months from now and normalises to midnight', () => {
    const now = new Date('2026-07-15T12:30:00');
    const cutoff = computeCutoffDate(now, 6);
    expect(cutoff.getFullYear()).toBe(2026);
    expect(cutoff.getMonth()).toBe(0); // January (7 - 6 = 1 → index 0)
    expect(cutoff.getDate()).toBe(15);
    expect(cutoff.getHours()).toBe(0);
    expect(cutoff.getMinutes()).toBe(0);
  });

  it('handles month underflow across year boundary', () => {
    const now = new Date('2026-03-01T00:00:00');
    const cutoff = computeCutoffDate(now, 6);
    expect(cutoff.getFullYear()).toBe(2025);
    expect(cutoff.getMonth()).toBe(8); // September (3 - 6 = -3 → wraps to Sep 2025)
    expect(cutoff.getDate()).toBe(1);
  });

  it('clamps month-end overflow (Aug 31 − 6 months = Feb 28, not Mar 3)', () => {
    const now = new Date(2026, 7, 31, 12, 0, 0); // August 31, 2026
    const cutoff = computeCutoffDate(now, 6);
    expect(cutoff.getFullYear()).toBe(2026);
    expect(cutoff.getMonth()).toBe(1); // February
    expect(cutoff.getDate()).toBe(28); // Clamped to Feb 28 (non-leap year)
    expect(cutoff.getHours()).toBe(0);
  });

  it('clamps month-end overflow across year boundary (Mar 31 − 6 months = Sep 30)', () => {
    const now = new Date(2026, 2, 31, 0, 0, 0); // March 31, 2026
    const cutoff = computeCutoffDate(now, 6);
    expect(cutoff.getFullYear()).toBe(2025);
    expect(cutoff.getMonth()).toBe(8); // September
    expect(cutoff.getDate()).toBe(30); // Clamped to Sep 30
  });
});

// ---------------------------------------------------------------------------
// archiveBaselines — integration tests with real temp directories
// ---------------------------------------------------------------------------

describe('archiveBaselines', () => {
  let tmpBase: string;

  // Fixed reference "today": 2026-07-02
  // Cutoff (6 months): 2026-01-02
  // → files < 2026-01-02 are archived; files >= 2026-01-02 are kept
  const NOW = new Date('2026-07-02T12:00:00');

  function writeBaseline(filename: string): void {
    writeFileSync(join(tmpBase, filename), JSON.stringify({ capturedAt: filename }), 'utf-8');
  }

  beforeEach(() => {
    tmpBase = join(tmpdir(), `archive-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpBase, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('archives a file older than 6 months', () => {
    writeBaseline('2025-12-01.json'); // older than 6 months → archive
    const result = archiveBaselines(tmpBase, 6, false, NOW);

    expect(result.archived).toEqual(['2025-12-01.json']);
    expect(result.kept).toEqual([]);
    expect(result.skipped).toEqual([]);

    // File must exist in archive/2025/ and be gone from root
    expect(existsSync(join(tmpBase, 'archive', '2025', '2025-12-01.json'))).toBe(true);
    expect(existsSync(join(tmpBase, '2025-12-01.json'))).toBe(false);
  });

  it('keeps a file within 6 months', () => {
    writeBaseline('2026-06-15.json'); // within 6 months → keep
    const result = archiveBaselines(tmpBase, 6, false, NOW);

    expect(result.archived).toEqual([]);
    expect(result.kept).toEqual(['2026-06-15.json']);

    // File must still be in root
    expect(existsSync(join(tmpBase, '2026-06-15.json'))).toBe(true);
  });

  it('keeps a file at the exact 6-month boundary (not strictly older)', () => {
    // Cutoff is 2026-01-02; a file dated 2026-01-02 is NOT strictly older
    writeBaseline('2026-01-02.json');
    const result = archiveBaselines(tmpBase, 6, false, NOW);

    expect(result.kept).toContain('2026-01-02.json');
    expect(result.archived).not.toContain('2026-01-02.json');
    expect(existsSync(join(tmpBase, '2026-01-02.json'))).toBe(true);
  });

  it('archives a file one day before the boundary', () => {
    // 2026-01-01 is strictly before cutoff 2026-01-02
    writeBaseline('2026-01-01.json');
    const result = archiveBaselines(tmpBase, 6, false, NOW);

    expect(result.archived).toContain('2026-01-01.json');
    expect(existsSync(join(tmpBase, 'archive', '2026', '2026-01-01.json'))).toBe(true);
    expect(existsSync(join(tmpBase, '2026-01-01.json'))).toBe(false);
  });

  it('archives files into the correct year subdirectory', () => {
    writeBaseline('2024-06-01.json');
    writeBaseline('2025-06-01.json');
    archiveBaselines(tmpBase, 6, false, NOW);

    expect(existsSync(join(tmpBase, 'archive', '2024', '2024-06-01.json'))).toBe(true);
    expect(existsSync(join(tmpBase, 'archive', '2025', '2025-06-01.json'))).toBe(true);
  });

  it('skips schema.json and latest.json', () => {
    writeFileSync(join(tmpBase, 'schema.json'), '{}', 'utf-8');
    writeFileSync(join(tmpBase, 'latest.json'), '{}', 'utf-8');
    const result = archiveBaselines(tmpBase, 6, false, NOW);

    expect(result.archived).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(result.skipped).toEqual([]);

    // Both must remain in place
    expect(existsSync(join(tmpBase, 'schema.json'))).toBe(true);
    expect(existsSync(join(tmpBase, 'latest.json'))).toBe(true);
  });

  it('skips files whose names do not start with a date', () => {
    writeFileSync(join(tmpBase, 'summary.json'), '{}', 'utf-8');
    const result = archiveBaselines(tmpBase, 6, false, NOW);

    expect(result.skipped).toContain('summary.json');
    expect(existsSync(join(tmpBase, 'summary.json'))).toBe(true);
  });

  it('is idempotent: running twice produces the same outcome', () => {
    writeBaseline('2025-01-10.json');
    archiveBaselines(tmpBase, 6, false, NOW);
    // Second run: file is no longer in baselines/ root, so result is empty
    const result2 = archiveBaselines(tmpBase, 6, false, NOW);

    expect(result2.archived).toEqual([]);
    // File is still in the archive from the first run
    expect(existsSync(join(tmpBase, 'archive', '2025', '2025-01-10.json'))).toBe(true);
  });

  it('dry-run does not move any files', () => {
    writeBaseline('2025-03-01.json');
    const result = archiveBaselines(tmpBase, 6, true, NOW);

    expect(result.archived).toContain('2025-03-01.json');
    // File must still be in root (not moved)
    expect(existsSync(join(tmpBase, '2025-03-01.json'))).toBe(true);
    expect(existsSync(join(tmpBase, 'archive'))).toBe(false);
  });

  it('handles a mix of old, new, and boundary files', () => {
    writeBaseline('2025-12-31.json'); // old → archive
    writeBaseline('2026-01-01.json'); // one day before cutoff → archive
    writeBaseline('2026-01-02.json'); // boundary → keep
    writeBaseline('2026-06-15.json'); // recent → keep

    const result = archiveBaselines(tmpBase, 6, false, NOW);

    expect(result.archived).toEqual(['2025-12-31.json', '2026-01-01.json']);
    expect(result.kept).toEqual(['2026-01-02.json', '2026-06-15.json']);
  });

  it('respects custom --older-than-months threshold', () => {
    // With a 12-month window, cutoff is 2025-07-02
    writeBaseline('2025-06-30.json'); // older than 12 months → archive
    writeBaseline('2025-07-03.json'); // within 12 months → keep

    const result = archiveBaselines(tmpBase, 12, false, NOW);

    expect(result.archived).toContain('2025-06-30.json');
    expect(result.kept).toContain('2025-07-03.json');
  });

  it('throws when the baselines directory does not exist', () => {
    const missing = join(tmpBase, 'nonexistent-subdir');
    expect(() => archiveBaselines(missing, 6, false, NOW)).toThrow(/not found/);
  });
});
