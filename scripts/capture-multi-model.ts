/**
 * Per-model behavioral comparison sweep.
 *
 * Runs ContextTaxExperiment + RefusalRateExperiment against a configurable
 * set of models and produces a comparison table + stored JSON artifact.
 *
 * Usage:
 *   npx tsx scripts/capture-multi-model.ts
 *
 * Environment variables:
 *   GITHUB_TOKEN        Required for live refusal probes (GitHub Models API)
 *   MODELS              Comma-separated model IDs (overrides defaults)
 *   SKIP_REFUSAL=true   Skip refusal-rate probes (context tax only)
 *   AUTOGENT_PATH       Path to autogent checkout (default: /app)
 *   WORKSPACE_PATH      Path to autogent workspace (default: ~/.autogent)
 *
 * Cost control:
 *   maxProbesPerCategory=3 × N models × 3 categories = 9N API calls.
 *   Default N=3 → 27 calls max.  N=5 → 45 calls max.
 *
 * Output:
 *   reports/multi-model-YYYY-MM-DDTHH-MM-SS.json   — machine-readable snapshot
 *   reports/multi-model-YYYY-MM-DDTHH-MM-SS.md     — human-readable report
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { ContextTaxExperiment } from '../src/experiments/context-tax.js';
import { RefusalRateExperiment } from '../src/experiments/refusal-rate.js';
import { hasGitHubToken } from '../src/harness/models-api-client.js';
import {
  formatComparisonTable,
  formatComparisonMarkdown,
} from '../src/harness/multi-model-comparison.js';
import type {
  ModelBehaviorEntry,
  ModelContextTax,
  MultiModelComparisonSnapshot,
} from '../src/harness/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '../reports');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default model selection: one representative from each major provider.
 * These are deliberately conservative defaults — use MODELS env to override.
 *
 * gpt-4o-mini      — cheapest GPT, widely available on GitHub Models
 * claude-haiku-4-5 — cheapest Claude on GitHub Models
 * gemini-1.5-flash — cheapest Gemini, available on GitHub Models
 */
const DEFAULT_MODELS = ['gpt-4o-mini', 'claude-haiku-4-5', 'gemini-1.5-flash'];

const AUTOGENT_PATH = process.env['AUTOGENT_PATH'] ?? '/app';
const SKIP_REFUSAL = process.env['SKIP_REFUSAL'] === 'true';

const WORKSPACE_PATH =
  process.env['WORKSPACE_PATH'] ??
  (existsSync('/home/autogent/.autogent')
    ? '/home/autogent/.autogent'
    : join(process.env['HOME'] ?? '~', '.autogent'));

// Parse comma-separated model list from env, falling back to defaults
const MODELS: string[] = process.env['MODELS']
  ? process.env['MODELS'].split(',').map((m) => m.trim()).filter(Boolean)
  : DEFAULT_MODELS;

// ---------------------------------------------------------------------------
// Extraction helpers (same logic as capture-autogent-baseline.ts)
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  parameters?: unknown;
}

function extractToolDefs(autogentPath: string): ToolDef[] {
  const tools: ToolDef[] = [];

  const distToolsDir = join(autogentPath, 'dist', 'tools', 'builtin');
  if (existsSync(distToolsDir)) {
    try {
      const files = readdirSync(distToolsDir).filter((f) => f.endsWith('.js'));
      for (const file of files) {
        const content = readFileSync(join(distToolsDir, file), 'utf-8');
        const nameMatch = content.match(/name:\s*["']([^"']+)["']/);
        const descMatch = content.match(/description:\s*["']([^"']+)["']/);
        if (nameMatch?.[1] && descMatch?.[1]) {
          tools.push({ name: nameMatch[1], description: descMatch[1] });
        }
      }
      if (tools.length > 0) return tools;
    } catch {
      // fall through to TypeScript source fallback
    }
  }

  const srcToolsDir = join(autogentPath, 'src', 'tools', 'builtin');
  if (existsSync(srcToolsDir)) {
    try {
      const files = readdirSync(srcToolsDir).filter((f) => f.endsWith('.ts'));
      for (const file of files) {
        if (file === 'index.ts' || file === 'edit-instructions.ts') continue;
        const content = readFileSync(join(srcToolsDir, file), 'utf-8');
        const nameMatch = content.match(/name:\s*["']([^"']+)["']/);
        const descMatch = content.match(/description:\s*["']([^"']+)["']/);
        if (nameMatch?.[1] && descMatch?.[1]) {
          tools.push({ name: nameMatch[1], description: descMatch[1] });
        }
      }
    } catch {
      // fall through
    }
  }

  return tools;
}

function extractSystemPrompt(autogentPath: string, workspacePath: string): string {
  const bootstrapFiles = ['SOUL.md', 'PLAYBOOK.md', 'CONTEXT.md', 'USER.md'];
  const parts: string[] = [];

  if (existsSync(workspacePath)) {
    for (const file of bootstrapFiles) {
      const filePath = join(workspacePath, file);
      if (existsSync(filePath)) {
        parts.push(readFileSync(filePath, 'utf-8'));
      }
    }
  }

  if (parts.length > 0) return parts.join('\n\n---\n\n');

  const candidates = [
    join(autogentPath, 'src', 'workspace', 'index.ts'),
    join(autogentPath, 'src', 'workspace', 'system-prompt.ts'),
    join(autogentPath, 'src', 'session.ts'),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const content = readFileSync(candidate, 'utf-8');
    // Fixed quantifiers: {200,}? means "at least 200, non-greedy"
    const templateMatch = content.match(/`(You are[\s\S]{200,}?)`/);
    if (templateMatch?.[1]) return templateMatch[1];
    const stringMatch = content.match(/"(You are[^"]{200,})"/);
    if (stringMatch?.[1]) return stringMatch[1];
  }

  return '';
}

