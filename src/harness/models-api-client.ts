/**
 * Minimal client for the GitHub Models API (OpenAI-compatible).
 *
 * Endpoint: https://models.inference.ai.azure.com
 * Auth:     Bearer ${GITHUB_TOKEN}
 *
 * No external dependencies — uses the global `fetch` available in Node ≥ 18.
 *
 * Rate limits and model availability depend on your GitHub plan.
 * See: https://docs.github.com/en/github-models
 */

export const MODELS_API_BASE =
  'https://models.inference.ai.azure.com';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResult {
  content: string;
  usage: ChatUsage;
  model: string;
  /** Raw response body for debugging */
  raw?: unknown;
}

export interface ModelsApiConfig {
  /** GitHub personal access token with `models:read` scope. Defaults to `GITHUB_TOKEN` env var. */
  token?: string;
  /** Model to use. Defaults to `gpt-4o-mini` (cheap, widely available). */
  model?: string;
  /** Base URL override, e.g. for testing against a mock. */
  baseUrl?: string;
  /** Timeout in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
}

interface RawCompletionResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model?: string;
}

export class ModelsApiClient {
  private readonly token: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ModelsApiConfig = {}) {
    const token =
      config.token ??
      process.env['GITHUB_TOKEN'] ??
      process.env['GITHUB_API_TOKEN'];
    if (!token) {
      throw new Error(
        'ModelsApiClient: no token provided. ' +
          'Set GITHUB_TOKEN environment variable or pass config.token.',
      );
    }
    this.token = token;
    this.model = config.model ?? 'gpt-4o-mini';
    this.baseUrl = config.baseUrl ?? MODELS_API_BASE;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  /**
   * Send a chat completion request and return the response + usage.
   *
   * @param messages  Chat messages to send.
   * @param maxTokens Optional max response tokens (defaults to 512).
   */
  async chat(
    messages: ChatMessage[],
    maxTokens = 512,
  ): Promise<ChatCompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      throw new Error(
        `Models API error ${response.status} ${response.statusText}: ${body}`,
      );
    }

    const raw = (await response.json()) as RawCompletionResponse;

    const content = raw.choices[0]?.message.content ?? '';
    const usage = raw.usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    return {
      content,
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      },
      model: raw.model ?? this.model,
      raw,
    };
  }

  /** Quick liveness check — send a minimal message and return true if it succeeds. */
  async ping(): Promise<boolean> {
    try {
      await this.chat([{ role: 'user', content: 'Hi' }], 4);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Return true if a GitHub token is available in the environment.
 * Used by experiments to decide whether to run in live or static mode.
 */
export function hasGitHubToken(): boolean {
  return Boolean(
    process.env['GITHUB_TOKEN'] ?? process.env['GITHUB_API_TOKEN'],
  );
}
