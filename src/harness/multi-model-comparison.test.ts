import { describe, it, expect } from 'vitest';
import {
  formatComparisonTable,
  formatComparisonMarkdown,
  detectBehavioralDifferences,
} from './multi-model-comparison.js';
import type { MultiModelComparisonSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSnapshot(
  entries: Array<{
    model: string;
    safe?: number;
    dangerous?: number;
    borderline?: number;
    error?: string;
  }>,
): MultiModelComparisonSnapshot {
  return {
    capturedAt: '2026-06-17T12:00:00.000Z',
    monitorVersion: 'abc1234',
    models: entries.map((e) => e.model),
    entries: entries.map((e) => ({
      model: e.model,
      contextTax: {
        systemPromptChars: 10000,
        systemPromptTokensEstimated: 2500,
        toolDefinitionsChars: 2000,
        toolDefinitionsTokensEstimated: 500,
        toolCount: 15,
      },
      refusal:
        e.error == null && e.safe !== undefined
          ? {
              safeAllowedRate: e.safe,
              dangerousRefusedRate: e.dangerous ?? 1.0,
              borderlineRefusedRate: e.borderline ?? 0.5,
              totalProbes: 9,
            }
          : null,
      error: e.error,
    })),
  };
}

// ---------------------------------------------------------------------------
// detectBehavioralDifferences
// ---------------------------------------------------------------------------

describe('detectBehavioralDifferences', () => {
  it('returns empty array when all models are consistent', () => {
    const snap = makeSnapshot([
      { model: 'claude', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
      { model: 'gpt', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
      { model: 'gemini', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
    ]);
    const diffs = detectBehavioralDifferences(snap);
    expect(diffs).toHaveLength(0);
  });

  it('flags models with safeAllowedRate < 1.0', () => {
    const snap = makeSnapshot([
      { model: 'claude', safe: 0.8, dangerous: 1.0, borderline: 0.5 },
      { model: 'gpt', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
    ]);
    const diffs = detectBehavioralDifferences(snap);
    const safeFindings = diffs.filter((d) => d.includes('safeAllowedRate'));
    expect(safeFindings).toHaveLength(1);
    expect(safeFindings[0]).toContain('claude');
    expect(safeFindings[0]).toContain('false-positive');
  });

  it('flags models with dangerousRefusedRate < 1.0', () => {
    const snap = makeSnapshot([
      { model: 'claude', safe: 1.0, dangerous: 0.667, borderline: 0.5 },
      { model: 'gpt', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
    ]);
    const diffs = detectBehavioralDifferences(snap);
    const dangerFindings = diffs.filter((d) => d.includes('dangerousRefusedRate'));
    expect(dangerFindings).toHaveLength(1);
    expect(dangerFindings[0]).toContain('security gap');
  });

  it('flags borderline spread when > 0.1', () => {
    const snap = makeSnapshot([
      { model: 'claude', safe: 1.0, dangerous: 1.0, borderline: 0.75 },
      { model: 'gpt', safe: 1.0, dangerous: 1.0, borderline: 0.25 },
    ]);
    const diffs = detectBehavioralDifferences(snap);
    const borderFindings = diffs.filter((d) => d.includes('borderlineRefusedRate'));
    expect(borderFindings).toHaveLength(1);
    expect(borderFindings[0]).toContain('spread=0.500');
  });

  it('does not flag borderline spread when <= 0.1', () => {
    const snap = makeSnapshot([
      { model: 'claude', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
      { model: 'gpt', safe: 1.0, dangerous: 1.0, borderline: 0.55 },
    ]);
    const diffs = detectBehavioralDifferences(snap);
    const borderFindings = diffs.filter((d) => d.includes('borderlineRefusedRate'));
    expect(borderFindings).toHaveLength(0);
  });

  it('returns empty when fewer than 2 entries have refusal data', () => {
    const snap = makeSnapshot([{ model: 'claude', safe: 1.0, dangerous: 0.5, borderline: 0.5 }]);
    expect(detectBehavioralDifferences(snap)).toHaveLength(0);
  });

  it('skips errored entries', () => {
    const snap = makeSnapshot([
      { model: 'claude', safe: 1.0, dangerous: 1.0, borderline: 0.75 },
      { model: 'gpt', error: 'API timeout' },
      { model: 'gemini', safe: 1.0, dangerous: 1.0, borderline: 0.25 },
    ]);
    const diffs = detectBehavioralDifferences(snap);
    // gpt entry is skipped; claude vs gemini spread = 0.5 > 0.1
    const borderFindings = diffs.filter((d) => d.includes('borderlineRefusedRate'));
    expect(borderFindings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// formatComparisonTable
// ---------------------------------------------------------------------------

describe('formatComparisonTable', () => {
  it('includes header and model names', () => {
    const snap = makeSnapshot([
      { model: 'gpt-4o-mini', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
      { model: 'claude-haiku', safe: 1.0, dangerous: 1.0, borderline: 0.75 },
    ]);
    const table = formatComparisonTable(snap);
    expect(table).toContain('Multi-Model Behavioral Comparison');
    expect(table).toContain('gpt-4o-mini');
    expect(table).toContain('claude-haiku');
  });

  it('includes context tax metrics', () => {
    const snap = makeSnapshot([
      { model: 'gpt-4o-mini', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
    ]);
    const table = formatComparisonTable(snap);
    expect(table).toContain('Context Tax');
    expect(table).toContain('10,000');
    expect(table).toContain('Tool count');
  });

  it('marks refusal as skipped when no refusal data', () => {
    const snap = makeSnapshot([{ model: 'gpt-4o-mini' }]);
    snap.entries[0]!.refusal = null;
    const table = formatComparisonTable(snap);
    expect(table).toContain('skipped');
  });

  it('includes rate values in the table', () => {
    const snap = makeSnapshot([
      { model: 'gpt-4o-mini', safe: 1.0, dangerous: 0.667, borderline: 0.5 },
    ]);
    const table = formatComparisonTable(snap);
    expect(table).toContain('0.667');
    expect(table).toContain('1.000');
  });

  it('shows no-differences message (not a Detected header) when models are consistent', () => {
    const snap = makeSnapshot([
      { model: 'gpt', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
      { model: 'claude', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
    ]);
    const table = formatComparisonTable(snap);
    expect(table).not.toContain('Behavioral Differences Detected');
    expect(table).toContain('No meaningful behavioral differences');
  });

  it('shows Detected header when a real difference exists', () => {
    const snap = makeSnapshot([
      { model: 'gpt', safe: 1.0, dangerous: 0.667, borderline: 0.5 },
      { model: 'claude', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
    ]);
    const table = formatComparisonTable(snap);
    expect(table).toContain('Behavioral Differences Detected');
    expect(table).toContain('security gap');
  });
});

// ---------------------------------------------------------------------------
// formatComparisonMarkdown
// ---------------------------------------------------------------------------

describe('formatComparisonMarkdown', () => {
  it('produces valid markdown with headings', () => {
    const snap = makeSnapshot([
      { model: 'gpt-4o-mini', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
    ]);
    const md = formatComparisonMarkdown(snap);
    expect(md).toContain('# Multi-Model Behavioral Comparison');
    expect(md).toContain('## Context Tax');
    expect(md).toContain('## Refusal Rate Comparison');
    expect(md).toContain('## Behavioral Differences');
  });

  it('includes model name in markdown table', () => {
    const snap = makeSnapshot([
      { model: 'gpt-4o-mini', safe: 1.0, dangerous: 1.0, borderline: 0.333 },
      { model: 'claude-haiku', safe: 1.0, dangerous: 1.0, borderline: 0.75 },
    ]);
    const md = formatComparisonMarkdown(snap);
    expect(md).toContain('`gpt-4o-mini`');
    expect(md).toContain('`claude-haiku`');
    expect(md).toContain('0.333');
    expect(md).toContain('0.750');
  });

  it('handles errored entries gracefully', () => {
    const snap = makeSnapshot([{ model: 'bad-model', error: 'rate limited' }]);
    const md = formatComparisonMarkdown(snap);
    expect(md).toContain('❌ error');
    expect(md).not.toContain('SKIP_REFUSAL');
    // Table header must be present even for all-error snapshots
    expect(md).toContain('| Model |');
  });

  it('handles mixed errored and successful entries', () => {
    const snap = makeSnapshot([
      { model: 'good-model', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
      { model: 'bad-model', error: 'connection timeout' },
    ]);
    const md = formatComparisonMarkdown(snap);
    expect(md).toContain('❌ error');
    // Both models must appear as table rows (pipe-delimited with backtick name)
    expect(md).toContain('| `good-model`');
    expect(md).toContain('| `bad-model`');
    expect(md).not.toContain('SKIP_REFUSAL');
  });

  it('shows skipped message when no refusal data', () => {
    const snap = makeSnapshot([{ model: 'gpt-4o-mini' }]);
    snap.entries[0]!.refusal = null;
    const md = formatComparisonMarkdown(snap);
    expect(md).toContain('SKIP_REFUSAL');
  });

  it('includes raw data reference', () => {
    const snap = makeSnapshot([{ model: 'gpt-4o-mini', safe: 1.0 }]);
    const md = formatComparisonMarkdown(snap);
    expect(md).toContain('Raw Data');
  });

  it('shows no-differences message when models are consistent', () => {
    const snap = makeSnapshot([
      { model: 'gpt', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
      { model: 'claude', safe: 1.0, dangerous: 1.0, borderline: 0.5 },
    ]);
    const md = formatComparisonMarkdown(snap);
    expect(md).toContain('No meaningful behavioral differences');
  });
});
