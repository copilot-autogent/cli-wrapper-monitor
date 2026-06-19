/**
 * Provenance linking: cross-reference baseline deltas with autogent commits/PRs.
 *
 * Queries the GitHub REST API for merged PRs in JackywithaWhiteDog/autogent
 * that touched provenance-relevant paths between two capture timestamps.
 * Returns structured ProvenanceLinkEntry records to embed in the baseline JSON.
 *
 * No external dependencies — uses the global `fetch` available in Node ≥ 18.
 * Silently returns [] on any network/auth error so baseline capture never fails.
 */

import type { ProvenanceLinkEntry } from './types.js';

export type { ProvenanceLinkEntry };

/** Paths in autogent whose changes directly explain wrapper metric shifts. */
export const PROVENANCE_PATHS = [
  'src/workspace/',    // bootstrap file changes → system prompt changes
  'src/tools/builtin/', // tool additions/removals → tool count / definition size
  'src/hooks/',         // hook changes → hook count / source hash
] as const;

interface GitHubSearchItem {
  number: number;
  title: string;
  pull_request?: { merged_at: string | null };
}

interface GitHubSearchResult {
  items: GitHubSearchItem[];
}

interface GitHubPRFile {
  filename: string;
}

/** Make a GET request to the GitHub REST API and return parsed JSON. */
async function ghGet<T>(path: string, token: string, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'cli-wrapper-monitor/provenance',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${path}`);
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch autogent PRs merged between `since` and `until` that touch at least one
 * of PROVENANCE_PATHS.
 *
 * @param since  ISO 8601 timestamp — lower bound (exclusive, typically prevBaseline.capturedAt)
 * @param until  ISO 8601 timestamp — upper bound (inclusive, typically now)
 * @param token  GitHub token; falls back to GITHUB_TOKEN / GH_TOKEN env vars
 * @returns      Matched PR entries sorted by mergedAt descending; empty on error/no-token
 */
export async function fetchProvenanceLinks(
  since: string,
  until: string,
  token?: string,
): Promise<ProvenanceLinkEntry[]> {
  const tok =
    token ??
    process.env['GITHUB_TOKEN'] ??
    process.env['GH_TOKEN'] ??
    process.env['GITHUB_API_TOKEN'];
  if (!tok) return [];

  // GitHub date search uses YYYY-MM-DD
  const sinceDate = since.slice(0, 10);
  const untilDate = until.slice(0, 10);

  // Fetch merged PRs in the autogent repo within the date range
  const q = encodeURIComponent(
    `repo:JackywithaWhiteDog/autogent is:pr is:merged merged:>${sinceDate} merged:<=${untilDate}`,
  );

  let items: GitHubSearchItem[];
  try {
    const result = await ghGet<GitHubSearchResult>(
      `/search/issues?q=${q}&per_page=50&sort=updated&order=desc`,
      tok,
    );
    items = result.items ?? [];
  } catch {
    // Network errors, rate-limits, missing scopes → silently skip
    return [];
  }

  const results: ProvenanceLinkEntry[] = [];
  for (const item of items) {
    let files: GitHubPRFile[];
    try {
      files = await ghGet<GitHubPRFile[]>(
        `/repos/JackywithaWhiteDog/autogent/pulls/${item.number}/files?per_page=100`,
        tok,
      );
    } catch {
      continue;
    }

    const touched = PROVENANCE_PATHS.filter((prefix) =>
      files.some((f) => f.filename.startsWith(prefix)),
    );

    if (touched.length > 0) {
      const mergedAt = (item.pull_request?.merged_at ?? '').slice(0, 10);
      results.push({
        pr: `JackywithaWhiteDog/autogent#${item.number}`,
        title: item.title,
        mergedAt,
        touchedPaths: [...touched],
      });
    }
  }

  return results;
}
