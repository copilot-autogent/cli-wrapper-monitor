import { describe, it, expect } from 'vitest';
import { parsePromptSections, diffPromptSections } from './prompt-sections.js';

// ---------------------------------------------------------------------------
// Fixture prompts
// ---------------------------------------------------------------------------

const EMPTY_PROMPT = '';

const PLAIN_PROSE = 'You are a helpful assistant. Answer questions thoughtfully.';

const MARKDOWN_H2_PROMPT = `
## Introduction
You are GitHub Copilot, an AI programming assistant.

## Tools available
You have access to the following tools:
- bash: run shell commands
- read_file: read file contents

## Safety guidelines
Never execute destructive commands without confirmation.
Always respect user privacy.
`.trim();

const BOLD_SECTIONS_PROMPT = `
**Introduction**
You are a helpful AI assistant built by GitHub.

**TOOLS**
bash, read_file, write_file are available.

**Safety**
Do not reveal sensitive information.
`.trim();

const MULTI_TOOLS_PROMPT = `
## Tools available
bash: runs shell commands

## More tools
read_file: reads files
write_file: writes files

## Safety
Never run rm -rf without confirmation.

## Introduction
You are Copilot CLI.
`.trim();

const NO_HEADERS_PROMPT = `
This is all raw instructions without any section headers.
It should all fall under Other because there are no recognisable markers.
Multiple lines of content that don't match any known section pattern.
`.trim();

const H1_AND_H3_PROMPT = `
# Tools
bash tool is available.

### Safety Rules
Be careful.

## Introduction
You are an assistant.
`.trim();

// ---------------------------------------------------------------------------
// parsePromptSections
// ---------------------------------------------------------------------------

