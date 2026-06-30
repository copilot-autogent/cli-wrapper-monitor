import { describe, it, expect } from 'vitest';
import { diffSnapshots, formatDiffReport } from './diff.js';
import type { MetricSnapshot } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    monitorVersion: 'abc1234',
    sdkVersion: '^0.2.0',
    model: 'claude-sonnet-4.6',
    binaryHash: 'sha256:aabbcc',
    systemPromptHash: 'sha256:ddeeff',
    hookCount: 3,
    hookSourceHash: 'sha256:112233',
    experiments: {
      'context-tax': {
        name: 'context-tax',
        description: 'test',
        metrics: {
          systemPromptChars: { value: 100_000, unit: 'chars', description: '' },
          toolCount: { value: 10, unit: 'tools', description: '' },
        },
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// hookChanged
// ---------------------------------------------------------------------------

describe('diffSnapshots — hookChanged', () => {
  it('is false when hook hashes are identical', () => {
    const baseline = makeSnapshot();
    const current = makeSnapshot();
    const diff = diffSnapshots(baseline, current);
    expect(diff.hookChanged).toBe(false);
  });

  it('is true when hookSourceHash differs', () => {
    const baseline = makeSnapshot({ hookSourceHash: 'sha256:aaaa' });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb' });
    const diff = diffSnapshots(baseline, current);
    expect(diff.hookChanged).toBe(true);
  });

  it('is false when either hash is "unknown"', () => {
    const baseline = makeSnapshot({ hookSourceHash: 'unknown' });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb' });
    expect(diffSnapshots(baseline, current).hookChanged).toBe(false);

    const baseline2 = makeSnapshot({ hookSourceHash: 'sha256:aaaa' });
    const current2 = makeSnapshot({ hookSourceHash: 'unknown' });
    expect(diffSnapshots(baseline2, current2).hookChanged).toBe(false);
  });

  it('is false when hookSourceHash is absent on either snapshot', () => {
    const baseline = makeSnapshot({ hookSourceHash: undefined });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb' });
    expect(diffSnapshots(baseline, current).hookChanged).toBe(false);

    const baseline2 = makeSnapshot({ hookSourceHash: 'sha256:aaaa' });
    const current2 = makeSnapshot({ hookSourceHash: undefined });
    expect(diffSnapshots(baseline2, current2).hookChanged).toBe(false);
  });

  it('is false when both hashes are absent (old baseline without hook tracking)', () => {
    const baseline = makeSnapshot({ hookSourceHash: undefined, hookCount: undefined });
    const current = makeSnapshot({ hookSourceHash: undefined, hookCount: undefined });
    expect(diffSnapshots(baseline, current).hookChanged).toBe(false);
  });

  it('is false when hookSourceHash is "unknown" on both snapshots', () => {
    const baseline = makeSnapshot({ hookSourceHash: 'unknown' });
    const current = makeSnapshot({ hookSourceHash: 'unknown' });
    expect(diffSnapshots(baseline, current).hookChanged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatDiffReport — hook change rendering
// ---------------------------------------------------------------------------

describe('formatDiffReport — hook change', () => {
  it('includes hook-changed warning when hookChanged is true', () => {
    const baseline = makeSnapshot({ hookSourceHash: 'sha256:aabbccddeeff001122' });
    const current = makeSnapshot({ hookSourceHash: 'sha256:998877665544332211', hookCount: 2 });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('Hook definitions changed');
    // formatDiffReport uses slice(0, 16): 'sha256:' (7) + 9 hex chars
    expect(report).toContain('sha256:aabbccdde');
    expect(report).toContain('sha256:998877665');
  });

  it('includes count delta when hookCount changes', () => {
    const baseline = makeSnapshot({ hookSourceHash: 'sha256:aaaa1234', hookCount: 3 });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb5678', hookCount: 2 });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('count: 3 → 2');
  });

  it('omits count delta note when hookCount is unchanged', () => {
    const baseline = makeSnapshot({ hookSourceHash: 'sha256:aaaa1234', hookCount: 3 });
    const current = makeSnapshot({ hookSourceHash: 'sha256:bbbb5678', hookCount: 3 });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('Hook definitions changed');
    expect(report).not.toContain('count:');
  });

  it('does not include hook-changed warning when hashes are identical', () => {
    const baseline = makeSnapshot();
    const current = makeSnapshot();
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).not.toContain('Hook definitions changed');
  });
});

// ---------------------------------------------------------------------------
// binaryChanged / systemPromptChanged (regression guard)
// ---------------------------------------------------------------------------

describe('diffSnapshots — other hash tracking', () => {
  it('detects binary hash change', () => {
    const baseline = makeSnapshot({ binaryHash: 'sha256:aaaa' });
    const current = makeSnapshot({ binaryHash: 'sha256:bbbb' });
    expect(diffSnapshots(baseline, current).binaryChanged).toBe(true);
  });

  it('detects system prompt hash change', () => {
    const baseline = makeSnapshot({ systemPromptHash: 'sha256:aaaa' });
    const current = makeSnapshot({ systemPromptHash: 'sha256:bbbb' });
    expect(diffSnapshots(baseline, current).systemPromptChanged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// diffToolSchemas
// ---------------------------------------------------------------------------

import { diffToolSchemas } from './diff.js';
import type { ToolParamSchema } from './types.js';

function makeSchema(overrides: Partial<ToolParamSchema> = {}): ToolParamSchema {
  return {
    parameterCount: 2,
    requiredParams: ['command'],
    optionalParams: ['description'],
    descriptionHash: 'abcdef1234567890',
    ...overrides,
  };
}

describe('diffToolSchemas', () => {
  it('returns empty array when both maps are undefined', () => {
    expect(diffToolSchemas(undefined, undefined)).toEqual([]);
  });

  it('returns empty array when baseline is undefined (no spam against old baselines)', () => {
    expect(diffToolSchemas(undefined, { bash: makeSchema() })).toEqual([]);
  });

  it('returns empty array when current is undefined', () => {
    expect(diffToolSchemas({ bash: makeSchema() }, undefined)).toEqual([]);
  });

  it('returns empty array when schemas are identical', () => {
    const schema = makeSchema();
    expect(diffToolSchemas({ bash: schema }, { bash: schema })).toEqual([]);
  });

  it('detects added tool', () => {
    const result = diffToolSchemas({}, { bash: makeSchema() });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('added');
    expect(result[0].toolName).toBe('bash');
    expect(result[0].after).toBeDefined();
  });

  it('detects removed tool', () => {
    const result = diffToolSchemas({ bash: makeSchema() }, {});
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('removed');
    expect(result[0].toolName).toBe('bash');
    expect(result[0].before).toBeDefined();
  });

  it('detects added parameter', () => {
    const before = makeSchema({ parameterCount: 1, requiredParams: ['command'], optionalParams: [] });
    const after = makeSchema({ parameterCount: 2, requiredParams: ['command'], optionalParams: ['mode'] });
    const result = diffToolSchemas({ bash: before }, { bash: after });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('params_changed');
    expect(result[0].addedParams).toEqual(['mode']);
    expect(result[0].removedParams).toEqual([]);
  });

  it('detects removed parameter', () => {
    const before = makeSchema({ parameterCount: 2, requiredParams: ['command'], optionalParams: ['mode'] });
    const after = makeSchema({ parameterCount: 1, requiredParams: ['command'], optionalParams: [] });
    const result = diffToolSchemas({ bash: before }, { bash: after });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('params_changed');
    expect(result[0].removedParams).toEqual(['mode']);
    expect(result[0].addedParams).toEqual([]);
  });

  it('detects description change', () => {
    const before = makeSchema({ descriptionHash: 'aaaaaaaaaaaa' });
    const after = makeSchema({ descriptionHash: 'bbbbbbbbbbbb' });
    const result = diffToolSchemas({ bash: before }, { bash: after });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('description_changed');
    expect(result[0].toolName).toBe('bash');
  });

  it('does NOT flag description change when params also changed', () => {
    // params_changed takes priority over description_changed
    const before = makeSchema({ optionalParams: [], descriptionHash: 'aaaa' });
    const after = makeSchema({ optionalParams: ['extra'], descriptionHash: 'bbbb' });
    const result = diffToolSchemas({ bash: before }, { bash: after });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('params_changed');
  });

  it('handles multiple tools with mixed changes', () => {
    const result = diffToolSchemas(
      { bash: makeSchema(), grep: makeSchema() },
      { bash: makeSchema({ descriptionHash: 'changed' }), view: makeSchema() },
    );
    const types = new Set(result.map((r) => r.type));
    expect(types).toContain('description_changed'); // bash
    expect(types).toContain('removed');             // grep
    expect(types).toContain('added');               // view
    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// diffSnapshots — tool removal → BREAKING (issue #57)
// ---------------------------------------------------------------------------

describe('diffSnapshots — tool removal structural BREAKING', () => {
  it('marks hasBreaking when a named tool is removed from toolSchemas', () => {
    const baseline = makeSnapshot({ toolSchemas: { bash: makeSchema(), grep: makeSchema() } });
    const current = makeSnapshot({ toolSchemas: { bash: makeSchema() } }); // grep removed
    const diff = diffSnapshots(baseline, current);
    expect(diff.hasBreaking).toBe(true);
    expect(diff.structuralBreaks.some((s) => s.includes('grep'))).toBe(true);
    expect(diff.structuralBreaks.some((s) => s.includes('Tool removed'))).toBe(true);
  });

  it('includes removed tool name in structural break message', () => {
    const baseline = makeSnapshot({ toolSchemas: { my_tool: makeSchema({ parameterCount: 3 }) } });
    const current = makeSnapshot({ toolSchemas: {} });
    const diff = diffSnapshots(baseline, current);
    const msg = diff.structuralBreaks.find((s) => s.includes('my_tool'));
    expect(msg).toBeDefined();
    expect(msg).toContain('Tool removed');
    expect(msg).toContain('3 params');
  });

  it('reports singular "param" when parameterCount is 1', () => {
    const baseline = makeSnapshot({ toolSchemas: { solo: makeSchema({ parameterCount: 1 }) } });
    const current = makeSnapshot({ toolSchemas: {} });
    const diff = diffSnapshots(baseline, current);
    const msg = diff.structuralBreaks.find((s) => s.includes('solo'));
    expect(msg).toContain('1 param');
    expect(msg).not.toContain('1 params');
  });

  it('reports "parameter count unknown" when schema before has no parameterCount', () => {
    const schemaNoCount = { ...makeSchema(), parameterCount: undefined as unknown as number };
    const baseline = makeSnapshot({ toolSchemas: { mystery: schemaNoCount } });
    const current = makeSnapshot({ toolSchemas: {} });
    const diff = diffSnapshots(baseline, current);
    const msg = diff.structuralBreaks.find((s) => s.includes('mystery'));
    expect(msg).toContain('parameter count unknown');
  });

  it('increments structuralBreakCount for each removed tool', () => {
    const baseline = makeSnapshot({
      toolSchemas: { bash: makeSchema(), grep: makeSchema(), view: makeSchema() },
    });
    const current = makeSnapshot({ toolSchemas: { bash: makeSchema() } }); // 2 removed
    const diff = diffSnapshots(baseline, current);
    expect(diff.severitySummary.structuralBreakCount).toBeGreaterThanOrEqual(2);
  });

  it('does NOT add structural break for added tool', () => {
    const baseline = makeSnapshot({ toolSchemas: { bash: makeSchema() } });
    const current = makeSnapshot({ toolSchemas: { bash: makeSchema(), view: makeSchema() } });
    const diff = diffSnapshots(baseline, current);
    const toolBreaks = diff.structuralBreaks.filter((s) => s.includes('Tool removed'));
    expect(toolBreaks).toHaveLength(0);
    expect(diff.hasBreaking).toBe(false);
  });

  it('does NOT mark BREAKING when baseline toolSchemas is absent (no false positives vs old baselines)', () => {
    const baseline = makeSnapshot({ toolSchemas: undefined });
    const current = makeSnapshot({ toolSchemas: { bash: makeSchema() } });
    const diff = diffSnapshots(baseline, current);
    const toolBreaks = diff.structuralBreaks.filter((s) => s.includes('Tool removed'));
    expect(toolBreaks).toHaveLength(0);
    expect(diff.hasBreaking).toBe(false);
  });

  it('does NOT mark BREAKING when baseline has empty toolSchemas {} and current has undefined (nothing was tracked)', () => {
    const baseline = makeSnapshot({ toolSchemas: {} }); // empty — nothing was tracked
    const current = makeSnapshot({ toolSchemas: undefined });
    const diff = diffSnapshots(baseline, current);
    expect(diff.hasBreaking).toBe(false);
    expect(diff.structuralBreaks.filter((s) => s.includes('Tool schema data disappeared'))).toHaveLength(0);
  });

  it('marks BREAKING when baseline had schemas but current toolSchemas is undefined (capture failure)', () => {
    const baseline = makeSnapshot({ toolSchemas: { bash: makeSchema(), grep: makeSchema() } });
    const current = makeSnapshot({ toolSchemas: undefined });
    const diff = diffSnapshots(baseline, current);
    expect(diff.hasBreaking).toBe(true);
    expect(diff.structuralBreaks.some((s) => s.includes('Tool schema data disappeared'))).toBe(true);
  });
});

describe('diffSnapshots — toolSchemaChanged', () => {
  it('is false when tool schema hashes are identical', () => {
    const snap = makeSnapshot({ toolSchemaHash: 'sha256:same', toolSchemas: {} });
    expect(diffSnapshots(snap, snap).toolSchemaChanged).toBe(false);
  });

  it('is true when tool schema hashes differ', () => {
    const baseline = makeSnapshot({ toolSchemaHash: 'sha256:aaaa', toolSchemas: {} });
    const current = makeSnapshot({ toolSchemaHash: 'sha256:bbbb', toolSchemas: {} });
    expect(diffSnapshots(baseline, current).toolSchemaChanged).toBe(true);
  });

  it('is false when either hash is absent', () => {
    const baseline = makeSnapshot({ toolSchemaHash: undefined });
    const current = makeSnapshot({ toolSchemaHash: 'sha256:bbbb' });
    expect(diffSnapshots(baseline, current).toolSchemaChanged).toBe(false);
  });

  it('populates toolSchemaChanges from schema maps', () => {
    const baseline = makeSnapshot({
      toolSchemaHash: 'sha256:aaaa',
      toolSchemas: { bash: makeSchema() },
    });
    const current = makeSnapshot({
      toolSchemaHash: 'sha256:bbbb',
      toolSchemas: { bash: makeSchema(), view: makeSchema() },
    });
    const diff = diffSnapshots(baseline, current);
    expect(diff.toolSchemaChanges).toHaveLength(1);
    expect(diff.toolSchemaChanges[0].type).toBe('added');
    expect(diff.toolSchemaChanges[0].toolName).toBe('view');
  });
});

// ---------------------------------------------------------------------------
// formatDiffReport — tool schema change rendering
// ---------------------------------------------------------------------------

describe('formatDiffReport — tool schema changes', () => {
  it('renders added tool', () => {
    const baseline = makeSnapshot({ toolSchemas: {} });
    const current = makeSnapshot({ toolSchemas: { bash: makeSchema() } });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('Added tool');
    expect(report).toContain('bash');
  });

  it('renders removed tool', () => {
    const baseline = makeSnapshot({ toolSchemas: { bash: makeSchema() } });
    const current = makeSnapshot({ toolSchemas: {} });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('Removed tool');
    expect(report).toContain('bash');
  });

  it('renders params changed', () => {
    const before = makeSchema({ optionalParams: [] });
    const after = makeSchema({ optionalParams: ['mode'], parameterCount: 3 });
    const baseline = makeSnapshot({ toolSchemas: { bash: before } });
    const current = makeSnapshot({ toolSchemas: { bash: after } });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('Params changed');
    expect(report).toContain('mode');
  });

  it('renders description changed', () => {
    const before = makeSchema({ descriptionHash: 'aabbccdd11223344' });
    const after = makeSchema({ descriptionHash: 'eeff99887766554433221100' });
    const baseline = makeSnapshot({ toolSchemas: { bash: before } });
    const current = makeSnapshot({ toolSchemas: { bash: after } });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('Description changed');
    expect(report).toContain('aabbccdd');
    expect(report).toContain('eeff9988');
  });

  it('renders "no changes" when schemas present but identical', () => {
    const schema = { bash: makeSchema() };
    const baseline = makeSnapshot({ toolSchemas: schema });
    const current = makeSnapshot({ toolSchemas: schema });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('No tool schema changes detected');
  });
});
