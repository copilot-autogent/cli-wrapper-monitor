/**
 * Capture health report — reads logs/capture-health.jsonl and prints a summary.
 *
 * Usage:
 *   npm run health
 *   npx tsx scripts/capture-health-report.ts
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readHealthLog,
  consecutiveFailureCount,
  FAILURE_STREAK_THRESHOLD,
} from '../src/harness/capture-health.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, '../logs/capture-health.jsonl');
const LAST_N = 5;

const entries = readHealthLog(LOG_PATH);

if (entries.length === 0) {
  console.log('No capture health entries found.');
  console.log(`Log path: ${LOG_PATH}`);
  process.exit(0);
}

const total = entries.length;
const successes = entries.filter((e) => e.status === 'success').length;
const errors = total - successes;
const successRate = ((successes / total) * 100).toFixed(1);

console.log('=== Capture Health Report ===\n');
console.log(`Total attempts : ${total}`);
console.log(`Successes      : ${successes}`);
console.log(`Errors         : ${errors}`);
console.log(`Success rate   : ${successRate}%\n`);

const lastN = entries.slice(-LAST_N);
console.log(`Last ${LAST_N} attempts (most recent last):`);
for (const e of lastN) {
  const ts = e.capturedAt;
  const dur = `${e.durationMs}ms`;
  if (e.status === 'success') {
    console.log(`  ✓ ${ts}  (${dur})`);
  } else {
    const detail = e.errorType ? ` [${e.errorType}]` : '';
    const msg = e.errorMessage ? ` — ${e.errorMessage}` : '';
    console.log(`  ✗ ${ts}  (${dur})${detail}${msg}`);
  }
}

const streak = consecutiveFailureCount(entries);
if (streak > 0) {
  console.log(`\nConsecutive trailing errors: ${streak}`);
  if (streak >= FAILURE_STREAK_THRESHOLD) {
    console.warn(
      `\n⚠️  WARNING: ${streak} consecutive capture failures detected!\n` +
        '   Investigate capture reliability — check API auth, network, and model availability.',
    );
  }
}

const lastEntry = entries[entries.length - 1]!;
if (lastEntry.status === 'error') {
  console.log('\nMost recent error:');
  console.log(`  Type   : ${lastEntry.errorType ?? '(unknown)'}`);
  console.log(`  Message: ${lastEntry.errorMessage ?? '(none)'}`);
}
