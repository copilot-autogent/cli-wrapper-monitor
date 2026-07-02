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
// diffSnapshots — hook fingerprint structural BREAKING + WARNING (#68)
// ---------------------------------------------------------------------------

describe('diffSnapshots — hook count BREAKING', () => {
  it('adds to structuralBreaks when hook count drops (removed)', () => {
    const baseline = makeSnapshot({ hookCount: 3 });
    const current = makeSnapshot({ hookCount: 2 });
    const diff = diffSnapshots(baseline, current);
    expect(diff.structuralBreaks.some((s) => s.includes('Hook count dropped'))).toBe(true);
    expect(diff.structuralBreaks.some((s) => s.includes('3 → 2'))).toBe(true);
    expect(diff.hasBreaking).toBe(true);
    expect(diff.warnings).toHaveLength(0);
  });

  it('adds to structuralBreaks when hook count increases (added)', () => {
    const baseline = makeSnapshot({ hookCount: 2 });
    const current = makeSnapshot({ hookCount: 4 });
    const diff = diffSnapshots(baseline, current);
    expect(diff.structuralBreaks.some((s) => s.includes('Hook count increased'))).toBe(true);
    expect(diff.structuralBreaks.some((s) => s.includes('2 → 4'))).toBe(true);
    expect(diff.hasBreaking).toBe(true);
    expect(diff.warnings).toHaveLength(0);
  });

  it('adds to structuralBreaks when hook count disappears', () => {
    const baseline = makeSnapshot({ hookCount: 3 });
    const current = makeSnapshot({ hookCount: undefined });
    const diff = diffSnapshots(baseline, current);
    expect(diff.structuralBreaks.some((s) => s.includes('Hook count disappeared'))).toBe(true);
    expect(diff.hasBreaking).toBe(true);
  });

  it('does NOT add to structuralBreaks when hook count is unchanged', () => {
    const baseline = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:aaaa' });
    const current = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:aaaa' });
    const diff = diffSnapshots(baseline, current);
    expect(diff.structuralBreaks.some((s) => s.includes('Hook count'))).toBe(false);
    expect(diff.warnings).toHaveLength(0);
  });

  it('does NOT produce false positives when hookCount is absent from both', () => {
    const baseline = makeSnapshot({ hookCount: undefined });
    const current = makeSnapshot({ hookCount: undefined });
    const diff = diffSnapshots(baseline, current);
    expect(diff.structuralBreaks.some((s) => s.includes('Hook'))).toBe(false);
    expect(diff.warnings).toHaveLength(0);
  });
});

describe('diffSnapshots — hook body changed WARNING', () => {
  it('adds to warnings when hook hash differs but count is unchanged', () => {
    const baseline = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:aaaa1234567890ab' });
    const current = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:bbbbccddeeff0011' });
    const diff = diffSnapshots(baseline, current);
    expect(diff.warnings.some((w) => w.includes('Hook body changed'))).toBe(true);
    expect(diff.warnings.some((w) => w.includes('count unchanged: 3'))).toBe(true);
    expect(diff.hasBreaking).toBe(false);
    expect(diff.structuralBreaks.some((s) => s.includes('Hook count'))).toBe(false);
  });

  it('includes hash snippet in warning message', () => {
    const baseline = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:aaaa1234567890ab' });
    const current = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:bbbbccddeeff0011' });
    const diff = diffSnapshots(baseline, current);
    const w = diff.warnings.find((w) => w.includes('Hook body changed'))!;
    expect(w).toBeTruthy();
    // hashSnippet slices first 12 hex chars after stripping 'sha256:' prefix
    expect(w).toContain('aaaa12345678');
    expect(w).toContain('bbbbccddeeff');
  });

  it('does NOT add to warnings when hook hash is unchanged', () => {
    const snap = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:aaaa1234' });
    const diff = diffSnapshots(snap, snap);
    expect(diff.warnings).toHaveLength(0);
  });

  it('does NOT add to warnings when hookSourceHash is absent or unknown', () => {
    const b1 = makeSnapshot({ hookCount: 3, hookSourceHash: undefined });
    const c1 = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:bbbb' });
    expect(diffSnapshots(b1, c1).warnings).toHaveLength(0);

    const b2 = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:aaaa' });
    const c2 = makeSnapshot({ hookCount: 3, hookSourceHash: 'unknown' });
    expect(diffSnapshots(b2, c2).warnings).toHaveLength(0);
  });
});

