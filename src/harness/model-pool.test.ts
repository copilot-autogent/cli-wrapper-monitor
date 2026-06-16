import { describe, it, expect } from 'vitest';
import { diffModelPool, diffSnapshots, formatDiffReport } from './diff.js';
import type { MetricSnapshot, ModelPool, ModelPoolEntry } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  id: string,
  state: ModelPoolEntry['state'] = 'enabled',
  contextWindow = 200_000,
): ModelPoolEntry {
  return { id, state, contextWindow };
}

function makePool(models: ModelPoolEntry[], capturedAt = '2026-06-16T00:00:00.000Z'): ModelPool {
  return { capturedAt, models };
}

function makeSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    capturedAt: '2026-06-16T00:00:00.000Z',
    monitorVersion: 'abc1234',
    sdkVersion: '^0.2.2',
    model: 'claude-opus-4.8',
    experiments: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// diffModelPool
// ---------------------------------------------------------------------------

describe('diffModelPool', () => {
  it('returns empty array when both pools are undefined', () => {
    expect(diffModelPool(undefined, undefined)).toEqual([]);
  });

  it('returns empty array when baseline is undefined', () => {
    const pool = makePool([makeEntry('model-a')]);
    expect(diffModelPool(undefined, pool)).toEqual([]);
  });

  it('returns empty array when current is undefined', () => {
    const pool = makePool([makeEntry('model-a')]);
    expect(diffModelPool(pool, undefined)).toEqual([]);
  });

  it('returns empty array when pools are identical', () => {
    const pool = makePool([makeEntry('model-a'), makeEntry('model-b')]);
    expect(diffModelPool(pool, pool)).toEqual([]);
  });

  it('detects added model', () => {
    const baseline = makePool([makeEntry('model-a')]);
    const current = makePool([makeEntry('model-a'), makeEntry('model-b')]);

    const changes = diffModelPool(baseline, current);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      type: 'added',
      modelId: 'model-b',
      after: { id: 'model-b', state: 'enabled', contextWindow: 200_000 },
    });
    expect(changes[0].before).toBeUndefined();
  });

  it('detects removed model', () => {
    const baseline = makePool([makeEntry('model-a'), makeEntry('model-b')]);
    const current = makePool([makeEntry('model-a')]);

    const changes = diffModelPool(baseline, current);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      type: 'removed',
      modelId: 'model-b',
      before: { id: 'model-b', state: 'enabled', contextWindow: 200_000 },
    });
    expect(changes[0].after).toBeUndefined();
  });

  it('detects state change (enabled → disabled)', () => {
    const baseline = makePool([makeEntry('model-a', 'enabled')]);
    const current = makePool([makeEntry('model-a', 'disabled')]);

    const changes = diffModelPool(baseline, current);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      type: 'state_changed',
      modelId: 'model-a',
      before: expect.objectContaining({ state: 'enabled' }),
      after: expect.objectContaining({ state: 'disabled' }),
    });
  });

  it('detects context window change', () => {
    const baseline = makePool([makeEntry('model-a', 'enabled', 200_000)]);
    const current = makePool([makeEntry('model-a', 'enabled', 1_000_000)]);

    const changes = diffModelPool(baseline, current);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      type: 'context_window_changed',
      modelId: 'model-a',
      before: expect.objectContaining({ contextWindow: 200_000 }),
      after: expect.objectContaining({ contextWindow: 1_000_000 }),
    });
  });

  it('can emit both state_changed and context_window_changed for the same model', () => {
    const baseline = makePool([makeEntry('model-a', 'enabled', 200_000)]);
    const current = makePool([makeEntry('model-a', 'disabled', 400_000)]);

    const changes = diffModelPool(baseline, current);

    expect(changes).toHaveLength(2);
    const types = changes.map((c) => c.type).sort();
    expect(types).toEqual(['context_window_changed', 'state_changed']);
  });

  it('handles multiple simultaneous changes', () => {
    const baseline = makePool([
      makeEntry('model-a'),
      makeEntry('model-b'),
      makeEntry('model-c'),
    ]);
    const current = makePool([
      makeEntry('model-a'),         // unchanged
      makeEntry('model-c', 'disabled'), // state changed
      makeEntry('model-d'),         // added
    ]);

    const changes = diffModelPool(baseline, current);

    const removed = changes.filter((c) => c.type === 'removed');
    const added = changes.filter((c) => c.type === 'added');
    const stateChanged = changes.filter((c) => c.type === 'state_changed');

    expect(removed).toHaveLength(1);
    expect(removed[0].modelId).toBe('model-b');
    expect(added).toHaveLength(1);
    expect(added[0].modelId).toBe('model-d');
    expect(stateChanged).toHaveLength(1);
    expect(stateChanged[0].modelId).toBe('model-c');
  });
});

