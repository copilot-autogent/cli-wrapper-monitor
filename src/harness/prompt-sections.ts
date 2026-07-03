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

  // Standalone ALL-CAPS label (≥4 chars, optionally followed by colon)
  const capsMatch = trimmed.match(/^([A-Z][A-Z\s]{3,})(?::.*)?$/);
  if (capsMatch && !/[a-z]/.test(capsMatch[1])) return canonicalise(capsMatch[1]);

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
export function parsePromptSections(raw: string): PromptSection[] {
  if (!raw || raw.trim().length === 0) return [];

  const buckets = new Map<string, number>();
  const addChars = (name: string, n: number) =>
    buckets.set(name, (buckets.get(name) ?? 0) + n);

  let currentSection = 'Other';

  for (const line of raw.split('\n')) {
    const header = detectHeader(line);
    if (header !== null) {
      currentSection = header;
    }
    // Account for the newline that was consumed by split
    addChars(currentSection, line.length + 1);
  }

  // Build output, filtering out zero-size buckets
  const sections: PromptSection[] = [];
  for (const [name, charCount] of buckets.entries()) {
    if (charCount > 0) {
      sections.push({ name, charCount, tokenEstimate: estimateTokens(charCount) });
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