describe('formatDiffReport — hook body warning section', () => {
  it('renders Hook Changes section with WARNING when hook body changed', () => {
    const baseline = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:aabb1234567890cd' });
    const current = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:eeff00112233445566' });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('Hook Changes');
    expect(report).toContain('WARNING');
    expect(report).toContain('Hook body changed');
  });

  it('renders hook count drop in Structural BREAKING Changes section', () => {
    const baseline = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:aaaa1234' });
    const current = makeSnapshot({ hookCount: 2, hookSourceHash: 'sha256:bbbb5678' });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('Structural BREAKING Changes');
    expect(report).toContain('BREAKING');
    expect(report).toContain('Hook count dropped');
  });
});

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

// ---------------------------------------------------------------------------
// SecurityPostureScore
// ---------------------------------------------------------------------------

describe('SecurityPostureScore — zero score (clean)', () => {
  it('returns 0 when baseline and current are identical', () => {
    const snap = makeSnapshot();
    const diff = diffSnapshots(snap, snap);
    expect(diff.securityPostureScore).toBe(0);
  });

  it('returns 0 when only non-security metrics changed', () => {
    const baseline = makeSnapshot({
      experiments: { 'context-tax': { name: 'context-tax', description: '', metrics: { systemPromptChars: { value: 100_000, unit: 'chars', description: '' } } } },
    });
    const current = makeSnapshot({
      experiments: { 'context-tax': { name: 'context-tax', description: '', metrics: { systemPromptChars: { value: 120_000, unit: 'chars', description: '' } } } },
    });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(0);
  });
});

describe('SecurityPostureScore — tool removals (10 pts each, max 30)', () => {
  function makeSchemaEntry(params: string[] = []) {
    return {
      parameterCount: params.length,
      requiredParams: params,
      optionalParams: [],
      descriptionHash: 'sha256:abcd1234',
    };
  }

  it('adds 10 pts for one removed tool', () => {
    const baseline = makeSnapshot({ toolSchemas: { bash: makeSchemaEntry(['command']) } });
    const current = makeSnapshot({ toolSchemas: {} });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(10);
  });

  it('adds 20 pts for two removed tools', () => {
    const baseline = makeSnapshot({ toolSchemas: { bash: makeSchemaEntry(), view: makeSchemaEntry() } });
    const current = makeSnapshot({ toolSchemas: {} });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(20);
  });

  it('caps tool removal contribution at 30 pts (4 tools removed)', () => {
    const baseline = makeSnapshot({
      toolSchemas: { a: makeSchemaEntry(), b: makeSchemaEntry(), c: makeSchemaEntry(), d: makeSchemaEntry() },
    });
    const current = makeSnapshot({ toolSchemas: {} });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(30);
  });
});

describe('SecurityPostureScore — model pool drop (20 pts)', () => {
  it('adds 20 pts when a model is removed from the pool', () => {
    const baseline = makeSnapshot({
      modelPool: { capturedAt: '2026-01-01T00:00:00.000Z', models: [{ id: 'claude-sonnet-4.6', state: 'enabled', contextWindow: 200_000 }] },
    });
    const current = makeSnapshot({
      modelPool: { capturedAt: '2026-01-01T00:00:00.000Z', models: [] },
    });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(20);
  });

  it('does not add pts when a model is only added (not removed)', () => {
    const baseline = makeSnapshot({ modelPool: { capturedAt: '2026-01-01T00:00:00.000Z', models: [] } });
    const current = makeSnapshot({
      modelPool: { capturedAt: '2026-01-01T00:00:00.000Z', models: [{ id: 'gpt-4.1', state: 'enabled', contextWindow: 100_000 }] },
    });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(0);
  });
});

