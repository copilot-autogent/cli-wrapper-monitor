/**
 * Capture a context-tax baseline using real autogent source data.
 *
 * Reads the system prompt template and tool definitions from a local
 * autogent checkout (defaults to /app) and runs the context-tax experiment
 * against them. This gives a real baseline reflecting the actual token
 * overhead of the CLI wrapper in production.
 *
 * When GITHUB_TOKEN is present the refusal-rate experiment also runs,
 * sending the standardized probe set to the GitHub Models API and recording
 * safeAllowedRate / dangerousRefusedRate / borderlineRefusedRate alongside
 * the context-tax metrics.
 *
 * Usage:
 *   npx tsx scripts/capture-autogent-baseline.ts
 *   AUTOGENT_PATH=/path/to/autogent npx tsx scripts/capture-autogent-baseline.ts
 *   LIVE_MODE=true GITHUB_TOKEN=<token> npx tsx scripts/capture-autogent-baseline.ts
 *   SKIP_REFUSAL=true npx tsx scripts/capture-autogent-baseline.ts
 *   SKIP_MODEL_POOL=true npx tsx scripts/capture-autogent-baseline.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CopilotClient } from '@github/copilot-sdk';
import { ExperimentRunner } from '../src/harness/runner.js';
import { SnapshotStore } from '../src/harness/snapshot.js';
import { diffSnapshots, formatDiffReport } from '../src/harness/diff.js';
import { computeSizeDelta, formatSizeDeltaTable } from '../src/harness/size-delta.js';
import { ContextTaxExperiment } from '../src/experiments/context-tax.js';
import { RefusalRateExperiment } from '../src/experiments/refusal-rate.js';
import { hasGitHubToken } from '../src/harness/models-api-client.js';
import type { ModelPool } from '../src/harness/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINES_DIR = join(__dirname, '../baselines');

const AUTOGENT_PATH = process.env['AUTOGENT_PATH'] ?? '/app';
const LIVE_MODE = process.env['LIVE_MODE'] === 'true';
const SKIP_REFUSAL = process.env['SKIP_REFUSAL'] === 'true';
const SKIP_MODEL_POOL = process.env['SKIP_MODEL_POOL'] === 'true';

// Workspace path: where the bootstrap files and memory live at runtime.
// Defaults to ~/.autogent on most systems, or /home/autogent/.autogent in Docker.
const WORKSPACE_PATH =
  process.env['WORKSPACE_PATH'] ??
  (existsSync('/home/autogent/.autogent')
    ? '/home/autogent/.autogent'
    : join(process.env['HOME'] ?? '~', '.autogent'));

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/** Compute a sha256 hex digest of any Buffer or string content. */
function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute a sha256 fingerprint of the monitored CLI binary.
 *
 * Candidates tried in order:
 *   1. dist/index.js  — compiled entry point (most representative single file)
 *   2. All *.js files in dist/ concatenated (broader coverage)
 *   3. src/session.ts — TypeScript source fallback when no dist exists
 *
 * Returns 'sha256:<hex>' or 'unknown' if no candidate is found.
 */
function computeBinaryHash(autogentPath: string): string {
  // Candidate 1: dist/index.js
  const distIndex = join(autogentPath, 'dist', 'index.js');
  if (existsSync(distIndex)) {
    return 'sha256:' + sha256(readFileSync(distIndex));
  }

  // Candidate 2: concatenation of all dist/*.js files
  const distDir = join(autogentPath, 'dist');
  if (existsSync(distDir)) {
    try {
      const jsFiles = readdirSync(distDir)
        .filter((f) => f.endsWith('.js'))
        .sort();
      if (jsFiles.length > 0) {
        const combined = jsFiles
          .map((f) => readFileSync(join(distDir, f)))
          .reduce((a, b) => Buffer.concat([a, b]));
        return 'sha256:' + sha256(combined);
      }
    } catch {
      // fall through
    }
  }

  // Candidate 3: TypeScript source fallback
  const srcSession = join(autogentPath, 'src', 'session.ts');
  if (existsSync(srcSession)) {
    return 'sha256:' + sha256(readFileSync(srcSession));
  }

  return 'unknown';
}

