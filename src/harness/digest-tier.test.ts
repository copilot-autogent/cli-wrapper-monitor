import { describe, it, expect } from 'vitest';
import {
  buildDriftMagnitude,
  classifyDigestTier,
  DEFAULT_TIER_THRESHOLDS,
} from './digest-tier.js';
import { buildDigestMessage } from './weekly-digest.js';
import type { DiffReport, MetricSnapshot } from './types.js';
import { diffSnapshots } from './diff.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    monitorVersion: 'abc1234',
    sdkVersion: '^0.2.2',
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
          systemPromptTokensEstimated: { value: 25_000, unit: 'tokens', description: '' },
          toolCount: { value: 20, unit: 'tools', description: '' },
        },
      },
    },
    ...overrides,
  };
}

function diffOf(prior: MetricSnapshot, current: MetricSnapshot): DiffReport {
  return diffSnapshots(prior, current);
}

// ---------------------------------------------------------------------------
// buildDriftMagnitude
// ---------------------------------------------------------------------------

describe('buildDriftMagnitude — system prompt delta', () => {
  it('returns 0 when system prompt is unchanged', () => {
    const snap = makeSnapshot();
    const mag = buildDriftMagnitude(diffOf(snap, snap));
    expect(mag.systemPromptDeltaPct).toBe(0);
  });

  it('computes correct pct for a 10% growth', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 110_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 27_500, unit: 'tokens', description: '' },
            toolCount: { value: 20, unit: 'tools', description: '' },
          },
        },
      },
    });
    const mag = buildDriftMagnitude(diffOf(prior, current));
    expect(mag.systemPromptDeltaPct).toBeCloseTo(10, 5);
  });

  it('treats a shrink as a positive delta (abs value)', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 95_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 23_750, unit: 'tokens', description: '' },
            toolCount: { value: 20, unit: 'tools', description: '' },
          },
        },
      },
    });
    const mag = buildDriftMagnitude(diffOf(prior, current));
    expect(mag.systemPromptDeltaPct).toBeCloseTo(5, 5);
  });

  it('returns 0 when systemPromptChars is missing from both experiments', () => {
    const snap = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            toolCount: { value: 20, unit: 'tools', description: '' },
          },
        },
      },
    });
    const mag = buildDriftMagnitude(diffOf(snap, snap));
    expect(mag.systemPromptDeltaPct).toBe(0);
  });
});

describe('buildDriftMagnitude — tool count delta', () => {
  it('returns 0 when tool count is unchanged', () => {
    const snap = makeSnapshot();
    const mag = buildDriftMagnitude(diffOf(snap, snap));
    expect(mag.toolCountDelta).toBe(0);
  });

  it('returns positive delta when tools are added', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 100_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 25_000, unit: 'tokens', description: '' },
            toolCount: { value: 23, unit: 'tools', description: '' },
          },
        },
      },
    });
    const mag = buildDriftMagnitude(diffOf(prior, current));
    expect(mag.toolCountDelta).toBe(3);
  });

  it('returns negative delta when tools are removed', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 100_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 25_000, unit: 'tokens', description: '' },
            toolCount: { value: 18, unit: 'tools', description: '' },
          },
        },
      },
    });
    const mag = buildDriftMagnitude(diffOf(prior, current));
    expect(mag.toolCountDelta).toBe(-2);
  });
});