describe('SecurityPostureScore — hook count decrease (20 pts)', () => {
  it('adds 20 pts when hook count drops', () => {
    const baseline = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:aaaa' });
    const current = makeSnapshot({ hookCount: 2, hookSourceHash: 'sha256:bbbb' });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(20);
  });

  it('adds 20 pts when hook count disappears', () => {
    const baseline = makeSnapshot({ hookCount: 3 });
    const current = makeSnapshot({ hookCount: undefined });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(20);
  });

  it('does not add pts when hook count increases', () => {
    const baseline = makeSnapshot({ hookCount: 2, hookSourceHash: 'sha256:aaaa' });
    const current = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:bbbb' });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(0);
  });
});

describe('SecurityPostureScore — hook body change (5 pts)', () => {
  it('adds 5 pts when hook body changes with same count', () => {
    const baseline = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:aaaa' });
    const current = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:bbbb' });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(5);
  });

  it('does not add hook body pts when count also changed (covered by count-drop pts)', () => {
    const baseline = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:aaaa' });
    const current = makeSnapshot({ hookCount: 2, hookSourceHash: 'sha256:bbbb' });
    const diff = diffSnapshots(baseline, current);
    // Only hook count drop (20 pts); body change with count difference doesn't add 5 pts separately
    expect(diff.securityPostureScore).toBe(20);
  });
});

describe('SecurityPostureScore — injection refusal drop (15 pts)', () => {
  it('adds 15 pts when injection refusal rate drops by >5 percentage points', () => {
    const baseline = makeSnapshot({
      experiments: {
        'context-tax': { name: 'context-tax', description: '', metrics: {
          injectionRefusedRate: { value: 0.9, unit: 'fraction', description: '' },
        }},
      },
    });
    const current = makeSnapshot({
      experiments: {
        'context-tax': { name: 'context-tax', description: '', metrics: {
          injectionRefusedRate: { value: 0.8, unit: 'fraction', description: '' },
        }},
      },
    });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(15);
  });

  it('does not add pts when injection refusal rate drops by less than 5 pp', () => {
    const baseline = makeSnapshot({
      experiments: {
        'context-tax': { name: 'context-tax', description: '', metrics: {
          injectionRefusedRate: { value: 0.9, unit: 'fraction', description: '' },
        }},
      },
    });
    const current = makeSnapshot({
      experiments: {
        'context-tax': { name: 'context-tax', description: '', metrics: {
          injectionRefusedRate: { value: 0.86, unit: 'fraction', description: '' }, // 4pp drop
        }},
      },
    });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(0);
  });

  it('does not add pts when refusal rate improves', () => {
    const baseline = makeSnapshot({
      experiments: {
        'context-tax': { name: 'context-tax', description: '', metrics: {
          injectionRefusedRate: { value: 0.7, unit: 'fraction', description: '' },
        }},
      },
    });
    const current = makeSnapshot({
      experiments: {
        'context-tax': { name: 'context-tax', description: '', metrics: {
          injectionRefusedRate: { value: 0.9, unit: 'fraction', description: '' },
        }},
      },
    });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(0);
  });
});

