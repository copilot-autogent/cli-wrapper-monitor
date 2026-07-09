#!/usr/bin/env -S npx tsx
/**
 * weekly-stability-digest.ts
 *
 * Generates a compact stability digest from the two most recent baseline
 * snapshots and posts it to Discord via DISCORD_WEBHOOK_URL.
 *
 * When ALERT-tier drift is detected and GITHUB_TOKEN is set, automatically
 * files a GitHub issue for each triggered metric dimension (with dedup).
 *
 * Intended to run from the weekly-stability-digest GitHub Actions workflow;
 * can also be invoked manually for testing:
 *
 *   npx tsx scripts/weekly-stability-digest.ts [--baselines <dir>] [--dry-run]
 *
 * Environment variables:
 *   DISCORD_WEBHOOK_URL   Discord incoming webhook URL (required for posting).
 *   GITHUB_TOKEN          GitHub API token for filing ALERT issues (optional).
 *   GITHUB_REPOSITORY     Repository in "owner/repo" format (optional — defaults to
 *                         "copilot-autogent/cli-wrapper-monitor").
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
import { fileAlertIssuesIfNeeded } from '../src/harness/alert-issue-filer.js';
import type { DigestTier, DriftMagnitude } from '../src/harness/digest-tier.js';
import type { MetricSnapshot } from '../src/harness/types.js';
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

  let tierConfig: ReturnType<typeof loadCaptureConfig>['digestTier'];
  try {
    tierConfig = loadCaptureConfig().digestTier;
  } catch (err) {
    console.error('❌ Failed to load capture config:', String(err));
    process.exit(1);
  }

  let message: string;
  let tier: DigestTier | null;
  let magnitude: DriftMagnitude | null;
  let prior: MetricSnapshot | null;
  let current: MetricSnapshot;
  try {
    ({ message, tier, magnitude, prior, current } = runWeeklyDigest(baselinesDir, tierConfig));
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
    console.log('(dry-run: skipping Discord post and GitHub issue filing)');
    return;
  }

  const webhookUrl = process.env['DISCORD_WEBHOOK_URL'];
  if (!webhookUrl) {
    console.warn('⚠️  DISCORD_WEBHOOK_URL not set — skipping Discord notification.');
  } else {
    try {
      await sendWebhookWithRetry(webhookUrl, { content: message }, 'weekly-digest');
      console.log('✅ Discord notification sent.');
    } catch {
      // sendWebhookWithRetry already logs the error and writes a dead-letter entry.
      // We exit 0 deliberately so a webhook failure doesn't block the workflow.
      console.warn('⚠️  Discord notification failed (see above). Continuing.');
    }
  }

  // File GitHub issues for ALERT-tier drift (best-effort; always runs after Discord).
  if (tier === 'alert' && magnitude !== null && prior !== null) {
    const captureDate = current.capturedAt.slice(0, 10);
    try {
      await fileAlertIssuesIfNeeded({
        magnitude,
        prior,
        current,
        digestMessage: message,
        captureDate,
        tierConfig,
      });
    } catch (err) {
      // Should not happen (fileAlertIssuesIfNeeded catches per-trigger errors),
      // but guard against unexpected throws to keep the workflow clean.
      console.warn('⚠️  Unexpected error during GitHub issue filing (continuing):', String(err));
    }
  }
}

main().catch((err) => {
  console.error('❌ Unexpected fatal error:', err);
  process.exit(1);
});