describe('parsePromptSections', () => {
  it('returns an empty array for an empty string', () => {
    expect(parsePromptSections(EMPTY_PROMPT)).toEqual([]);
  });

  it('returns an empty array for a whitespace-only string', () => {
    expect(parsePromptSections('   \n\n  ')).toEqual([]);
  });

  it('buckets plain prose with no headers into "Other"', () => {
    const sections = parsePromptSections(PLAIN_PROSE);
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe('Other');
    expect(sections[0].charCount).toBeGreaterThan(0);
    expect(sections[0].tokenEstimate).toBeGreaterThan(0);
  });

  it('parses markdown h2 sections correctly', () => {
    const sections = parsePromptSections(MARKDOWN_H2_PROMPT);
    const names = sections.map((s) => s.name);
    expect(names).toContain('Introduction');
    expect(names).toContain('Tools');
    expect(names).toContain('Safety');
  });

  it('maps "Tools available" header to canonical "Tools" bucket', () => {
    const sections = parsePromptSections(MARKDOWN_H2_PROMPT);
    const tools = sections.find((s) => s.name === 'Tools');
    expect(tools).toBeDefined();
    expect(tools!.charCount).toBeGreaterThan(0);
  });

  it('maps "Safety guidelines" header to canonical "Safety" bucket', () => {
    const sections = parsePromptSections(MARKDOWN_H2_PROMPT);
    const safety = sections.find((s) => s.name === 'Safety');
    expect(safety).toBeDefined();
    expect(safety!.charCount).toBeGreaterThan(0);
  });

  it('total charCount sums to exactly input length', () => {
    const raw = MARKDOWN_H2_PROMPT;
    const sections = parsePromptSections(raw);
    const total = sections.reduce((sum, s) => sum + s.charCount, 0);
    expect(total).toBe(raw.length);
  });

  it('handles bold-label sections', () => {
    const sections = parsePromptSections(BOLD_SECTIONS_PROMPT);
    const names = sections.map((s) => s.name);
    expect(names).toContain('Introduction');
    expect(names).toContain('Tools');
    expect(names).toContain('Safety');
  });

  it('merges multiple "Tools" headers into a single bucket', () => {
    const sections = parsePromptSections(MULTI_TOOLS_PROMPT);
    const toolsSections = sections.filter((s) => s.name === 'Tools');
    expect(toolsSections).toHaveLength(1);
    // The merged Tools bucket should be larger than a single block
    expect(toolsSections[0].charCount).toBeGreaterThan(10);
  });

  it('buckets unrecognised text into "Other"', () => {
    const sections = parsePromptSections(NO_HEADERS_PROMPT);
    const other = sections.find((s) => s.name === 'Other');
    expect(other).toBeDefined();
    // All content should be in Other
    expect(other!.charCount).toBeGreaterThan(0);
  });

  it('handles h1 and h3 headers', () => {
    const sections = parsePromptSections(H1_AND_H3_PROMPT);
    const names = sections.map((s) => s.name);
    expect(names).toContain('Tools');
    expect(names).toContain('Safety');
    expect(names).toContain('Introduction');
  });

  it('tokenEstimate is roughly charCount / 4', () => {
    const sections = parsePromptSections(MARKDOWN_H2_PROMPT);
    for (const s of sections) {
      const expected = Math.round(s.charCount / 4);
      expect(s.tokenEstimate).toBe(expected);
    }
  });

  it('returns sections sorted by charCount descending', () => {
    const sections = parsePromptSections(MARKDOWN_H2_PROMPT);
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i - 1].charCount).toBeGreaterThanOrEqual(sections[i].charCount);
    }
  });

  it('does not crash on a very long prompt', () => {
    const big = '## Tools\n' + 'a'.repeat(100_000) + '\n## Safety\n' + 'b'.repeat(50_000);
    expect(() => parsePromptSections(big)).not.toThrow();
    const sections = parsePromptSections(big);
    const tools = sections.find((s) => s.name === 'Tools');
    const safety = sections.find((s) => s.name === 'Safety');
    expect(tools).toBeDefined();
    expect(safety).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// diffPromptSections
// ---------------------------------------------------------------------------

describe('diffPromptSections', () => {
  it('returns empty array when both sides are undefined', () => {
    expect(diffPromptSections(undefined, undefined)).toEqual([]);
  });

  it('returns empty array when both sides are null', () => {
    expect(diffPromptSections(null, null)).toEqual([]);
  });

  it('treats undefined baseline as "new" sections with null baselineCharCount', () => {
    const current = [{ name: 'Tools', charCount: 500, tokenEstimate: 125 }];
    const changes = diffPromptSections(undefined, current);
    expect(changes).toHaveLength(1);
    expect(changes[0].name).toBe('Tools');
    expect(changes[0].baselineCharCount).toBeNull();
    expect(changes[0].currentCharCount).toBe(500);
    expect(changes[0].deltaAbsolute).toBe(500);
    expect(changes[0].deltaPct).toBeNull();
  });

  it('treats undefined current as "removed" sections with null currentCharCount', () => {
    const baseline = [{ name: 'Safety', charCount: 300, tokenEstimate: 75 }];
    const changes = diffPromptSections(baseline, undefined);
    expect(changes).toHaveLength(1);
    expect(changes[0].name).toBe('Safety');
    expect(changes[0].baselineCharCount).toBe(300);
    expect(changes[0].currentCharCount).toBeNull();
    expect(changes[0].deltaAbsolute).toBe(-300);
  });

  it('computes correct delta for a section that grew', () => {
    const baseline = [{ name: 'Tools', charCount: 1000, tokenEstimate: 250 }];
    const current = [{ name: 'Tools', charCount: 1420, tokenEstimate: 355 }];
    const [change] = diffPromptSections(baseline, current);
    expect(change.deltaAbsolute).toBe(420);
    expect(change.deltaPct).toBeCloseTo(42.0, 0);
  });

  it('computes correct delta for a section that shrank', () => {
    const baseline = [{ name: 'Safety', charCount: 800, tokenEstimate: 200 }];
    const current = [{ name: 'Safety', charCount: 600, tokenEstimate: 150 }];
    const [change] = diffPromptSections(baseline, current);
    expect(change.deltaAbsolute).toBe(-200);
    expect(change.deltaPct).toBeCloseTo(-25.0, 0);
  });

  it('computes zero delta for an unchanged section', () => {
    const baseline = [{ name: 'Safety', charCount: 800, tokenEstimate: 200 }];
    const current = [{ name: 'Safety', charCount: 800, tokenEstimate: 200 }];
    const [change] = diffPromptSections(baseline, current);
    expect(change.deltaAbsolute).toBe(0);
    expect(change.deltaPct).toBeCloseTo(0, 1);
  });

  it('covers all section names from both sides', () => {
    const baseline = [
      { name: 'Tools', charCount: 500, tokenEstimate: 125 },
      { name: 'Introduction', charCount: 200, tokenEstimate: 50 },
    ];
    const current = [
      { name: 'Tools', charCount: 600, tokenEstimate: 150 },
      { name: 'Safety', charCount: 100, tokenEstimate: 25 },
    ];
    const changes = diffPromptSections(baseline, current);
    const names = changes.map((c) => c.name).sort();
    expect(names).toContain('Tools');
    expect(names).toContain('Introduction');
    expect(names).toContain('Safety');
    expect(changes).toHaveLength(3);
  });

  it('sorts changes by absolute delta magnitude descending', () => {
    const baseline = [
      { name: 'Tools', charCount: 100, tokenEstimate: 25 },
      { name: 'Safety', charCount: 500, tokenEstimate: 125 },
    ];
    const current = [
      { name: 'Tools', charCount: 600, tokenEstimate: 150 },  // delta +500
      { name: 'Safety', charCount: 520, tokenEstimate: 130 }, // delta +20
    ];
    const changes = diffPromptSections(baseline, current);
    expect(Math.abs(changes[0].deltaAbsolute)).toBeGreaterThanOrEqual(
      Math.abs(changes[1].deltaAbsolute),
    );
  });
});