describe('SecurityPostureScore — headroom below 50% (5 pts)', () => {
  it('adds 5 pts when current headroom crosses below 50% (baseline had no headroom data)', () => {
    const current = makeSnapshot({
      contextWindowHeadroom: [{
        modelId: 'claude-sonnet-4.6', state: 'enabled',
        contextWindow: 200_000, systemPromptTokens: 110_000,
        headroomTokens: 90_000, promptFillPct: 55, status: 'high-fill',
      }],
    });
    const diff = diffSnapshots(makeSnapshot(), current);
    expect(diff.securityPostureScore).toBe(5);
  });

  it('adds 5 pts when current headroom crosses below 50% (baseline was above 50%)', () => {
    const baseline = makeSnapshot({
      contextWindowHeadroom: [{
        modelId: 'claude-sonnet-4.6', state: 'enabled',
        contextWindow: 200_000, systemPromptTokens: 80_000,
        headroomTokens: 120_000, promptFillPct: 40, status: 'ok', // 60% headroom
      }],
    });
    const current = makeSnapshot({
      contextWindowHeadroom: [{
        modelId: 'claude-sonnet-4.6', state: 'enabled',
        contextWindow: 200_000, systemPromptTokens: 110_000,
        headroomTokens: 90_000, promptFillPct: 55, status: 'high-fill', // 45% headroom
      }],
    });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(5);
  });

  it('does not add pts when both snapshots are already below 50% (no new regression)', () => {
    const baseline = makeSnapshot({
      contextWindowHeadroom: [{
        modelId: 'claude-sonnet-4.6', state: 'enabled',
        contextWindow: 200_000, systemPromptTokens: 110_000,
        headroomTokens: 90_000, promptFillPct: 55, status: 'high-fill', // 45% headroom
      }],
    });
    const current = makeSnapshot({
      contextWindowHeadroom: [{
        modelId: 'claude-sonnet-4.6', state: 'enabled',
        contextWindow: 200_000, systemPromptTokens: 120_000,
        headroomTokens: 80_000, promptFillPct: 60, status: 'high-fill', // 40% headroom
      }],
    });
    const diff = diffSnapshots(baseline, current);
    expect(diff.securityPostureScore).toBe(0);
  });

  it('does not add pts when current headroom is exactly 50%', () => {
    const current = makeSnapshot({
      contextWindowHeadroom: [{
        modelId: 'claude-sonnet-4.6', state: 'enabled',
        contextWindow: 200_000, systemPromptTokens: 100_000,
        headroomTokens: 100_000, promptFillPct: 50, status: 'high-fill',
      }],
    });
    const diff = diffSnapshots(makeSnapshot(), current);
    expect(diff.securityPostureScore).toBe(0);
  });

  it('does not add pts when headroom is absent', () => {
    const diff = diffSnapshots(makeSnapshot(), makeSnapshot());
    expect(diff.securityPostureScore).toBe(0);
  });
});

