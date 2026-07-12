/**
 * Unit tests for scripts/check-capture-staleness.ts
 *
 * All filesystem and date access is controlled via the injectable `deps`
 * parameter so tests run without touching real disk or system clocks.
 */
import { describe, it, expect } from 'vitest';
import {
  extractDateFromFilename,
  findMostRecentBaseline,
  checkMonthlyBaseline,
  checkWeeklyBaseline,
  checkHealthStreak,
  checkStaleness,
  MONTHLY_CAPTURE_DOM,
  MONTHLY_GRACE_DAYS,
  WEEKLY_STALENESS_THRESHOLD_DAYS,
} from './check-capture-staleness.js';
import type { StalenessCheckDeps } from './check-capture-staleness.js';
import type { HealthLogEntry } from '../src/harness/capture-health.js';
import { FAILURE_STREAK_THRESHOLD } from '../src/harness/capture-health.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDate(isoDate: string): Date {
  return new Date(isoDate + 'T06:00:00Z'); // simulate 06:00 UTC when check runs
}

function makeEntry(status: 'success' | 'error'): HealthLogEntry {
  return {
    capturedAt: new Date().toISOString(),
    status,
    durationMs: 500,
    baselinesDir: '/baselines',
  };
}

function makeDeps(overrides: Partial<StalenessCheckDeps> = {}): StalenessCheckDeps {
  return {
    monthlyDir: '/baselines',
    weeklyDir: '/baselines/weekly',
    healthLogPath: '/logs/capture-health.jsonl',
    existsSyncFn: () => true,
    readdirSyncFn: () => [],
    readHealthLogFn: () => [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractDateFromFilename
// ---------------------------------------------------------------------------

describe('extractDateFromFilename', () => {
  it('extracts YYYY-MM-DD from plain date filename', () => {
    expect(extractDateFromFilename('2026-06-03.json')).toBe('2026-06-03');
  });

  it('extracts date from filename with suffix', () => {
    expect(extractDateFromFilename('2026-06-14-pre-migration.json')).toBe('2026-06-14');
  });

  it('returns null for non-date filenames', () => {
    expect(extractDateFromFilename('latest.json')).toBeNull();
    expect(extractDateFromFilename('schema.json')).toBeNull();
    expect(extractDateFromFilename('README.md')).toBeNull();
  });

  it('returns null for partial date patterns', () => {
    expect(extractDateFromFilename('2026-06.json')).toBeNull();
    expect(extractDateFromFilename('26-06-03.json')).toBeNull();
  });

  it('returns null for semantically invalid dates (e.g. month 99)', () => {
    expect(extractDateFromFilename('2026-99-01.json')).toBeNull();
    expect(extractDateFromFilename('2026-01-99.json')).toBeNull();
    expect(extractDateFromFilename('9999-99-99.json')).toBeNull();
  });

  it('returns null for overflow calendar dates (e.g. Feb 31)', () => {
    expect(extractDateFromFilename('2026-02-31.json')).toBeNull();
    expect(extractDateFromFilename('2026-04-31.json')).toBeNull(); // April has 30 days
  });

  it('extracts YYYY-MM-DD from weekly snapshot filename', () => {
    expect(extractDateFromFilename('snapshot-2026-07-06T04-19-38-596Z.json')).toBe('2026-07-06');
  });

  it('extracts date from snapshot filename with different timestamp formats', () => {
    expect(extractDateFromFilename('snapshot-2026-01-15T12-00-00-000Z.json')).toBe('2026-01-15');
    expect(extractDateFromFilename('snapshot-2025-12-31T23-59-59-999Z.json')).toBe('2025-12-31');
  });

  it('returns null for snapshot filename without T separator', () => {
    expect(extractDateFromFilename('snapshot-2026-07-06.json')).toBeNull();
  });

  it('returns null for snapshot filename with invalid date', () => {
    expect(extractDateFromFilename('snapshot-2026-99-01T00-00-00-000Z.json')).toBeNull();
    expect(extractDateFromFilename('snapshot-2026-02-31T00-00-00-000Z.json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findMostRecentBaseline
// ---------------------------------------------------------------------------

describe('findMostRecentBaseline', () => {
  it('returns null when directory does not exist', () => {
    const deps = makeDeps({ existsSyncFn: () => false });
    expect(findMostRecentBaseline('/baselines', deps)).toBeNull();
  });

  it('returns null when directory has no date files', () => {
    const deps = makeDeps({ readdirSyncFn: () => ['latest.json', 'schema.json'] });
    expect(findMostRecentBaseline('/baselines', deps)).toBeNull();
  });

  it('returns the most recent date from multiple files', () => {
    const deps = makeDeps({
      readdirSyncFn: () => ['2026-05-20.json', '2026-06-03.json', '2026-05-31.json'],
    });
    expect(findMostRecentBaseline('/baselines', deps)).toBe('2026-06-03');
  });

  it('handles mixed date and non-date filenames', () => {
    const deps = makeDeps({
      readdirSyncFn: () => ['schema.json', '2026-05-20.json', 'latest.json', '2026-06-16-post-migration.json'],
    });
    expect(findMostRecentBaseline('/baselines', deps)).toBe('2026-06-16');
  });

  it('returns a single date file correctly', () => {
    const deps = makeDeps({ readdirSyncFn: () => ['2026-07-03.json'] });
    expect(findMostRecentBaseline('/baselines', deps)).toBe('2026-07-03');
  });

  it('resolves weekly snapshot files alongside latest.json', () => {
    const deps = makeDeps({
      readdirSyncFn: () => ['latest.json', 'snapshot-2026-07-06T04-19-38-596Z.json'],
    });
    expect(findMostRecentBaseline('/baselines/weekly', deps)).toBe('2026-07-06');
  });

  it('returns most recent date when mixing flat monthly and weekly snapshot filenames', () => {
    const deps = makeDeps({
      readdirSyncFn: () => [
        'latest.json',
        '2026-06-30.json',
        'snapshot-2026-07-06T04-19-38-596Z.json',
      ],
    });
    expect(findMostRecentBaseline('/baselines/weekly', deps)).toBe('2026-07-06');
  });

  it('rejects non-timestamp snapshot files (e.g. Tgarbage after date)', () => {
    const deps = makeDeps({
      readdirSyncFn: () => ['latest.json', 'snapshot-2026-07-06Tgarbage.json'],
    });
    expect(findMostRecentBaseline('/baselines/weekly', deps)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkMonthlyBaseline
// ---------------------------------------------------------------------------

describe('checkMonthlyBaseline', () => {
  const alertThresholdDom = MONTHLY_CAPTURE_DOM + MONTHLY_GRACE_DAYS; // 4

  it('is NOT stale when capture exists this month', () => {
    const deps = makeDeps({
      now: makeDate('2026-07-10'),
      readdirSyncFn: () => ['2026-07-03.json'],
    });
    const result = checkMonthlyBaseline(deps);
    expect(result.stale).toBe(false);
    expect(result.lastCaptured).toBe('2026-07-03');
    expect(result.message).toContain('✅');
  });

  it('is NOT stale when today is before the alert threshold (grace period)', () => {
    // Today is the 3rd — capture just ran or is expected today; grace period active
    const deps = makeDeps({
      now: makeDate(`2026-07-0${MONTHLY_CAPTURE_DOM}`),
      readdirSyncFn: () => [], // no capture yet
    });
    const result = checkMonthlyBaseline(deps);
    expect(result.stale).toBe(false);
    expect(result.message).toContain('not yet expected');
  });

  it('is NOT stale on day 1 of month (capture not scheduled yet)', () => {
    const deps = makeDeps({
      now: makeDate('2026-07-01'),
      readdirSyncFn: () => ['2026-06-03.json'], // last month's capture
    });
    const result = checkMonthlyBaseline(deps);
    expect(result.stale).toBe(false);
  });

  it('is NOT stale on the day before alert threshold', () => {
    const dayBeforeThreshold = alertThresholdDom - 1; // day 3
    const deps = makeDeps({
      now: makeDate(`2026-07-0${dayBeforeThreshold}`),
      readdirSyncFn: () => [],
    });
    const result = checkMonthlyBaseline(deps);
    expect(result.stale).toBe(false);
  });

  it('IS stale on alert threshold day with no capture this month', () => {
    // Day 4 with no capture for this month
    const deps = makeDeps({
      now: makeDate(`2026-07-0${alertThresholdDom}`),
      readdirSyncFn: () => ['2026-06-03.json'], // only last month
    });
    const result = checkMonthlyBaseline(deps);
    expect(result.stale).toBe(true);
    expect(result.message).toContain('⚠️');
    expect(result.message).toContain('2026-07');
  });

  it('IS stale later in month with no capture', () => {
    const deps = makeDeps({
      now: makeDate('2026-07-15'),
      readdirSyncFn: () => ['2026-06-03.json', '2026-05-20.json'],
    });
    const result = checkMonthlyBaseline(deps);
    expect(result.stale).toBe(true);
    expect(result.lastCaptured).toBe('2026-06-03');
  });

  it('IS stale when no baselines exist at all', () => {
    const deps = makeDeps({
      now: makeDate('2026-07-10'),
      readdirSyncFn: () => [],
    });
    const result = checkMonthlyBaseline(deps);
    expect(result.stale).toBe(true);
    expect(result.lastCaptured).toBeNull();
    expect(result.message).toContain('never');
  });

  it('IS stale when only a future-dated baseline exists this month', () => {
    const deps = makeDeps({
      now: makeDate('2026-07-10'),
      readdirSyncFn: () => ['2026-07-31.json'], // future date this month
    });
    const result = checkMonthlyBaseline(deps);
    expect(result.stale).toBe(true);
  });

  it('is NOT stale when monthly dir does not exist but today is in grace period', () => {
    const deps = makeDeps({
      now: makeDate('2026-07-02'),
      existsSyncFn: () => false,
    });
    const result = checkMonthlyBaseline(deps);
    expect(result.stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkWeeklyBaseline
// ---------------------------------------------------------------------------

describe('checkWeeklyBaseline', () => {
  it('is NOT stale when capture is within threshold', () => {
    const now = makeDate('2026-07-10'); // Thursday
    const deps = makeDeps({
      now,
      weeklyDir: '/baselines/weekly',
      readdirSyncFn: (dir) => {
        if (dir === '/baselines/weekly') return ['2026-07-07.json']; // 3 days ago
        return [];
      },
    });
    const result = checkWeeklyBaseline(deps);
    expect(result.stale).toBe(false);
    expect(result.lastCaptured).toBe('2026-07-07');
    expect(result.message).toContain('✅');
    expect(result.message).toContain('3 day(s)');
  });

  it('IS stale when last capture is exactly at threshold', () => {
    // now = 2026-07-16, lastDate = 2026-07-07 → 9 calendar days apart (stale)
    const now = makeDate('2026-07-16');
    const lastDate = '2026-07-07'; // exactly 9 days before 2026-07-16
    const deps = makeDeps({
      now,
      weeklyDir: '/baselines/weekly',
      readdirSyncFn: (dir) => {
        if (dir === '/baselines/weekly') return [`${lastDate}.json`];
        return [];
      },
    });
    const result = checkWeeklyBaseline(deps);
    expect(result.stale).toBe(true);
  });

  it('IS stale when no weekly baselines directory exists', () => {
    const deps = makeDeps({
      now: makeDate('2026-07-10'),
      existsSyncFn: () => false,
    });
    const result = checkWeeklyBaseline(deps);
    expect(result.stale).toBe(true);
    expect(result.lastCaptured).toBeNull();
    expect(result.message).toContain('⚠️');
  });

  it('IS stale when weekly dir is empty', () => {
    const deps = makeDeps({
      now: makeDate('2026-07-10'),
      readdirSyncFn: () => [],
    });
    const result = checkWeeklyBaseline(deps);
    expect(result.stale).toBe(true);
  });

  it('IS stale when last capture is older than threshold', () => {
    const now = makeDate('2026-07-20');
    const deps = makeDeps({
      now,
      readdirSyncFn: () => ['2026-07-07.json'], // 13 days ago
    });
    const result = checkWeeklyBaseline(deps);
    expect(result.stale).toBe(true);
    expect(result.message).toContain('13 day(s)');
  });

  it('is NOT stale when capture is 8 days ago (within 9-day threshold)', () => {
    const now = makeDate('2026-07-15');
    const deps = makeDeps({
      now,
      readdirSyncFn: () => ['2026-07-07.json'], // 8 days ago
    });
    const result = checkWeeklyBaseline(deps);
    expect(result.stale).toBe(false);
    expect(result.message).toContain('8 day(s)');
  });

  it('is NOT stale when last baseline is future-dated (treats as 0 days old)', () => {
    const now = makeDate('2026-07-10');
    const deps = makeDeps({
      now,
      readdirSyncFn: () => ['2026-07-31.json'], // future date
    });
    const result = checkWeeklyBaseline(deps);
    expect(result.stale).toBe(false);
    expect(result.message).toContain('0 day(s)');
  });

  it('picks the most recent file from multiple weekly captures', () => {
    const now = makeDate('2026-07-15');
    const deps = makeDeps({
      now,
      readdirSyncFn: () => ['2026-06-23.json', '2026-07-07.json', '2026-06-16.json'],
    });
    const result = checkWeeklyBaseline(deps);
    expect(result.lastCaptured).toBe('2026-07-07');
    expect(result.stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkHealthStreak
// ---------------------------------------------------------------------------

describe('checkHealthStreak', () => {
  it('is NOT stale when health log is empty', () => {
    const deps = makeDeps({ readHealthLogFn: () => [] });
    const result = checkHealthStreak(deps);
    expect(result.stale).toBe(false);
    expect(result.message).toContain('no entries');
  });

  it('is NOT stale when failures are below threshold', () => {
    const entries = Array.from({ length: FAILURE_STREAK_THRESHOLD - 1 }, () => makeEntry('error'));
    const deps = makeDeps({ readHealthLogFn: () => entries });
    const result = checkHealthStreak(deps);
    expect(result.stale).toBe(false);
    expect(result.message).toContain('below alert threshold');
  });

  it('IS stale when failures equal threshold', () => {
    const entries = Array.from({ length: FAILURE_STREAK_THRESHOLD }, () => makeEntry('error'));
    const deps = makeDeps({ readHealthLogFn: () => entries });
    const result = checkHealthStreak(deps);
    expect(result.stale).toBe(true);
    expect(result.message).toContain('⚠️');
    expect(result.message).toContain(`${FAILURE_STREAK_THRESHOLD} consecutive failure`);
  });

  it('IS stale when failures exceed threshold', () => {
    const entries = Array.from({ length: FAILURE_STREAK_THRESHOLD + 2 }, () => makeEntry('error'));
    const deps = makeDeps({ readHealthLogFn: () => entries });
    const result = checkHealthStreak(deps);
    expect(result.stale).toBe(true);
  });

  it('is NOT stale when streak is broken by a recent success', () => {
    const entries = [
      ...Array.from({ length: FAILURE_STREAK_THRESHOLD }, () => makeEntry('error')),
      makeEntry('success'),
    ];
    const deps = makeDeps({ readHealthLogFn: () => entries });
    const result = checkHealthStreak(deps);
    expect(result.stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkStaleness (orchestrator)
// ---------------------------------------------------------------------------

describe('checkStaleness', () => {
  it('returns overallStale=false when all checks pass', () => {
    const now = makeDate('2026-07-10');
    const deps = makeDeps({
      now,
      readdirSyncFn: (dir) => {
        if (dir === '/baselines/weekly') return ['2026-07-07.json'];
        return ['2026-07-03.json'];
      },
      readHealthLogFn: () => [makeEntry('success')],
    });
    const report = checkStaleness(deps);
    expect(report.overallStale).toBe(false);
    expect(report.monthly.stale).toBe(false);
    expect(report.weekly.stale).toBe(false);
    expect(report.healthStreak.stale).toBe(false);
    expect(report.checkedAt).toBe(now.toISOString());
  });

  it('returns overallStale=true when monthly is stale', () => {
    const deps = makeDeps({
      now: makeDate('2026-07-15'),
      readdirSyncFn: (dir) => {
        if (dir === '/baselines/weekly') return ['2026-07-13.json'];
        return ['2026-06-03.json']; // no July capture
      },
      readHealthLogFn: () => [makeEntry('success')],
    });
    const report = checkStaleness(deps);
    expect(report.overallStale).toBe(true);
    expect(report.monthly.stale).toBe(true);
    expect(report.weekly.stale).toBe(false);
    expect(report.healthStreak.stale).toBe(false);
  });

  it('returns overallStale=true when weekly is stale', () => {
    const deps = makeDeps({
      now: makeDate('2026-07-10'),
      readdirSyncFn: (dir) => {
        if (dir === '/baselines/weekly') return ['2026-06-20.json']; // 20 days ago
        return ['2026-07-03.json'];
      },
      readHealthLogFn: () => [makeEntry('success')],
    });
    const report = checkStaleness(deps);
    expect(report.overallStale).toBe(true);
    expect(report.weekly.stale).toBe(true);
  });

  it('returns overallStale=true when health streak is stale', () => {
    const deps = makeDeps({
      now: makeDate('2026-07-10'),
      readdirSyncFn: (dir) => {
        if (dir === '/baselines/weekly') return ['2026-07-07.json'];
        return ['2026-07-03.json'];
      },
      readHealthLogFn: () => Array.from({ length: FAILURE_STREAK_THRESHOLD }, () => makeEntry('error')),
    });
    const report = checkStaleness(deps);
    expect(report.overallStale).toBe(true);
    expect(report.healthStreak.stale).toBe(true);
  });

  it('reports all three dimensions independently', () => {
    const errors = Array.from({ length: FAILURE_STREAK_THRESHOLD }, () => makeEntry('error'));
    const deps = makeDeps({
      now: makeDate('2026-07-20'),
      readdirSyncFn: () => [], // no baselines anywhere
      readHealthLogFn: () => errors,
    });
    const report = checkStaleness(deps);
    expect(report.monthly.stale).toBe(true);
    expect(report.weekly.stale).toBe(true);
    expect(report.healthStreak.stale).toBe(true);
    expect(report.overallStale).toBe(true);
  });
});
