/**
 * alert-issue-filer.ts
 *
 * Files a GitHub issue when the weekly digest detects ALERT-tier drift.
 *
 * Public API:
 *   - extractAlertTriggers  – derive which metrics triggered ALERT from a DriftMagnitude
 *   - buildAlertIssueTitle  – format the canonical issue title for a trigger
 *   - buildAlertIssueBody   – format the issue body from digest context
 *   - fileAlertIssuesIfNeeded – dedup-check + file one issue per triggered metric
 */

import type { DriftMagnitude, DigestTierConfig } from './digest-tier.js';
import { DEFAULT_TIER_THRESHOLDS } from './digest-tier.js';
import type { MetricSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single metric dimension that triggered the ALERT tier. */
export interface AlertTrigger {
  /** Machine-readable metric name, e.g. "toolCount", "systemPromptChars", "injectionRefusedRate" */
  metric: string;
  /** Human-readable prior value, e.g. "21 tools" or "156,000 chars" */
  fromValue: string;
  /** Human-readable current value */
  toValue: string;
  /** Delta description, e.g. "+8.3%" or "−3 tools" */
  delta: string;
}

/** Options for the GitHub API client, injectable for testing. */
export interface GitHubApiOptions {
  /** Repository in "owner/repo" format. Defaults to GITHUB_REPOSITORY env var or "copilot-autogent/cli-wrapper-monitor". */
  repo?: string;
  /** GitHub API token. Defaults to GITHUB_TOKEN env var. */
  token?: string;
  /** Base URL for the GitHub API. Defaults to "https://api.github.com". */
  baseUrl?: string;
}

/** Parameters for the main entry-point function. */
export interface FileAlertIssuesParams {
  magnitude: DriftMagnitude;
  prior: MetricSnapshot;
  current: MetricSnapshot;
  /** Full digest message text — included in the issue body for context. */
  digestMessage: string;
  /** ISO date string for the capture run (YYYY-MM-DD). */
  captureDate: string;
  tierConfig?: DigestTierConfig;
  githubApi?: GitHubApiOptions;
  /** When true, log filing decisions to stdout. Defaults to true. */
  verbose?: boolean;
}

/** Result returned per trigger after a filing attempt. */
export interface AlertIssueResult {
  trigger: AlertTrigger;
  /** "filed" | "deduped" | "no-token" | "error" */
  outcome: 'filed' | 'deduped' | 'no-token' | 'error';
  /** GitHub issue number when outcome === "filed". */
  issueNumber?: number;
  /** Error message when outcome === "error". */
  error?: string;
}

// ---------------------------------------------------------------------------
// extractAlertTriggers
// ---------------------------------------------------------------------------

/**
 * Derive the set of metrics that triggered ALERT tier from a DriftMagnitude.
 * Returns one entry per triggered dimension.
 *
 * Note: multiple triggers can fire in the same run (e.g., tool count drop AND
 * system-prompt spike). Each produces its own GitHub issue (deduped separately).
 */
export function extractAlertTriggers(
  magnitude: DriftMagnitude,
  prior: MetricSnapshot,
  current: MetricSnapshot,
  config?: DigestTierConfig,
): AlertTrigger[] {
  const alertSysPct =
    config?.alertSystemPromptDeltaPct ?? DEFAULT_TIER_THRESHOLDS.alertSystemPromptDeltaPct;
  const alertProbePp =
    config?.alertProbeRefusalDeltaPp ?? DEFAULT_TIER_THRESHOLDS.alertProbeRefusalDeltaPp;

  const triggers: AlertTrigger[] = [];

  // --- toolCount ---
  if (magnitude.toolCountDelta !== 0) {
    const priorTools = prior.experiments['context-tax']?.metrics?.['toolCount']?.value;
    const currentTools = current.experiments['context-tax']?.metrics?.['toolCount']?.value;
    const fromVal = priorTools !== undefined ? `${priorTools} tools` : 'unknown';
    const toVal = currentTools !== undefined ? `${currentTools} tools` : 'unknown';
    const deltaSign = magnitude.toolCountDelta > 0 ? '+' : '';
    triggers.push({
      metric: 'toolCount',
      fromValue: fromVal,
      toValue: toVal,
      delta: `${deltaSign}${magnitude.toolCountDelta} tools`,
    });
  }

  // --- systemPromptChars ---
  if (magnitude.systemPromptDeltaPct >= alertSysPct) {
    const priorChars = prior.experiments['context-tax']?.metrics?.['systemPromptChars']?.value;
    const currentChars = current.experiments['context-tax']?.metrics?.['systemPromptChars']?.value;
    const fromVal =
      priorChars !== undefined ? `${priorChars.toLocaleString('en-US')} chars` : 'unknown';
    const toVal =
      currentChars !== undefined ? `${currentChars.toLocaleString('en-US')} chars` : 'unknown';
    const sign = currentChars !== undefined && priorChars !== undefined && currentChars >= priorChars ? '+' : '';
    triggers.push({
      metric: 'systemPromptChars',
      fromValue: fromVal,
      toValue: toVal,
      delta: `${sign}${magnitude.systemPromptDeltaPct.toFixed(1)}%`,
    });
  }

  // --- injectionRefusedRate ---
  if (magnitude.probeRefusalDeltaPp >= alertProbePp) {
    // Find the worst-drop experiment for a human-readable from/to
    let worstDropPp = 0;
    let worstFromPct = '';
    let worstToPct = '';
    for (const [expName, baselineExp] of Object.entries(prior.experiments ?? {})) {
      const currentExp = current.experiments?.[expName];
      if (!currentExp) continue;
      const baselineRate = baselineExp.metrics?.['injectionRefusedRate']?.value;
      const currentRate = currentExp.metrics?.['injectionRefusedRate']?.value;
      if (baselineRate !== undefined && currentRate !== undefined) {
        const dropPp = (baselineRate - currentRate) * 100;
        if (dropPp > worstDropPp) {
          worstDropPp = dropPp;
          worstFromPct = `${(baselineRate * 100).toFixed(1)}%`;
          worstToPct = `${(currentRate * 100).toFixed(1)}%`;
        }
      }
    }
    triggers.push({
      metric: 'injectionRefusedRate',
      fromValue: worstFromPct || 'unknown',
      toValue: worstToPct || 'unknown',
      delta: `-${magnitude.probeRefusalDeltaPp.toFixed(1)} pp`,
    });
  }

  return triggers;
}

// ---------------------------------------------------------------------------
// buildAlertIssueTitle
// ---------------------------------------------------------------------------

/**
 * Format the canonical issue title for an alert trigger.
 *
 * Format: `[ALERT] <metric> drifted <from> → <to> (YYYY-MM-DD capture)`
 */
export function buildAlertIssueTitle(trigger: AlertTrigger, captureDate: string): string {
  return `[ALERT] ${trigger.metric} drifted ${trigger.fromValue} → ${trigger.toValue} (${captureDate} capture)`;
}

// ---------------------------------------------------------------------------
// buildAlertIssueBody
// ---------------------------------------------------------------------------

/**
 * Format the GitHub issue body for an alert trigger.
 * Includes the drift delta, a context block, and the full digest message.
 */
export function buildAlertIssueBody(
  trigger: AlertTrigger,
  captureDate: string,
  digestMessage: string,
): string {
  return [
    `## 🚨 ALERT: \`${trigger.metric}\` drift detected`,
    ``,
    `| Field | Value |`,
    `| ----- | ----- |`,
    `| Metric | \`${trigger.metric}\` |`,
    `| Prior value | ${trigger.fromValue} |`,
    `| Current value | ${trigger.toValue} |`,
    `| Delta | ${trigger.delta} |`,
    `| Capture date | ${captureDate} |`,
    ``,
    `## Weekly Digest`,
    ``,
    `\`\`\``,
    digestMessage,
    `\`\`\``,
    ``,
    `---`,
    `_Auto-filed by weekly-stability-digest. Close when resolved or if noise._`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function resolveApiOptions(opts?: GitHubApiOptions): {
  repo: string;
  token: string;
  baseUrl: string;
} {
  return {
    repo:
      opts?.repo ??
      process.env['GITHUB_REPOSITORY'] ??
      'copilot-autogent/cli-wrapper-monitor',
    token: opts?.token ?? process.env['GITHUB_TOKEN'] ?? '',
    baseUrl: opts?.baseUrl ?? 'https://api.github.com',
  };
}

/**
 * Check whether an open issue with label `type:regression-alert` already exists
 * for the given metric name (i.e. the title contains "[ALERT] <metric> drifted").
 *
 * Returns the existing issue number if found, or null if not found.
 */
export async function findExistingAlertIssue(
  metric: string,
  opts?: GitHubApiOptions,
): Promise<number | null> {
  const { repo, token, baseUrl } = resolveApiOptions(opts);
  if (!token) return null;

  // Search for open issues with the regression-alert label and metric in the title.
  // The GitHub search API is the most reliable way to query across title/label.
  const searchQuery = `repo:${repo} is:issue is:open label:type:regression-alert "[ALERT] ${metric} drifted" in:title`;
  const url = `${baseUrl}/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=1`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub search API failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { total_count: number; items: Array<{ number: number }> };
  if (data.total_count > 0 && data.items.length > 0) {
    return data.items[0].number;
  }
  return null;
}

/**
 * Create a new GitHub issue with the given title, body, and labels.
 * Returns the issue number on success.
 */
export async function createAlertIssue(
  title: string,
  body: string,
  opts?: GitHubApiOptions,
): Promise<number> {
  const { repo, token, baseUrl } = resolveApiOptions(opts);
  const [owner, repoName] = repo.split('/');

  const url = `${baseUrl}/repos/${owner}/${repoName}/issues`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      body,
      labels: ['status:needs-input', 'type:regression-alert'],
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const responseBody = await res.text().catch(() => '');
    throw new Error(`GitHub create issue API failed (${res.status}): ${responseBody}`);
  }

  const data = (await res.json()) as { number: number };
  return data.number;
}

// ---------------------------------------------------------------------------
// fileAlertIssuesIfNeeded — main entry point
// ---------------------------------------------------------------------------

/**
 * For each metric that triggered ALERT tier, check for an existing open
 * `type:regression-alert` issue and file a new one if none found.
 *
 * - When GITHUB_TOKEN is absent, returns `no-token` for all triggers (silent no-op).
 * - Network errors are caught per-trigger and returned as `error` outcomes so a
 *   single GitHub API failure doesn't block the Discord notification.
 */
export async function fileAlertIssuesIfNeeded(
  params: FileAlertIssuesParams,
): Promise<AlertIssueResult[]> {
  const { magnitude, prior, current, digestMessage, captureDate, tierConfig, githubApi } = params;
  const verbose = params.verbose ?? true;

  const triggers = extractAlertTriggers(magnitude, prior, current, tierConfig);

  if (triggers.length === 0) {
    return [];
  }

  const { token } = resolveApiOptions(githubApi);
  if (!token) {
    if (verbose) {
      console.warn(
        '⚠️  GITHUB_TOKEN not set — skipping GitHub issue filing for ALERT-tier drift.',
      );
    }
    return triggers.map((trigger) => ({ trigger, outcome: 'no-token' as const }));
  }

  const results: AlertIssueResult[] = [];

  for (const trigger of triggers) {
    try {
      const existingIssueNumber = await findExistingAlertIssue(trigger.metric, githubApi);
      if (existingIssueNumber !== null) {
        if (verbose) {
          console.log(
            `ℹ️  Existing ALERT issue #${existingIssueNumber} found for metric "${trigger.metric}" — skipping (dedup).`,
          );
        }
        results.push({ trigger, outcome: 'deduped', issueNumber: existingIssueNumber });
        continue;
      }

      const title = buildAlertIssueTitle(trigger, captureDate);
      const body = buildAlertIssueBody(trigger, captureDate, digestMessage);
      const issueNumber = await createAlertIssue(title, body, githubApi);

      if (verbose) {
        console.log(
          `✅ Filed GitHub issue #${issueNumber} for ALERT-tier drift in metric "${trigger.metric}".`,
        );
      }
      results.push({ trigger, outcome: 'filed', issueNumber });
    } catch (err) {
      const error = String(err);
      console.error(
        `❌ Failed to file GitHub issue for ALERT metric "${trigger.metric}": ${error}`,
      );
      results.push({ trigger, outcome: 'error', error });
    }
  }

  return results;
}
