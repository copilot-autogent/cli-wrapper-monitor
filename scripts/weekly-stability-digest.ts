#!/usr/bin/env -S npx tsx
/**
 * weekly-stability-digest.ts
 *
 * Generates a compact stability digest from the two most recent baseline
 * snapshots and posts it to Discord via DISCORD_WEBHOOK_URL.
 *
 * Intended to run from the weekly-stability-digest GitHub Actions workflow;
 * can also be invoked manually for testing:
 *
 *   npx tsx scripts/weekly-stability-digest.ts [--baselines <dir>] [--dry-run]
 *
 * Environment variables:
 *   DISCORD_WEBHOOK_URL   Discord incoming webhook URL (required for posting).
 *
 * Exit codes:
 *   0  — Digest sent (or dry-run printed) successfully.
 *   1  — Baseline read or diff error (message printed to stderr).
 *   0  — Webhook failure is NOT a hard error (continue-on-error pattern):
 *         a warning is printed but exit code remains 0 so the workflow step
 *         that calls this script does not mark the job failed even when
 *         continue-on-error is false at the step level.
 */

import { sendWebhookWithRetry } from '../src/harness/webhook-utils.js';
import { runWeeklyDigest } from '../src/harness/weekly-digest.js';
import { loadCaptureConfig } from './capture-config.js';

function parseArgs() {
  const args = process.argv.slice(2);
  let baselinesDir = 'baselines';
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--baselines' || args[i] === '-b') && args[i + 1]) {
      baselinesDir = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }
  return { baselinesDir, dryRun };
}

async function main() {
  const { baselinesDir, dryRun } = parseArgs();

  const captureConfig = loadCaptureConfig();
  const tierConfig = captureConfig.digestTier;

  let message: string;
  let tier: string | null;
  try {
    ({ message, tier } = runWeeklyDigest(baselinesDir, tierConfig));
  } catch (err) {
    console.error('❌ Failed to generate weekly digest:', String(err));
    process.exit(1);
  }

  if (dryRun) {
    const tierLabel = tier ?? 'n/a (first capture)';
    console.log(`[dry-run] Digest tier: ${tierLabel}`);
  }

  console.log('=== Weekly Digest ===');
  console.log(message);
  console.log('====================');

  if (dryRun) {
    console.log('(dry-run: skipping Discord post)');
    return;
  }

  const webhookUrl = process.env['DISCORD_WEBHOOK_URL'];
  if (!webhookUrl) {
    console.warn('⚠️  DISCORD_WEBHOOK_URL not set — skipping Discord notification.');
    return;
  }

  try {
    await sendWebhookWithRetry(webhookUrl, { content: message }, 'weekly-digest');
    console.log('✅ Discord notification sent.');
  } catch {
    // sendWebhookWithRetry already logs the error and writes a dead-letter entry.
    // We exit 0 deliberately so a webhook failure doesn't block the workflow.
    console.warn('⚠️  Discord notification failed (see above). Continuing.');
  }
}

main().catch((err) => {
  console.error('❌ Unexpected fatal error:', err);
  process.exit(1);
});