// ---------------------------------------------------------------------------
// Context tax computation (model-invariant — hoisted out of per-model loop)
// ---------------------------------------------------------------------------

async function computeContextTax(
  systemPrompt: string,
  toolDefs: ToolDef[],
): Promise<ModelContextTax> {
  const experiment = new ContextTaxExperiment({
    systemPrompt,
    toolDefinitions: toolDefs,
    liveMode: false, // static mode — same result for every model
  });
  const result = await experiment.run();
  const m = result.metrics;
  return {
    systemPromptChars: m['systemPromptChars']?.value ?? 0,
    systemPromptTokensEstimated: m['systemPromptTokensEstimated']?.value ?? 0,
    toolDefinitionsChars: m['toolDefinitionsChars']?.value ?? 0,
    toolDefinitionsTokensEstimated: m['toolDefinitionsTokensEstimated']?.value ?? 0,
    toolCount: m['toolCount']?.value ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Per-model refusal sweep
// ---------------------------------------------------------------------------

async function runModelSweep(
  model: string,
  contextTax: ModelContextTax,
  skipRefusal: boolean,
): Promise<ModelBehaviorEntry> {
  console.log(`\n  → Model: ${model}`);

  if (skipRefusal || !hasGitHubToken()) {
    if (!skipRefusal && !hasGitHubToken()) {
      console.log(`    ⚠  Refusal skipped for ${model} — no GITHUB_TOKEN`);
    }
    return { model, contextTax, refusal: null };
  }

  const refusalExperiment = new RefusalRateExperiment({
    model,
    maxProbesPerCategory: 3, // cost cap: 3 × 3 categories = 9 calls per model
  });

  try {
    const refusalResult = await refusalExperiment.run();
    const m = refusalResult.metrics;
    const refusal = {
      safeAllowedRate: m['safeAllowedRate']?.value ?? 0,
      dangerousRefusedRate: m['dangerousRefusedRate']?.value ?? 0,
      borderlineRefusedRate: m['borderlineRefusedRate']?.value ?? 0,
      totalProbes: m['totalProbes']?.value ?? 0,
    };
    console.log(
      `    ✓ safe=${refusal.safeAllowedRate.toFixed(3)}` +
        ` dangerous=${refusal.dangerousRefusedRate.toFixed(3)}` +
        ` borderline=${refusal.borderlineRefusedRate.toFixed(3)}` +
        ` (${refusal.totalProbes} probes)`,
    );
    return { model, contextTax, refusal };
  } catch (err) {
    console.error(`    ✗ refusal-rate failed for ${model}: ${String(err)}`);
    return { model, contextTax, refusal: null, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('CLI Wrapper Monitor — Multi-Model Behavioral Comparison');
  console.log('========================================================\n');

  console.log(`Models to sweep: ${MODELS.join(', ')}`);
  console.log(
    `Refusal probes:  ${
      SKIP_REFUSAL
        ? 'skipped (SKIP_REFUSAL=true)'
        : hasGitHubToken()
          ? 'enabled (GITHUB_TOKEN detected)'
          : 'skipped (no GITHUB_TOKEN)'
    }`,
  );
  console.log('');

  // Extract wrapper content (same for all models)
  const systemPrompt = extractSystemPrompt(AUTOGENT_PATH, WORKSPACE_PATH);
  const toolDefs = extractToolDefs(AUTOGENT_PATH);
  console.log(`System prompt: ${systemPrompt.length} chars`);
  console.log(`Tool defs:     ${toolDefs.length} tools`);

  // Compute context tax once — model-invariant in static mode
  console.log('\nComputing context tax...');
  let contextTax: ModelContextTax;
  try {
    contextTax = await computeContextTax(systemPrompt, toolDefs);
    console.log(
      `  System prompt: ${contextTax.systemPromptChars.toLocaleString()} chars /` +
        ` ${contextTax.systemPromptTokensEstimated.toLocaleString()} tokens est.`,
    );
    console.log(
      `  Tool defs:     ${contextTax.toolDefinitionsChars.toLocaleString()} chars /` +
        ` ${contextTax.toolDefinitionsTokensEstimated.toLocaleString()} tokens est.`,
    );
    console.log(`  Tool count:    ${contextTax.toolCount}`);
  } catch (err) {
    console.error(`Context tax computation failed: ${String(err)}`);
    process.exit(1);
  }

  // Derive monitor version
  let monitorVersion = 'unknown';
  try {
    monitorVersion = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // not in a git repo
  }

  // Run refusal sweep per model
  console.log('\nRunning refusal sweep...');
  const entries: ModelBehaviorEntry[] = [];
  for (const model of MODELS) {
    const entry = await runModelSweep(model, contextTax, SKIP_REFUSAL);
    entries.push(entry);
  }

  const snapshot: MultiModelComparisonSnapshot = {
    capturedAt: new Date().toISOString(),
    monitorVersion,
    models: MODELS,
    entries,
  };

  // Persist results — timestamp includes time to avoid same-day overwrites
  mkdirSync(REPORTS_DIR, { recursive: true });
  const tsStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = join(REPORTS_DIR, `multi-model-${tsStr}.json`);
  const mdPath = join(REPORTS_DIR, `multi-model-${tsStr}.md`);

  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  writeFileSync(mdPath, formatComparisonMarkdown(snapshot), 'utf-8');

  console.log('\nResults saved:');
  console.log(`  JSON:     ${jsonPath}`);
  console.log(`  Markdown: ${mdPath}`);
  console.log('');

  // Print terminal summary
  console.log(formatComparisonTable(snapshot));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
