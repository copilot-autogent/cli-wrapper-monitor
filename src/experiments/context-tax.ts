import type { Experiment, ExperimentResult } from '../harness/types.js';
import { ModelsApiClient, hasGitHubToken } from '../harness/models-api-client.js';

/**
 * Rough token estimate: 1 token ≈ 4 characters.
 * Appropriate for English prose and JSON; accuracy ±20%.
 */
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN);
}

export interface ToolDefinitionInput {
  name: string;
  description: string;
  parameters?: unknown;
}

export interface ContextTaxConfig {
  /** Raw system prompt text. If omitted, metrics will be zero. */
  systemPrompt?: string;
  /** Tool definitions to measure. If omitted, tool metrics will be zero. */
  toolDefinitions?: ToolDefinitionInput[];
  /**
   * When true, make a live API call to get exact token counts.
   * Requires GITHUB_TOKEN in environment. Falls back to static mode on error.
   */
  liveMode?: boolean;
  /** Model to use for live token counting. Defaults to 'gpt-4o-mini'. */
  model?: string;
}

/**
 * Measures the token overhead imposed by the CLI wrapper layer before any
 * user content is processed.
 *
 * **Static mode**: estimates tokens from character counts (÷4 heuristic).
 * No network access required.
 *
 * **Live mode**: sends the system prompt + tool defs to the GitHub Models API
 * as a real system message, records actual `prompt_tokens` from the response,
 * and computes estimation error vs the static heuristic.
 * Set `liveMode: true` and provide `GITHUB_TOKEN` in the environment.
 */
export class ContextTaxExperiment implements Experiment {
  readonly name = 'context-tax';
  readonly description =
    'Measures character/token overhead of CLI wrapper layer components';

  constructor(private readonly config: ContextTaxConfig = {}) {}

  async run(): Promise<ExperimentResult> {
    const systemPrompt = this.config.systemPrompt ?? '';
    const tools = this.config.toolDefinitions ?? [];

    const systemPromptChars = systemPrompt.length;
    const systemPromptTokensEstimated = estimateTokens(systemPrompt);

    // Serialize tool definitions as they would appear in an API request
    const toolDefsJson = JSON.stringify(tools, null, 2);
    const toolDefsChars = toolDefsJson.length;
    const toolDefsTokensEstimated = estimateTokens(toolDefsJson);

    // Per-tool breakdown
    const perToolChars = tools.map((t) => JSON.stringify(t).length);
    const avgToolChars =
      tools.length > 0
        ? Math.round(perToolChars.reduce((a, b) => a + b, 0) / tools.length)
        : 0;

    const staticMetrics = {
      systemPromptChars: {
        value: systemPromptChars,
        unit: 'chars',
        description: 'System prompt length in characters',
      },
      systemPromptTokensEstimated: {
        value: systemPromptTokensEstimated,
        unit: 'tokens',
        description: 'Estimated token count of system prompt (÷4 heuristic)',
      },
      toolDefinitionsChars: {
        value: toolDefsChars,
        unit: 'chars',
        description: 'Combined length of all tool definitions serialized as JSON',
      },
      toolDefinitionsTokensEstimated: {
        value: toolDefsTokensEstimated,
        unit: 'tokens',
        description: 'Estimated token count of tool definitions (÷4 heuristic)',
      },
      toolCount: {
        value: tools.length,
        unit: 'tools',
        description: 'Number of registered tool definitions',
      },
      avgCharsPerTool: {
        value: avgToolChars,
        unit: 'chars',
        description: 'Average characters per tool definition',
      },
      totalOverheadChars: {
        value: systemPromptChars + toolDefsChars,
        unit: 'chars',
        description: 'Total wrapper overhead in characters',
      },
      totalOverheadTokensEstimated: {
        value: systemPromptTokensEstimated + toolDefsTokensEstimated,
        unit: 'tokens',
        description:
          'Total estimated token overhead from system prompt + tool definitions',
      },
    };

    const useLiveMode =
      (this.config.liveMode ?? false) && hasGitHubToken();

    if (!useLiveMode) {
      return {
        name: this.name,
        description: this.description,
        metrics: staticMetrics,
        rawData: {
          mode: 'static',
          liveAvailable: hasGitHubToken(),
          note: hasGitHubToken()
            ? 'Pass liveMode: true to enable exact token counts.'
            : 'Set GITHUB_TOKEN and pass liveMode: true to enable exact token counts.',
          perToolChars: tools.map((t, i) => ({
            name: t.name,
            chars: perToolChars[i],
          })),
        },
      };
    }

    // --- Live mode: send system prompt + tools as system message, probe with minimal user message ---
    let liveError: string | undefined;
    let systemPromptTokensActual: number | undefined;
    let totalOverheadTokensActual: number | undefined;
    let estimationErrorPct: number | undefined;

    try {
      const client = new ModelsApiClient({
        model: this.config.model ?? 'gpt-4o-mini',
      });

      // Build a combined "wrapper content" system message mirroring how the
      // Copilot CLI would send system prompt + tool schema to the model.
      const wrapperContent =
        systemPrompt + (tools.length > 0 ? '\n\n' + toolDefsJson : '');

      // Minimal probe user just enough to trigger a completion. 
      const result = await client.chat(
        [
          { role: 'system', content: wrapperContent },
          { role: 'user', content: '.' },
        ],
        4, // tiny max_tokens — we only care about prompt_tokens
      );

      // prompt_tokens covers: system message + user '.' probe
      // Subtract the probe itself (typically 1 token) to isolate wrapper cost.
      systemPromptTokensActual = Math.max(0, result.usage.promptTokens - 1);
      totalOverheadTokensActual = systemPromptTokensActual;

      const estimated = systemPromptTokensEstimated + toolDefsTokensEstimated;
      estimationErrorPct =
        estimated > 0
          ? Math.round(
              ((systemPromptTokensActual - estimated) / estimated) * 100,
            )
          : 0;
    } catch (err) {
      liveError = String(err);
    }

    const liveMetrics: Record<string, { value: number; unit: string; description: string }> =
      systemPromptTokensActual !== undefined
        ? {
            systemPromptTokensActual: {
              value: systemPromptTokensActual,
              unit: 'tokens',
              description: 'Actual token count of wrapper content (from API usage)',
            },
            totalOverheadTokensActual: {
              value: totalOverheadTokensActual!,
              unit: 'tokens',
              description: 'Actual total wrapper token overhead from API response',
            },
            estimationErrorPct: {
              value: estimationErrorPct!,
              unit: '%',
              description:
                'Static estimate error: (estimated - actual) / actual × 100',
            },
          }
        : {};

    return {
      name: this.name,
      description: this.description,
      metrics: { ...staticMetrics, ...liveMetrics },
      rawData: {
        mode: liveError ? 'static-fallback' : 'live',
        liveError,
        perToolChars: tools.map((t, i) => ({
          name: t.name,
          chars: perToolChars[i],
        })),
      },
    };
  }
}
