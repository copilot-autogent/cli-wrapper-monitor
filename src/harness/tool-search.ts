import type { ToolSearchChange, ToolSearchSnapshot } from './types.js';

export const TOOL_SEARCH_TOOL_NAME = 'tool_search_tool_regex';

export interface ToolSearchToolInput {
  name: string;
  deferLoading?: boolean;
}

export interface ToolSearchCaptureInput {
  enabled?: boolean;
  tools: ReadonlyArray<ToolSearchToolInput>;
  toolReferences?: ReadonlyArray<string | { tool_name?: string }>;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Normalize SDK metadata and tool-search results into deterministic baseline data.
 * References may be strings or the SDK's `{ type: "tool_reference", tool_name }`
 * content-block shape; malformed blocks are ignored rather than persisted.
 */
export function captureToolSearchSnapshot(input: ToolSearchCaptureInput): ToolSearchSnapshot {
  const enabled =
    input.enabled ??
    input.tools.some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME);
  const deferredToolNames = sortedUnique(
    input.tools
      .filter((tool) => tool.deferLoading === true && tool.name !== TOOL_SEARCH_TOOL_NAME)
      .map((tool) => tool.name),
  );
  const toolReferences = sortedUnique(
    (input.toolReferences ?? []).flatMap((reference) =>
      typeof reference === 'string'
        ? [reference.trim()].filter(Boolean)
        : typeof reference.tool_name === 'string'
          ? [reference.tool_name.trim()].filter(Boolean)
          : [],
    ),
  );
  return { enabled, deferredToolNames, toolReferences };
}

export function diffToolSearch(
  baseline: ToolSearchSnapshot | undefined,
  current: ToolSearchSnapshot | undefined,
): ToolSearchChange[] {
  if (!baseline) return [];
  if (!current) return [{ type: 'capture_disappeared' }];
  const changes: ToolSearchChange[] = [];

  if (baseline.enabled !== current.enabled) {
    changes.push({ type: 'enabled_changed', before: baseline.enabled, after: current.enabled });
  }
  const beforeDeferred = new Set(baseline.deferredToolNames);
  const afterDeferred = new Set(current.deferredToolNames);
  for (const toolName of current.deferredToolNames) {
    if (!beforeDeferred.has(toolName)) changes.push({ type: 'tool_deferred', toolName });
  }
  for (const toolName of baseline.deferredToolNames) {
    if (!afterDeferred.has(toolName)) changes.push({ type: 'tool_undeferred', toolName });
  }

  const beforeReferences = new Set(baseline.toolReferences);
  const afterReferences = new Set(current.toolReferences);
  if (baseline.toolReferences.length > 0 && current.toolReferences.length === 0) {
    changes.push({ type: 'references_disappeared' });
  } else {
    for (const reference of current.toolReferences) {
      if (!beforeReferences.has(reference)) changes.push({ type: 'reference_added', reference });
    }
    for (const reference of baseline.toolReferences) {
      if (!afterReferences.has(reference)) changes.push({ type: 'reference_removed', reference });
    }
  }
  return changes;
}
