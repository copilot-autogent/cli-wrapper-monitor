/**
 * alert-issue-filer.ts
 *
 * Files a GitHub issue when the weekly digest detects ALERT-tier drift.
 *
 * Public API:
 *   - extractAlertTriggers    – derive which metrics triggered ALERT from a DriftMagnitude
 *   - buildAlertIssueTitle    – format the canonical issue title for a trigger
 *   - buildAlertIssueBody     – format the issue body from digest context
 *   - buildCompareCommits     – fetch commits in the compare window from the autogent repo
 *   - filterCandidateCommits  – keyword-filter commits per triggered signal
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

/** A single commit in the compare window. */
export interface CommitEntry {
  /** Full 40-char git SHA */
  sha: string;
  /** First line of the commit message (subject line) */
  message: string;
}

/** Commits matched for a single triggered signal. */
export interface CandidateGroup {
  /** Metric name that triggered the alert, e.g. "toolCount" */
  signal: string;
  /** Candidate commits whose subject line matched a keyword for this signal */
  candidates: CommitEntry[];
}

/**
 * Per-signal keyword mapping for commit attribution.
 * Commit subject lines are matched case-insensitively against these substrings.
 */
export const SIGNAL_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  systemPromptChars: ['system prompt', 'prompt', 'instruction', 'hook', 'context'],
  toolCount: ['tool', 'function', 'schema', 'definition'],
  injectionRefusedRate: ['model', 'refusal', 'safety', 'policy', 'filter', 'content'],
};

const AUTOGENT_REPO = 'JackywithaWhiteDog/autogent';
const MAX_CANDIDATES_PER_SIGNAL = 10;
const COMMITS_PER_PAGE = 100;
const MAX_COMMIT_PAGES = 3;

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
    // Determine sign from actual values; magnitude.systemPromptDeltaPct is always absolute.
    const isIncrease =
      currentChars !== undefined && priorChars !== undefined
        ? currentChars >= priorChars
        : true; // unknown direction — show no sign rather than misleading sign
    const sign = isIncrease ? '+' : '-';
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
 * Build the GitHub compare URL spanning the two snapshots.
 *
 * If both snapshots carry a `binaryHash` that looks like a git SHA (7–40 hex
 * chars, without a "sha256:" prefix or other non-SHA marker), use the more-
 * precise SHA-based compare endpoint.  Otherwise fall back to date-scoped refs
 * so the link always resolves even when the field stores a file fingerprint.
 */
function buildCompareUrl(prior: MetricSnapshot, current: MetricSnapshot): string {
  const base = 'https://github.com/JackywithaWhiteDog/autogent/compare';

  // Accept only well-formed git SHAs (7–40 lowercase hex chars).
  // Reject 'unknown', 'sha256:…' fingerprints, empty strings, and other sentinels.
  const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
  const isGitSha = (h: string | undefined): h is string =>
    h !== undefined && GIT_SHA_RE.test(h);

  if (isGitSha(prior.binaryHash) && isGitSha(current.binaryHash)) {
    return `${base}/${prior.binaryHash}...${current.binaryHash}`;
  }

  // Fall back to date-scoped refs derived from capturedAt.
  // Validate the ISO-8601 format to avoid generating broken refs.
  const toDate = (iso: string): string => {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
    return m ? m[1] : 'unknown';
  };
  return `${base}/main@{${toDate(prior.capturedAt)}}...main@{${toDate(current.capturedAt)}}`;
}

/**
 * Format the GitHub issue body for an alert trigger.
 * Includes the drift delta, a context block, the full digest message, an
 * "Investigate" section with a GitHub compare URL spanning the two snapshots,
 * and an optional "Likely culprits" section with keyword-matched commits.
 */