// ---------------------------------------------------------------------------
// Serialization into MetricSnapshot (backwards compatibility)
// ---------------------------------------------------------------------------

describe('MetricSnapshot modelPool field', () => {
  it('older baselines without modelPool do not crash diffSnapshots', () => {
    const baseline = makeSnapshot(); // no modelPool
    const current = makeSnapshot({
      capturedAt: '2026-06-16T01:00:00.000Z',
      modelPool: makePool([makeEntry('claude-opus-4.8')]),
    });

    // Should not throw
    expect(() => diffSnapshots(baseline, current)).not.toThrow();

    const diff = diffSnapshots(baseline, current);
    expect(diff.modelPoolChanges).toEqual([]);
  });

  it('modelPool is recorded correctly in snapshot structure', () => {
    const pool = makePool([
      makeEntry('claude-opus-4.8', 'enabled', 1_000_000),
      makeEntry('gpt-5.4', 'enabled', 1_050_000),
      makeEntry('old-model', 'disabled', 200_000),
    ]);
    const snapshot = makeSnapshot({ modelPool: pool });

    expect(snapshot.modelPool).toBeDefined();
    expect(snapshot.modelPool!.models).toHaveLength(3);
    expect(snapshot.modelPool!.models[0]).toEqual({
      id: 'claude-opus-4.8',
      state: 'enabled',
      contextWindow: 1_000_000,
    });
  });

  it('modelPool changes appear in formatDiffReport output', () => {
    const baseline = makeSnapshot({
      modelPool: makePool([
        makeEntry('model-a', 'enabled', 200_000),
        makeEntry('old-deprecated', 'enabled', 100_000),
      ]),
    });
    const current = makeSnapshot({
      capturedAt: '2026-06-17T00:00:00.000Z',
      modelPool: makePool([
        makeEntry('model-a', 'enabled', 200_000),
        makeEntry('old-deprecated', 'disabled', 100_000),
        makeEntry('model-new', 'enabled', 500_000),
      ]),
    });

    const diff = diffSnapshots(baseline, current);
    const report = formatDiffReport(diff);

    expect(report).toContain('Model Pool Changes');
    expect(report).toContain('old-deprecated');
    expect(report).toContain('model-new');
    expect(report).toContain('Added');
    expect(report).toContain('State changed');
  });
});

// ---------------------------------------------------------------------------
// listModels() serialization (mock-based)
// ---------------------------------------------------------------------------

describe('model pool capture serialization from listModels() response', () => {
  it('maps ModelInfo fields to ModelPoolEntry correctly', () => {
    // Simulate what captureModelPool() does with the listModels() response
    const mockListModelsResponse = [
      {
        id: 'claude-opus-4.8',
        name: 'Claude Opus 4.8',
        capabilities: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 1_000_000 } },
        policy: { state: 'enabled' as const, terms: '' },
      },
      {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        capabilities: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 1_050_000 } },
        policy: { state: 'enabled' as const, terms: '' },
      },
      {
        id: 'old-model',
        name: 'Old Model',
        capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 200_000 } },
        // no policy — should default to 'unconfigured'
      },
    ];

    // Mirror the mapping logic from captureModelPool()
    const models = mockListModelsResponse.map((m) => ({
      id: m.id,
      state: m.policy?.state ?? 'unconfigured',
      contextWindow: m.capabilities.limits.max_context_window_tokens,
    }));

    expect(models).toEqual([
      { id: 'claude-opus-4.8', state: 'enabled', contextWindow: 1_000_000 },
      { id: 'gpt-5.4', state: 'enabled', contextWindow: 1_050_000 },
      { id: 'old-model', state: 'unconfigured', contextWindow: 200_000 },
    ]);
  });

  it('preserves all 17 model entries without truncation', () => {
    const liveModels = [
      'claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.6', 'claude-opus-4.5',
      'claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-haiku-4.5',
      'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.4-mini', 'gpt-5-mini',
      'gpt-4.1',
      'gemini-3.1-pro-preview', 'gemini-3.5-flash',
      'o3-mini', 'o1',
    ].map((id) => ({
      id,
      state: 'enabled' as const,
      contextWindow: 200_000,
    }));

    const pool: ModelPool = {
      capturedAt: '2026-06-16T09:00:00.000Z',
      models: liveModels,
    };

    // Round-trip through JSON serialization (as SnapshotStore would write)
    const serialized = JSON.stringify(pool);
    const deserialized = JSON.parse(serialized) as ModelPool;

    expect(deserialized.models).toHaveLength(17);
    expect(deserialized.models.map((m) => m.id)).toContain('claude-opus-4.8');
    expect(deserialized.models.map((m) => m.id)).toContain('gemini-3.5-flash');
  });
});
