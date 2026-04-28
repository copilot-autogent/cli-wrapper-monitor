import type { Experiment, ExperimentResult } from '../harness/types.js';

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
}

/**
 * Measures the token overhead imposed by the CLI wrapper layer before any
 * user content is processed.
 *
 * **Static analysis mode** (this implementation): estimates tokens from
 * character counts. No SDK connection required.
 *
 * **Live mode** (sprint 2): will connect to the Copilot SDK, send a minimal
 * probe message, and record actual token usage from the API response metadata.
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
    const systemPromptTokens = estimateTokens(systemPrompt);

    // Serialize tool definitions as they would appear in an API request
    const toolDefsJson = JSON.stringify(tools, null, 2);
    const toolDefsChars = toolDefsJson.length;
    const toolDefsTokens = estimateTokens(toolDefsJson);

    // Per-tool breakdown
    const perToolChars = tools.map((t) => JSON.stringify(t).length);
    const avgToolChars =
      tools.length > 0
        ? Math.round(perToolChars.reduce((a, b) => a + b, 0) / tools.length)
        : 0;

    return {
      name: this.name,
      description: this.description,
      metrics: {
        systemPromptChars: {
          value: systemPromptChars,
          unit: 'chars',
          description: 'System prompt length in characters',
        },
        systemPromptTokensEstimated: {
          value: systemPromptTokens,
          unit: 'tokens',
          description: 'Estimated token count of system prompt (÷4 heuristic)',
        },
        toolDefinitionsChars: {
          value: toolDefsChars,
          unit: 'chars',
          description: 'Combined length of all tool definitions serialized as JSON',
        },
        toolDefinitionsTokensEstimated: {
          value: toolDefsTokens,
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
          value: systemPromptTokens + toolDefsTokens,
          unit: 'tokens',
          description:
            'Total estimated token overhead from system prompt + tool definitions',
        },
      },
      rawData: {
        mode: 'static',
        note: 'Live mode (exact token counts via SDK) is a sprint 2 feature.',
        perToolChars: tools.map((t, i) => ({ name: t.name, chars: perToolChars[i] })),
      },
    };
  }
}