describe('buildDriftMagnitude — probe refusal delta', () => {
  it('returns 0 when no injectionRefusedRate metric present', () => {
    const snap = makeSnapshot();
    const mag = buildDriftMagnitude(diffOf(snap, snap));
    expect(mag.probeRefusalDeltaPp).toBe(0);
  });

  it('returns 0 when rate is unchanged', () => {
    const snap = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 100_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 25_000, unit: 'tokens', description: '' },
            toolCount: { value: 20, unit: 'tools', description: '' },
            injectionRefusedRate: { value: 0.9, unit: 'ratio', description: '' },
          },
        },
      },
    });
    const mag = buildDriftMagnitude(diffOf(snap, snap));
    expect(mag.probeRefusalDeltaPp).toBe(0);
  });

  it('computes drop in pp correctly (10 pp drop)', () => {
    const baseExperiments = {
      'context-tax': {
        name: 'context-tax',
        description: 'test',
        metrics: {
          systemPromptChars: { value: 100_000, unit: 'chars', description: '' },
          systemPromptTokensEstimated: { value: 25_000, unit: 'tokens', description: '' },
          toolCount: { value: 20, unit: 'tools', description: '' },
          injectionRefusedRate: { value: 1.0, unit: 'ratio', description: '' },
        },
      },
    };
    const prior = makeSnapshot({ experiments: baseExperiments });
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          ...baseExperiments['context-tax'],
          metrics: {
            ...baseExperiments['context-tax'].metrics,
            injectionRefusedRate: { value: 0.9, unit: 'ratio', description: '' },
          },
        },
      },
    });
    const mag = buildDriftMagnitude(diffOf(prior, current));
    expect(mag.probeRefusalDeltaPp).toBeCloseTo(10, 5);
  });

  it('clamps to 0 when rate improves (never negative)', () => {
    const baseExperiments = {
      'context-tax': {
        name: 'context-tax',
        description: 'test',
        metrics: {
          systemPromptChars: { value: 100_000, unit: 'chars', description: '' },
          systemPromptTokensEstimated: { value: 25_000, unit: 'tokens', description: '' },
          toolCount: { value: 20, unit: 'tools', description: '' },
          injectionRefusedRate: { value: 0.8, unit: 'ratio', description: '' },
        },
      },
    };
    const prior = makeSnapshot({ experiments: baseExperiments });
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          ...baseExperiments['context-tax'],
          metrics: {
            ...baseExperiments['context-tax'].metrics,
            injectionRefusedRate: { value: 1.0, unit: 'ratio', description: '' },
          },
        },
      },
    });
    const mag = buildDriftMagnitude(diffOf(prior, current));
    expect(mag.probeRefusalDeltaPp).toBe(0);
  });
});

describe('buildDriftMagnitude — section changes', () => {
  it('returns false when no promptSections present', () => {
    const snap = makeSnapshot();
    const mag = buildDriftMagnitude(diffOf(snap, snap));
    expect(mag.hasSectionChanges).toBe(false);
  });

  it('returns false when sections are identical', () => {
    const snap = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 }],
    });
    const mag = buildDriftMagnitude(diffOf(snap, snap));
    expect(mag.hasSectionChanges).toBe(false);
  });

  it('returns true when a section grew', () => {
    const prior = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 }],
    });
    const current = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 11_000, tokenEstimate: 2_750 }],
    });
    const mag = buildDriftMagnitude(diffOf(prior, current));
    expect(mag.hasSectionChanges).toBe(true);
  });

  it('returns true when a section was added', () => {
    const prior = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 }],
    });
    const current = makeSnapshot({
      promptSections: [
        { name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 },
        { name: 'Safety', charCount: 2_000, tokenEstimate: 500 },
      ],
    });
    const mag = buildDriftMagnitude(diffOf(prior, current));
    expect(mag.hasSectionChanges).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyDigestTier
// ---------------------------------------------------------------------------