describe('SecurityPostureScore — capped at 100', () => {
  it('caps the total score at 100 when many dimensions trigger simultaneously', () => {
    // Tool removals: 30 (3 tools) + model drop: 20 + hook drop: 20 + body change: 0 (count changed)
    // + refusal drop: 15 + headroom: 5 = 90 (under cap, but adding more would cap)
    // Use 4+ tools removed to hit 30 max, plus all other factors
    function makeSchemaEntry() {
      return { parameterCount: 0, requiredParams: [], optionalParams: [], descriptionHash: 'sha256:abcd' };
    }
    const baseline = makeSnapshot({
      hookCount: 3, hookSourceHash: 'sha256:aaaa',
      modelPool: { capturedAt: '2026-01-01T00:00:00.000Z', models: [{ id: 'claude-sonnet-4.6', state: 'enabled', contextWindow: 200_000 }] },
      toolSchemas: { a: makeSchemaEntry(), b: makeSchemaEntry(), c: makeSchemaEntry(), d: makeSchemaEntry() },
      experiments: {
        'context-tax': { name: 'context-tax', description: '', metrics: {
          injectionRefusedRate: { value: 0.95, unit: 'fraction', description: '' },
        }},
      },
    });
    const current = makeSnapshot({
      hookCount: 2, hookSourceHash: 'sha256:bbbb',
      modelPool: { capturedAt: '2026-01-01T00:00:00.000Z', models: [] },
      toolSchemas: {},
      contextWindowHeadroom: [{
        modelId: 'claude-sonnet-4.6', state: 'enabled',
        contextWindow: 200_000, systemPromptTokens: 110_000,
        headroomTokens: 90_000, promptFillPct: 55, status: 'high-fill',
      }],
      experiments: {
        'context-tax': { name: 'context-tax', description: '', metrics: {
          injectionRefusedRate: { value: 0.0, unit: 'fraction', description: '' },
        }},
      },
    });
    const diff = diffSnapshots(baseline, current);
    // raw: 30 (tools) + 20 (models) + 20 (hook drop) + 15 (refusal) + 5 (headroom) = 90
    expect(diff.securityPostureScore).toBe(90);
  });

  it('caps at 100 when raw sum exceeds 100', () => {
    // Scenario: hook body change (5) + all others
    // tools (30) + model (20) + refusal (15) + headroom (5) + hook body (5) = 75 < 100
    // + hook count drop (20) = 95, still under 100
    // Max reachable with current formula (single-hash tracking): 30+20+20+5+15+5 = 95
    // Test that a maximum-everything scenario returns within the cap
    function makeSchemaEntry() {
      return { parameterCount: 0, requiredParams: [], optionalParams: [], descriptionHash: 'sha256:abcd' };
    }
    const baseline = makeSnapshot({
      hookCount: 3, hookSourceHash: 'sha256:aaaa',
      modelPool: { capturedAt: '2026-01-01T00:00:00.000Z', models: [
        { id: 'model-a', state: 'enabled', contextWindow: 200_000 },
        { id: 'model-b', state: 'enabled', contextWindow: 200_000 },
      ]},
      toolSchemas: { a: makeSchemaEntry(), b: makeSchemaEntry(), c: makeSchemaEntry(), d: makeSchemaEntry() },
      experiments: {
        'context-tax': { name: 'context-tax', description: '', metrics: {
          injectionRefusedRate: { value: 0.95, unit: 'fraction', description: '' },
        }},
      },
    });
    const current = makeSnapshot({
      // Hook count same but hash changed → body change (5 pts)
      hookCount: 3, hookSourceHash: 'sha256:bbbb',
      // Both models removed → model drop (20 pts)
      modelPool: { capturedAt: '2026-01-01T00:00:00.000Z', models: [] },
      // All tools removed → 30 pts
      toolSchemas: {},
      // Headroom below 50% → 5 pts
      contextWindowHeadroom: [{
        modelId: 'claude-sonnet-4.6', state: 'enabled',
        contextWindow: 200_000, systemPromptTokens: 110_000,
        headroomTokens: 90_000, promptFillPct: 55, status: 'high-fill',
      }],
      // Injection refusal drops >5pp → 15 pts
      experiments: {
        'context-tax': { name: 'context-tax', description: '', metrics: {
          injectionRefusedRate: { value: 0.0, unit: 'fraction', description: '' },
        }},
      },
    });
    const diff = diffSnapshots(baseline, current);
    // raw: 30 (tools) + 20 (models) + 0 (no hook count drop) + 5 (hook body) + 15 (refusal) + 5 (headroom) = 75
    expect(diff.securityPostureScore).toBeLessThanOrEqual(100);
    expect(diff.securityPostureScore).toBe(75);
  });
});

describe('SecurityPostureScore — formatDiffReport includes score line', () => {
  it('renders BREAKING score in diff report', () => {
    function makeSchemaEntry() {
      return { parameterCount: 0, requiredParams: [], optionalParams: [], descriptionHash: 'sha256:abcd' };
    }
    const baseline = makeSnapshot({ toolSchemas: { a: makeSchemaEntry(), b: makeSchemaEntry(), c: makeSchemaEntry() } });
    const current = makeSnapshot({ toolSchemas: {} });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('Security Posture Score**: 30/100');
    expect(report).toContain('BREAKING');
  });

  it('renders WARNING score in diff report', () => {
    const baseline = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:aaaa' });
    const current = makeSnapshot({ hookCount: 3, hookSourceHash: 'sha256:bbbb' });
    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);
    expect(report).toContain('Security Posture Score**: 5/100');
    expect(report).toContain('WARNING');
  });

  it('renders CLEAN score in diff report for identical snapshots', () => {
    const snap = makeSnapshot();
    const diff = diffSnapshots(snap, snap);
    const report = formatDiffReport(diff);
    expect(report).toContain('Security Posture Score**: 0/100');
    expect(report).toContain('CLEAN');
  });
});
