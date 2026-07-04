/**
 * Heuristic parser that breaks a raw system prompt into named sections.
 *
 * Sections are identified by structural markers (markdown headers, bold labels,
 * horizontal rules) and a vocabulary of well-known section names. Unknown text
 * that doesn't belong to a recognised section is bucketed into "Other".
 *
 * The parser is intentionally resilient: it never throws, and unrecognised
 * sections simply accumulate under "Other" instead of crashing.
 */

import type { PromptSection, PromptSectionChange } from './types.js';

export type { PromptSection, PromptSectionChange };

/** Rough token estimate: 1 token ≈ 4 characters (±20% for English prose). */
const CHARS_PER_TOKEN = 4;

function estimateTokens(charCount: number): number {
  return Math.round(charCount / CHARS_PER_TOKEN);
}



/** Patterns that map raw header text to a canonical section bucket. */
const SECTION_PATTERNS: Array<{ pattern: RegExp; canonical: string }> = [
  // Tools / tool definitions / functions / capabilities
  { pattern: /\btools?\b|\bfunctions?\b|\bcapabilit/i, canonical: 'Tools' },
  // Safety / security — keep narrow to avoid misclassifying "General Instructions"
  { pattern: /\bsafety\b|\bsecurity\b|\bpermission|\bpolic/i, canonical: 'Safety' },
  // Introduction / identity / overview / context / instructions
  { pattern: /\bintro|\bidentity|\boverview|\bcontext|\bpurpose|\bbackground|\binstruction|\brule|\bguideline|\byou are\b|\bwho you/i, canonical: 'Introduction' },
];

function canonicalise(rawHeader: string): string {
  for (const { pattern, canonical } of SECTION_PATTERNS) {
    if (pattern.test(rawHeader)) return canonical;
  }
  return 'Other';
}

// ---------------------------------------------------------------------------
// Header detection
// ---------------------------------------------------------------------------

/**
 * Returns a canonical section name if the line looks like a section header,
 * or null if it's normal prose.
 */