/**
 * Compute a sha256 fingerprint of the assembled system prompt string.
 * Returns 'sha256:<hex>' or 'unknown' if the prompt is empty.
 */
function computeSystemPromptHash(systemPrompt: string): string {
  if (!systemPrompt) return 'unknown';
  return 'sha256:' + sha256(systemPrompt);
}

interface ToolDef {
  name: string;
  description: string;
  parameters?: unknown;
}

/**
 * Attempt to extract tool definitions from the autogent dist build.
 * Looks for *.js files in dist/tools/builtin/ that export tool metadata.
 *
 * Falls back to parsing the TypeScript source with a simple regex when
 * the dist directory isn't available.
 */
function extractToolDefs(autogentPath: string): ToolDef[] {
  const tools: ToolDef[] = [];

  // Strategy 1: read from dist/tools/builtin/
  const distToolsDir = join(autogentPath, 'dist', 'tools', 'builtin');
  if (existsSync(distToolsDir)) {
    try {
      const files = readdirSync(distToolsDir).filter((f) => f.endsWith('.js'));
      for (const file of files) {
        const content = readFileSync(join(distToolsDir, file), 'utf-8');
        // Match exported `name` and `description` fields from ToolDefinition objects
        const nameMatch = content.match(/name:\s*["']([^"']+)["']/);
        const descMatch = content.match(/description:\s*["']([^"']+)["']/);
        if (nameMatch && descMatch) {
          tools.push({ name: nameMatch[1], description: descMatch[1] });
        }
      }
      if (tools.length > 0) {
        return tools;
      }
    } catch {
      // fall through to next strategy
    }
  }

  // Strategy 2: scan TypeScript source for tool name + description patterns
  const srcToolsDir = join(autogentPath, 'src', 'tools', 'builtin');
  if (existsSync(srcToolsDir)) {
    try {
      const files = readdirSync(srcToolsDir).filter((f) => f.endsWith('.ts'));
      for (const file of files) {
        if (file === 'index.ts' || file === 'edit-instructions.ts') continue;
        const content = readFileSync(join(srcToolsDir, file), 'utf-8');
        const nameMatch = content.match(/name:\s*["']([^"']+)["']/);
        const descMatch = content.match(/description:\s*["']([^"']+)["']/);
        if (nameMatch && descMatch) {
          tools.push({ name: nameMatch[1], description: descMatch[1] });
        }
      }
    } catch {
      // fall through
    }
  }

  return tools;
}

/**
 * Extract the assembled system prompt.
 *
 * Strategy 1: Concatenate bootstrap files from the workspace directory
 * (SOUL.md, PLAYBOOK.md, CONTEXT.md, USER.md) — this is the primary
 * component of the actual runtime system prompt.
 *
 * Strategy 2: Scan the TypeScript source for hardcoded template literals.
 */
function extractSystemPrompt(autogentPath: string, workspacePath: string): string {
  // Strategy 1: read bootstrap files from workspace
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

  if (parts.length > 0) {
    return parts.join('\n\n---\n\n');
  }

  // Strategy 2: scan TypeScript source for template literals
  const candidates = [
    join(autogentPath, 'src', 'workspace', 'index.ts'),
    join(autogentPath, 'src', 'workspace', 'system-prompt.ts'),
    join(autogentPath, 'src', 'session.ts'),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const content = readFileSync(candidate, 'utf-8');
    const templateMatch = content.match(/`(You are[\s\S]{200,?}?)`/);
    if (templateMatch) return templateMatch[1];
    const stringMatch = content.match(/"(You are[^"]{200,?})"/);
    if (stringMatch) return stringMatch[1];
  }

  return '';
}

// ---------------------------------------------------------------------------
// Model pool capture
// ---------------------------------------------------------------------------