export function buildAlertIssueBody(
  trigger: AlertTrigger,
  captureDate: string,
  digestMessage: string,
  prior: MetricSnapshot,
  current: MetricSnapshot,
  candidateGroups?: CandidateGroup[],
): string {
  const compareUrl = buildCompareUrl(prior, current);
  const lines = [
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
    `## Investigate`,
    ``,
    `Autogent commits in this window:`,
    compareUrl,
    ``,
  ];

  if (candidateGroups !== undefined) {
    lines.push(`## Likely culprits`, ``);
    for (const group of candidateGroups) {
      lines.push(`### ${group.signal}`, ``);
      if (group.candidates.length === 0) {
        lines.push(
          `> No commits matched keywords for this signal — check the full compare link above.`,
          ``,
        );
      } else {
        for (const c of group.candidates) {
          const shortSha = c.sha.slice(0, 7);
          lines.push(
            `- \`${shortSha}\` [${c.message}](https://github.com/${AUTOGENT_REPO}/commit/${c.sha})`,
          );
        }
        lines.push(``);
      }
    }
  }

  lines.push(`---`, `_Auto-filed by weekly-stability-digest. Close when resolved or if noise._`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// buildCompareCommits + filterCandidateCommits — commit attribution
// ---------------------------------------------------------------------------

/**
 * Fetch paginated commits from the autogent repo within the compare window
 * defined by the two snapshot timestamps.
 *
 * Uses the `since` / `until` parameters of the GitHub Commits API.
 * Returns an empty array on any API error (graceful degradation).
 */
export async function buildCompareCommits(
  prior: MetricSnapshot,
  current: MetricSnapshot,
  opts?: GitHubApiOptions,
): Promise<CommitEntry[]> {
  const { token, baseUrl } = resolveApiOptions(opts);
  if (!token) return [];

  const commits: CommitEntry[] = [];

  try {
    for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
      const params = new URLSearchParams({
        since: prior.capturedAt,
        until: current.capturedAt,
        per_page: String(COMMITS_PER_PAGE),
        page: String(page),
      });
      const url = `${baseUrl}/repos/${AUTOGENT_REPO}/commits?${params.toString()}`;

      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) return [];

      const data = (await res.json()) as Array<{ sha: string; commit: { message: string } }>;

      for (const item of data) {
        const subject = item.commit.message.split('\n')[0] ?? '';
        commits.push({ sha: item.sha, message: subject });
      }

      if (data.length < COMMITS_PER_PAGE) break;
    }
  } catch {
    return [];
  }

  return commits;
}

/**
 * For each triggered signal, case-insensitively match commits against its
 * keyword list and return up to MAX_CANDIDATES_PER_SIGNAL candidates.
 *
 * Signals not present in SIGNAL_KEYWORDS are returned with an empty candidate list.
 */
export function filterCandidateCommits(
  commits: CommitEntry[],
  signals: string[],
): CandidateGroup[] {
  return signals.map((signal) => {
    const keywords = SIGNAL_KEYWORDS[signal] ?? [];
    const candidates = commits
      .filter((c) => keywords.some((kw) => c.message.toLowerCase().includes(kw.toLowerCase())))
      .slice(0, MAX_CANDIDATES_PER_SIGNAL);
    return { signal, candidates };
  });
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

  // Search for open issues with the regression-alert label and metric+drifted in the title.
  // Avoid `[ALERT]` brackets in the search term — GitHub strips `[` `]` punctuation,
  // which could cause phrase-matching to silently fail. Instead, match on the stable
  // non-bracketed token "<metric> drifted" which always appears in the title.
  const searchQuery = `repo:${repo} is:issue is:open label:"type:regression-alert" "${metric} drifted" in:title`;
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
  const slashIndex = repo.indexOf('/');
  if (slashIndex < 1 || slashIndex === repo.length - 1) {
    throw new Error(
      `Invalid GITHUB_REPOSITORY format: expected "owner/repo", got "${repo}". ` +
        'Set GITHUB_REPOSITORY or pass githubApi.repo explicitly.',
    );
  }
  const owner = repo.slice(0, slashIndex);
  const repoName = repo.slice(slashIndex + 1);

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

  // Fetch commits once for all triggers; empty on error (graceful degradation).
  const commits = await buildCompareCommits(prior, current, githubApi);

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
      const candidateGroups = filterCandidateCommits(commits, [trigger.metric]);
      const body = buildAlertIssueBody(trigger, captureDate, digestMessage, prior, current, candidateGroups);
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