describe('classifyDigestTier — STABLE', () => {
  it('returns stable when all signals are zero', () => {
    const mag = {
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: false,
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('stable');
  });
});

describe('classifyDigestTier — CHANGE', () => {
  it('returns change when systemPrompt delta is above 0 but below threshold', () => {
    const mag = {
      systemPromptDeltaPct: 2,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true, // systemPromptDeltaPct > 0 → hasAnyDrift always true
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('change');
  });

  it('returns change when only hasSectionChanges is true', () => {
    const mag = {
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: true,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('change');
  });

  it('returns change when hasAnyDrift is true (e.g., hook body changed) with all-zero numeric signals', () => {
    const mag = {
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('change');
  });

  it('returns change when probe drop is below threshold', () => {
    const mag = {
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 3,
      hasSectionChanges: false,
      hasAnyDrift: true, // probeRefusalDeltaPp > 0 → hasAnyDrift always true
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('change');
  });
});

describe('classifyDigestTier — ALERT', () => {
  it('returns alert when systemPromptDeltaPct >= threshold (exactly 5)', () => {
    const mag = {
      systemPromptDeltaPct: 5,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('alert');
  });

  it('returns alert when systemPromptDeltaPct is above threshold (8%)', () => {
    const mag = {
      systemPromptDeltaPct: 8,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('alert');
  });

  it('returns alert when toolCountDelta is non-zero (added tools)', () => {
    const mag = {
      systemPromptDeltaPct: 0,
      toolCountDelta: 1,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('alert');
  });

  it('returns alert when toolCountDelta is non-zero (removed tools)', () => {
    const mag = {
      systemPromptDeltaPct: 0,
      toolCountDelta: -3,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('alert');
  });

  it('returns alert when probeRefusalDeltaPp >= threshold (exactly 5 pp)', () => {
    const mag = {
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 5,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('alert');
  });

  it('returns alert when probeRefusalDeltaPp is above threshold (10 pp)', () => {
    const mag = {
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 10,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('alert');
  });
});

describe('classifyDigestTier — boundary values', () => {
  it('returns change when systemPromptDeltaPct is just below threshold (4.99)', () => {
    const mag = {
      systemPromptDeltaPct: 4.99,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('change');
  });

  it('returns alert when systemPromptDeltaPct is exactly at threshold (5.0)', () => {
    const mag = {
      systemPromptDeltaPct: 5.0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('alert');
  });

  it('returns change when probeRefusalDeltaPp is just below threshold (4.99 pp)', () => {
    const mag = {
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 4.99,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('change');
  });

  it('returns alert when probeRefusalDeltaPp is exactly at threshold (5.0 pp)', () => {
    const mag = {
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 5.0,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    expect(classifyDigestTier(mag)).toBe('alert');
  });
});

describe('classifyDigestTier — custom thresholds', () => {
  it('uses custom alertSystemPromptDeltaPct', () => {
    const mag = {
      systemPromptDeltaPct: 3,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    // Default threshold is 5 → change; with threshold 2 → alert
    expect(classifyDigestTier(mag)).toBe('change');
    expect(classifyDigestTier(mag, { alertSystemPromptDeltaPct: 2 })).toBe('alert');
  });

  it('uses custom alertProbeRefusalDeltaPp', () => {
    const mag = {
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 3,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    // Default threshold is 5 → change; with threshold 2 → alert
    expect(classifyDigestTier(mag)).toBe('change');
    expect(classifyDigestTier(mag, { alertProbeRefusalDeltaPp: 2 })).toBe('alert');
  });

  it('falls back to defaults when config is undefined (missing digestTier key)', () => {
    const mag = {
      systemPromptDeltaPct: 5,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    // undefined = "digestTier key absent from config" — should still alert at default threshold
    expect(classifyDigestTier(mag, undefined)).toBe('alert');
  });

  it('falls back to defaults for partial config (only one threshold overridden)', () => {
    const mag = {
      systemPromptDeltaPct: 5,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 0,
    };
    // Partial config: only override probeRefusalDeltaPp; systemPromptDeltaPct uses default (5)
    expect(classifyDigestTier(mag, { alertProbeRefusalDeltaPp: 10 })).toBe('alert');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_TIER_THRESHOLDS sanity
// ---------------------------------------------------------------------------

describe('DEFAULT_TIER_THRESHOLDS', () => {
  it('has alertSystemPromptDeltaPct = 5', () => {
    expect(DEFAULT_TIER_THRESHOLDS.alertSystemPromptDeltaPct).toBe(5);
  });

  it('has alertProbeRefusalDeltaPp = 5', () => {
    expect(DEFAULT_TIER_THRESHOLDS.alertProbeRefusalDeltaPp).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// buildDigestMessage — tier integration
// ---------------------------------------------------------------------------

describe('buildDigestMessage — tier output', () => {
  it('returns tier=null when prior is null (first capture)', () => {
    const snap = makeSnapshot();
    const { tier } = buildDigestMessage(snap, null, '2026-07-07');
    expect(tier).toBeNull();
  });

  it('returns tier=stable when snapshots are identical', () => {
    const snap = makeSnapshot();
    const { tier } = buildDigestMessage(snap, snap, '2026-07-07');
    expect(tier).toBe('stable');
  });

  it('produces single-line stable message (no verbosity)', () => {
    const snap = makeSnapshot();
    const { message } = buildDigestMessage(snap, snap, '2026-07-07');
    expect(message).toMatch(/✅ Stable — no significant changes detected \(2026-07-07\)/);
    expect(message).not.toContain('• Tools:');
    expect(message).not.toContain('Weekly Digest');
  });

  it('returns tier=change when small system-prompt delta is present', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 102_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 25_500, unit: 'tokens', description: '' },
            toolCount: { value: 20, unit: 'tools', description: '' },
          },
        },
      },
    });
    const { tier, message } = buildDigestMessage(current, prior, '2026-07-07');
    expect(tier).toBe('change');
    // CHANGE keeps standard header
    expect(message).toContain('📊 **CLI Wrapper Monitor — Weekly Digest**');
    expect(message).not.toContain('🚨');
  });

  it('returns tier=alert when system prompt grows ≥5% and includes 🚨 header', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 110_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 27_500, unit: 'tokens', description: '' },
            toolCount: { value: 20, unit: 'tools', description: '' },
          },
        },
      },
    });
    const { tier, message } = buildDigestMessage(current, prior, '2026-07-07');
    expect(tier).toBe('alert');
    expect(message).toContain('🚨 **ALERT');
    expect(message).not.toContain('📊 **CLI Wrapper Monitor — Weekly Digest** (2026-07-07)');
  });

  it('returns tier=alert when tool count changes and includes 🚨 header', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 100_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 25_000, unit: 'tokens', description: '' },
            toolCount: { value: 22, unit: 'tools', description: '' },
          },
        },
      },
    });
    const { tier, message } = buildDigestMessage(current, prior, '2026-07-07');
    expect(tier).toBe('alert');
    expect(message).toContain('🚨');
  });

  it('ALERT digest includes probe breakdown when injectionRefusedRate is present', () => {
    const baseExperiments = {
      'context-tax': {
        name: 'context-tax',
        description: 'test',
        metrics: {
          systemPromptChars: { value: 100_000, unit: 'chars', description: '' },
          systemPromptTokensEstimated: { value: 25_000, unit: 'tokens', description: '' },
          toolCount: { value: 22, unit: 'tools', description: '' }, // tool count change → alert
          injectionRefusedRate: { value: 1.0, unit: 'ratio', description: '' },
        },
      },
    };
    const prior = makeSnapshot({ experiments: baseExperiments });
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          ...baseExperiments['context-tax'],
          metrics: {
            ...baseExperiments['context-tax'].metrics,
            toolCount: { value: 22, unit: 'tools', description: '' },
            injectionRefusedRate: { value: 0.85, unit: 'ratio', description: '' },
          },
        },
      },
    });
    const { tier, message } = buildDigestMessage(current, prior, '2026-07-07');
    expect(tier).toBe('alert');
    expect(message).toContain('Probe breakdown');
    expect(message).toContain('injectionRefusedRate');
  });

  it('CHANGE digest does NOT include probe breakdown', () => {
    // small section change only → change tier
    const prior = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 10_000, tokenEstimate: 2_500 }],
    });
    const current = makeSnapshot({
      promptSections: [{ name: 'Tools', charCount: 10_100, tokenEstimate: 2_525 }],
    });
    const { tier, message } = buildDigestMessage(current, prior, '2026-07-07');
    expect(tier).toBe('change');
    expect(message).not.toContain('Probe breakdown');
  });

  it('custom tier config with low threshold makes small drift an alert', () => {
    const prior = makeSnapshot();
    const current = makeSnapshot({
      experiments: {
        'context-tax': {
          name: 'context-tax',
          description: 'test',
          metrics: {
            systemPromptChars: { value: 101_000, unit: 'chars', description: '' },
            systemPromptTokensEstimated: { value: 25_250, unit: 'tokens', description: '' },
            toolCount: { value: 20, unit: 'tools', description: '' },
          },
        },
      },
    });
    // With default threshold (5%) → change; with threshold 0.5% → alert
    const { tier: tier1 } = buildDigestMessage(current, prior, '2026-07-07');
    expect(tier1).toBe('change');

    const { tier: tier2 } = buildDigestMessage(current, prior, '2026-07-07', {
      alertSystemPromptDeltaPct: 0.5,
    });
    expect(tier2).toBe('alert');
  });
});

