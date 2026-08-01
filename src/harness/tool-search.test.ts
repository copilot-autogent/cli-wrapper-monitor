import { describe, expect, it } from 'vitest';
import { captureToolSearchSnapshot, diffToolSearch, TOOL_SEARCH_TOOL_NAME } from './tool-search.js';
import { diffSnapshots, formatDiffReport } from './diff.js';
import type { MetricSnapshot } from './types.js';

const fixture = {
  tools: [
    { name: 'search_code', deferLoading: true },
    { name: 'read_file' },
    { name: TOOL_SEARCH_TOOL_NAME },
  ],
  toolReferences: [
    { type: 'tool_reference', tool_name: 'search_code' },
    'read_file',
    { type: 'tool_reference', tool_name: 'search_code' },
  ],
} as const;

describe('deferred tool-search baseline fixture', () => {
  it('captures enablement, deferred tools, and references deterministically', () => {
    expect(captureToolSearchSnapshot(fixture)).toEqual({
      enabled: true,
      deferredToolNames: ['search_code'],
      toolReferences: ['read_file', 'search_code'],
    });
  });

  it('does not report ordering-only changes', () => {
    const baseline = captureToolSearchSnapshot(fixture);
    const current = captureToolSearchSnapshot({
      ...fixture,
      tools: [...fixture.tools].reverse(),
      toolReferences: [...fixture.toolReferences].reverse(),
    });
    expect(diffToolSearch(baseline, current)).toEqual([]);
  });

  it('classifies a hidden tool and dropped references as regressions', () => {
    const baseline = captureToolSearchSnapshot({
      ...fixture,
      tools: fixture.tools.map((tool) =>
        tool.name === 'search_code' ? { name: tool.name } : tool,
      ),
    });
    const current = captureToolSearchSnapshot({
      enabled: true,
      tools: [
        { name: 'search_code', deferLoading: true },
        { name: 'read_file' },
        { name: TOOL_SEARCH_TOOL_NAME },
      ],
      toolReferences: [],
    });
    expect(diffToolSearch(baseline, current)).toEqual([
      { type: 'tool_deferred', toolName: 'search_code' },
      { type: 'reference_removed', reference: 'read_file' },
      { type: 'reference_removed', reference: 'search_code' },
    ]);
  });

  it('reads old snapshots without deferred-tool fields', () => {
    expect(diffToolSearch(undefined, captureToolSearchSnapshot(fixture))).toEqual([]);
  });

  it('detects loss of deferred-tool capture after instrumentation was enabled', () => {
    expect(
      diffToolSearch(captureToolSearchSnapshot(fixture), undefined, false),
    ).toEqual([{ type: 'capture_unavailable' }]);
  });

  it('trims and drops empty string references', () => {
    expect(
      captureToolSearchSnapshot({
        tools: [],
        toolReferences: [
          ' search_code ',
          ' ',
          { type: 'tool_reference', tool_name: ' read_file ' },
          null,
          42,
        ],
      }).toolReferences,
    ).toEqual(['read_file', 'search_code']);
  });

  it('classifies hidden-tool and dropped-reference changes in the full report', () => {
    const before = captureToolSearchSnapshot({
      ...fixture,
      tools: fixture.tools.map((tool) =>
        tool.name === 'search_code' ? { name: tool.name } : tool,
      ),
    });
    const after = captureToolSearchSnapshot({
      ...fixture,
      toolReferences: [],
    });
    const snapshot = (toolSearch: MetricSnapshot['toolSearch']): MetricSnapshot => ({
      capturedAt: '2026-01-01T00:00:00.000Z',
      monitorVersion: 'test',
      sdkVersion: 'test',
      model: 'test',
      experiments: {},
      toolSearch,
    });
    const report = diffSnapshots(snapshot(before), snapshot(after));
    expect(report.hasBreaking).toBe(true);
    expect(report.structuralBreaks).toEqual([
      'Tool became deferred: `search_code`',
      'Tool reference disappeared: `read_file`',
      'Tool reference disappeared: `search_code`',
    ]);
    expect(formatDiffReport(report)).toContain('Deferred Tool Search Changes');
    expect(formatDiffReport(report)).toContain('Tool reference removed');
  });
});