/**
 * Capture the available model pool via CopilotClient.listModels().
 *
 * Returns a ModelPool on success, or null if the SDK process is unavailable
 * (e.g. in CI environments without a running CLI). Errors are logged as
 * warnings — they never crash the baseline capture.
 *
 * Pass SKIP_MODEL_POOL=true to bypass entirely (useful for fast local runs).
 */
async function captureModelPool(): Promise<ModelPool | null> {
  const capturedAt = new Date().toISOString();
  const client = new CopilotClient({
    useLoggedInUser: true,
    useStdio: true,
    autoStart: true,
  });

  try {
    await client.start();
    const rawModels = await client.listModels();
    const models = rawModels.map((m) => ({
      id: m.id,
      state: m.policy?.state ?? 'unconfigured',
      contextWindow: m.capabilities.limits.max_context_window_tokens,
    }));
    return { capturedAt, models };
  } catch (err) {
    console.warn(`⚠️  Model pool capture skipped: ${String(err)}`);
    return null;
  } finally {
    try {
      await (client as unknown as { disconnect?: () => Promise<void> }).disconnect?.();
    } catch {
      // best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('CLI Wrapper Monitor — Autogent Baseline Capture');
  console.log('================================================\n');

  const autogentExists = existsSync(AUTOGENT_PATH);
  const workspaceExists = existsSync(WORKSPACE_PATH);
  console.log(
    `Autogent path: ${AUTOGENT_PATH} ${autogentExists ? '✓' : '✗ (not found)'}`,
  );
  console.log(
    `Workspace path: ${WORKSPACE_PATH} ${workspaceExists ? '✓' : '✗ (not found)'}`,
  );

  // Extract data from autogent source
  const systemPrompt =
    autogentExists || workspaceExists
      ? extractSystemPrompt(AUTOGENT_PATH, WORKSPACE_PATH)
      : '';
  const toolDefs = autogentExists ? extractToolDefs(AUTOGENT_PATH) : [];

  console.log(`System prompt extracted: ${systemPrompt.length} chars`);
  console.log(`Tool definitions extracted: ${toolDefs.length} tools`);
  if (toolDefs.length > 0) {
    console.log(
      `  Tools: ${toolDefs.map((t) => t.name).join(', ')}`,
    );
  }
  if (SKIP_MODEL_POOL) {
    console.log('Model pool capture: skipped (SKIP_MODEL_POOL=true)');
  } else {
    console.log('Model pool capture: enabled (set SKIP_MODEL_POOL=true to skip)');
  }
  console.log(`Live mode: ${LIVE_MODE ? 'enabled' : 'disabled (set LIVE_MODE=true to enable)'}`);

  // Refusal-rate experiment status
  const refusalLiveAvailable = hasGitHubToken();
  if (SKIP_REFUSAL) {
    console.log('Refusal-rate experiment: skipped (SKIP_REFUSAL=true)');
  } else if (refusalLiveAvailable) {
    console.log('Refusal-rate experiment: live mode (GITHUB_TOKEN detected)');
  } else {
    console.log(
      'Refusal-rate experiment: skipped (set GITHUB_TOKEN to enable live refusal probes)',
    );
  }
  console.log('');

  // Compute fingerprints
  const binaryHash = autogentExists ? computeBinaryHash(AUTOGENT_PATH) : 'unknown';
  const systemPromptHash = computeSystemPromptHash(systemPrompt);
  console.log(`Binary hash:        ${binaryHash}`);
  console.log(`System prompt hash: ${systemPromptHash}`);
  console.log('');

  const store = new SnapshotStore(BASELINES_DIR);
  const existingBaseline = store.loadLatest();

  const runner = new ExperimentRunner();
  runner.register(
    new ContextTaxExperiment({
      systemPrompt,
      toolDefinitions: toolDefs,
      liveMode: LIVE_MODE,
    }),
  );

  // -- Refusal Rate --
  // Runs whenever a GitHub token is available; each probe uses the GitHub
  // Models API so results are comparable across snapshots (same probe set,
  // same model, same classifier).
  if (!SKIP_REFUSAL && refusalLiveAvailable) {
    runner.register(
      new RefusalRateExperiment({
        maxProbesPerCategory: 3, // cap at 3 per category for cost control
      }),
    );
  }

  console.log('Running experiments...');
  const snapshot = await runner.runAll();

  // Attach fingerprints to the snapshot
  snapshot.binaryHash = binaryHash;
  snapshot.systemPromptHash = systemPromptHash;

  // Capture model pool
  if (!SKIP_MODEL_POOL) {
    console.log('Capturing model pool...');
    const modelPool = await captureModelPool();
    if (modelPool) {
      snapshot.modelPool = modelPool;
      console.log(`Model pool captured: ${modelPool.models.length} models`);
      const enabled = modelPool.models.filter((m) => m.state === 'enabled').length;
      console.log(`  Enabled: ${enabled}  Total: ${modelPool.models.length}`);
    }
  }

  console.log('');

  const savedPath = store.save(snapshot);
  console.log(`Snapshot saved: ${savedPath}`);
  console.log('');

  // Print full metrics per experiment
  for (const [expName, result] of Object.entries(snapshot.experiments)) {
    console.log(`Experiment: ${expName}`);
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    } else {
      for (const [key, metric] of Object.entries(result.metrics)) {
        console.log(`  ${key}: ${metric.value} ${metric.unit}`);
      }
    }
    console.log('');
  }

  // Size delta summary table (always emitted; shows '—' when no prior baseline)
  const sizeDelta = computeSizeDelta(snapshot, existingBaseline);
  console.log(formatSizeDeltaTable(sizeDelta));

  if (existingBaseline) {
    const diff = diffSnapshots(existingBaseline, snapshot);

    // Emit hash-change warnings before full diff
    if (diff.binaryChanged) {
      const prev = existingBaseline.binaryHash?.slice(0, 16) ?? '?';
      const curr = snapshot.binaryHash?.slice(0, 16) ?? '?';
      console.warn(`⚠️  CLI binary changed: ${prev}… → ${curr}…`);
    }
    if (diff.systemPromptChanged) {
      const prev = existingBaseline.systemPromptHash?.slice(0, 16) ?? '?';
      const curr = snapshot.systemPromptHash?.slice(0, 16) ?? '?';
      console.warn(`⚠️  System prompt changed: ${prev}… → ${curr}…`);
    }
    if (diff.binaryChanged || diff.systemPromptChanged) {
      console.warn('');
    }

    console.log(formatDiffReport(diff));

    // Emit model pool change summary
    if (diff.modelPoolChanges.length > 0) {
      const removals = diff.modelPoolChanges.filter((c) => c.type === 'removed');
      const additions = diff.modelPoolChanges.filter((c) => c.type === 'added');
      const stateChanges = diff.modelPoolChanges.filter((c) => c.type === 'state_changed');
      const ctxChanges = diff.modelPoolChanges.filter((c) => c.type === 'context_window_changed');
      if (removals.length > 0) {
        console.warn(`⚠️  Model(s) removed: ${removals.map((c) => c.modelId).join(', ')}`);
      }
      if (stateChanges.some((c) => c.after?.state === 'disabled' || c.after?.state === 'unconfigured')) {
        const deprecated = stateChanges.filter((c) => c.after?.state !== 'enabled');
        console.warn(`⚠️  Model(s) deprecated/disabled: ${deprecated.map((c) => c.modelId).join(', ')}`);
      }
      if (additions.length > 0) {
        console.log(`ℹ️  Model(s) added: ${additions.map((c) => c.modelId).join(', ')}`);
      }
      if (ctxChanges.length > 0) {
        console.log(`ℹ️  Context window changed: ${ctxChanges.map((c) => c.modelId).join(', ')}`);
      }
    }

    if (diff.hasRegressions) {
      console.error('\n❌ Regressions detected — please investigate');
      process.exitCode = 1;
    }
  } else {
    console.log(
      'No prior baseline found — this snapshot is the new baseline.\n' +
        'Commit baselines/latest.json and the timestamped snapshot file.\n' +
        'Run again next month to detect changes.',
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