// ---------------------------------------------------------------------------
// buildDriftMagnitude — toolSurfaceChanges
// ---------------------------------------------------------------------------

describe('buildDriftMagnitude — toolSurfaceChanges', () => {
  it('returns 0 when both snapshots have identical toolNames', () => {
    const snap = makeSnapshot({ toolNames: ['tool-a', 'tool-b', 'tool-c'] });
    const mag = buildDriftMagnitude(diffOf(snap, snap));
    expect(mag.toolSurfaceChanges).toBe(0);
  });

  it('counts added tools when a new tool appears', () => {
    const prior = makeSnapshot({ toolNames: ['tool-a', 'tool-b'] });
    const current = makeSnapshot({ toolNames: ['tool-a', 'tool-b', 'tool-c'] });
    const mag = buildDriftMagnitude(diffOf(prior, current));
    expect(mag.toolSurfaceChanges).toBe(1);
  });

  it('counts removed tools when a tool disappears', () => {
    const prior = makeSnapshot({ toolNames: ['tool-a', 'tool-b', 'tool-c'] });
    const current = makeSnapshot({ toolNames: ['tool-a', 'tool-b'] });
    const mag = buildDriftMagnitude(diffOf(prior, current));
    expect(mag.toolSurfaceChanges).toBe(1);
  });

  it('counts both adds and removes for a swap (count unchanged)', () => {
    const prior = makeSnapshot({ toolNames: ['tool-a', 'tool-b'] });
    const current = makeSnapshot({ toolNames: ['tool-a', 'tool-c'] }); // b removed, c added
    const mag = buildDriftMagnitude(diffOf(prior, current));
    expect(mag.toolSurfaceChanges).toBe(2);
  });

  it('returns 0 when neither snapshot has toolNames or toolSchemas', () => {
    const snap = makeSnapshot(); // no toolNames, no toolSchemas
    const mag = buildDriftMagnitude(diffOf(snap, snap));
    expect(mag.toolSurfaceChanges).toBe(0);
  });

  it('falls back to toolSchemas keys when toolNames absent', () => {
    const prior = makeSnapshot({
      toolSchemas: { 'tool-a': { parameterCount: 0, requiredParams: [], optionalParams: [], descriptionHash: 'x' } },
    });
    const current = makeSnapshot({
      toolSchemas: {
        'tool-a': { parameterCount: 0, requiredParams: [], optionalParams: [], descriptionHash: 'x' },
        'tool-b': { parameterCount: 0, requiredParams: [], optionalParams: [], descriptionHash: 'y' },
      },
    });
    const mag = buildDriftMagnitude(diffOf(prior, current));
    expect(mag.toolSurfaceChanges).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// classifyDigestTier — toolSurfaceChanges thresholds
// ---------------------------------------------------------------------------

describe('classifyDigestTier — toolSurfaceChanges', () => {
  it('returns stable when toolSurfaceChanges is 0 and no other drift', () => {
    const tier = classifyDigestTier({
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: false,
      toolSurfaceChanges: 0,
    });
    expect(tier).toBe('stable');
  });

  it('returns change when toolSurfaceChanges is 1', () => {
    const tier = classifyDigestTier({
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true, // 1 tool change → hasAnyDrift
      toolSurfaceChanges: 1,
    });
    expect(tier).toBe('change');
  });

  it('returns alert when toolSurfaceChanges is 2 (swap scenario)', () => {
    const tier = classifyDigestTier({
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 2,
    });
    expect(tier).toBe('alert');
  });

  it('returns alert when toolSurfaceChanges >= 2 (more than 2 changes)', () => {
    const tier = classifyDigestTier({
      systemPromptDeltaPct: 0,
      toolCountDelta: 0,
      probeRefusalDeltaPp: 0,
      hasSectionChanges: false,
      hasAnyDrift: true,
      toolSurfaceChanges: 3,
    });
    expect(tier).toBe('alert');
  });
});