function detectHeader(line: string): string | null {
  const trimmed = line.trim();

  // Markdown h1/h2/h3: ## Title, # Title
  const mdMatch = trimmed.match(/^#{1,3}\s+(.+)/);
  if (mdMatch) return canonicalise(mdMatch[1]);

  // Bold-only line: **Title** or __Title__
  const boldMatch = trimmed.match(/^(?:\*\*|__)([^*_]+)(?:\*\*|__)[:.]?\s*$/);
  if (boldMatch) return canonicalise(boldMatch[1]);

  return null;
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw system prompt string into a list of named sections.
 *
 * Sections are accumulated per canonical name so that e.g. multiple
 * "Tools"-labelled blocks merge into a single "Tools" entry.
 *
 * Text before the first recognised header is bucketed into "Other".
 *
 * @param raw - The complete raw system prompt text.
 * @returns    An array of sections sorted by charCount descending.
 */
export function parsePromptSections(raw: string, captureText = false): PromptSection[] {
  if (!raw || raw.trim().length === 0) return [];

  const buckets = new Map<string, number>();
  const textBuckets = new Map<string, string[]>(); // only populated when captureText=true
  const addChars = (name: string, n: number) =>
    buckets.set(name, (buckets.get(name) ?? 0) + n);

  let currentSection = 'Other';
  const lines = raw.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = detectHeader(line);
    if (header !== null) {
      currentSection = header;
    }
    // Add the line length; add 1 for the '\n' that split consumed, except
    // on the final segment which had no trailing newline in the original string.
    addChars(currentSection, line.length + (i < lines.length - 1 ? 1 : 0));
    if (captureText) {
      if (!textBuckets.has(currentSection)) textBuckets.set(currentSection, []);
      // Reassemble original text: add newline for all but the very last segment
      textBuckets.get(currentSection)!.push(line + (i < lines.length - 1 ? '\n' : ''));
    }
  }

  // Build output, filtering out zero-size buckets
  const sections: PromptSection[] = [];
  for (const [name, charCount] of buckets.entries()) {
    if (charCount > 0) {
      const section: PromptSection = { name, charCount, tokenEstimate: estimateTokens(charCount) };
      if (captureText) {
        section.text = textBuckets.get(name)?.join('') ?? '';
      }
      sections.push(section);
    }
  }

  // Sort largest-first so reports are easy to read
  sections.sort((a, b) => b.charCount - a.charCount);
  return sections;
}

// ---------------------------------------------------------------------------
// Diff helper
// ---------------------------------------------------------------------------

/**
 * Compute per-section character-count deltas between two section arrays.
 * Returns one entry per section name that appears in either side.
 */
export function diffPromptSections(
  baseline: PromptSection[] | undefined | null,
  current: PromptSection[] | undefined | null,
): PromptSectionChange[] {
  if (!baseline && !current) return [];

  const baselineMap = new Map<string, number>(
    (baseline ?? []).map((s) => [s.name, s.charCount]),
  );
  const currentMap = new Map<string, number>(
    (current ?? []).map((s) => [s.name, s.charCount]),
  );

  const allNames = new Set([...baselineMap.keys(), ...currentMap.keys()]);
  const changes: PromptSectionChange[] = [];

  for (const name of allNames) {
    const b = baselineMap.get(name) ?? null;
    const c = currentMap.get(name) ?? null;
    const delta = (c ?? 0) - (b ?? 0);
    const pct = b !== null && b > 0 ? (delta / b) * 100 : null;
    changes.push({
      name,
      baselineCharCount: b,
      currentCharCount: c,
      deltaAbsolute: delta,
      deltaPct: pct,
    });
  }

  // Sort by absolute delta magnitude descending
  changes.sort((a, b) => Math.abs(b.deltaAbsolute) - Math.abs(a.deltaAbsolute));
  return changes;
}

// ---------------------------------------------------------------------------
// Line-level text diff (zero external deps)
// ---------------------------------------------------------------------------

/** A single line in a computed text diff. */
export interface DiffLine {
  /** 'added' = exists in current only; 'removed' = exists in prev only */
  type: 'added' | 'removed';
  text: string;
}

/** Result of a line-level diff between two text strings. */
export interface TextDiffResult {
  /** Changed lines only (added/removed). May be truncated by maxChangedLines. */
  lines: DiffLine[];
  /** Total changed lines before any truncation. */
  totalChangedLines: number;
  /** True when text diff was not computed (text unavailable on one or both sides). */
  unavailable: boolean;
}

/**
 * Compute a line-level diff between two text strings using LCS (Longest Common Subsequence).
 * Returns only the changed lines (added/removed) — context lines are omitted.
 * Falls back to a size-limit notice for very large inputs.
 *
 * @param prev         Previous text.
 * @param curr         Current text.
 * @param maxChangedLines  Maximum changed lines to return; 0 = return all.
 */
export function diffTextLines(
  prev: string,
  curr: string,
  maxChangedLines = 0,
): TextDiffResult {
  // Fast path: identical texts
  if (prev === curr) return { lines: [], totalChangedLines: 0, unavailable: false };

  const a = prev.split('\n');
  const b = curr.split('\n');

  // Guard against O(m*n) blowout on very large sections
  const SIZE_LIMIT = 1500; // lines
  if (a.length > SIZE_LIMIT || b.length > SIZE_LIMIT) {
    const notice: DiffLine[] = [
      { type: 'removed', text: `[prev: ${a.length} lines]` },
      { type: 'added', text: `[curr: ${b.length} lines — too large for inline diff]` },
    ];
    return { lines: notice, totalChangedLines: 2, unavailable: false };
  }

  // Build LCS DP table
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack through the DP table to reconstruct the diff
  const rawDiff: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      // Common line — skip (context omitted from output)
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawDiff.push({ type: 'added', text: b[j - 1] });
      j--;
    } else {
      rawDiff.push({ type: 'removed', text: a[i - 1] });
      i--;
    }
  }
  rawDiff.reverse();

  const totalChangedLines = rawDiff.length;
  const lines =
    maxChangedLines > 0 ? rawDiff.slice(0, maxChangedLines) : rawDiff;

  return { lines, totalChangedLines, unavailable: false };
}

/**
 * Compute text diffs for each prompt section that has text available on both sides.
 *
 * @param baseline         Baseline sections (may lack .text).
 * @param current          Current sections (may lack .text).
 * @param maxChangedLines  Passed through to diffTextLines; 0 = return all changed lines.
 */
export function diffPromptSectionTexts(
  baseline: PromptSection[] | undefined | null,
  current: PromptSection[] | undefined | null,
  maxChangedLines = 0,
): Map<string, TextDiffResult> {
  const results = new Map<string, TextDiffResult>();
  if (!baseline || !current) return results;

  const baselineMap = new Map<string, string | undefined>(
    baseline.map((s) => [s.name, s.text]),
  );
  const currentMap = new Map<string, string | undefined>(
    current.map((s) => [s.name, s.text]),
  );

  const allNames = new Set([...baselineMap.keys(), ...currentMap.keys()]);
  for (const name of allNames) {
    const prevText = baselineMap.get(name);
    const currText = currentMap.get(name);
    if (prevText === undefined || currText === undefined) {
      results.set(name, { lines: [], totalChangedLines: 0, unavailable: true });
    } else {
      results.set(name, diffTextLines(prevText, currText, maxChangedLines));
    }
  }
  return results;
}
