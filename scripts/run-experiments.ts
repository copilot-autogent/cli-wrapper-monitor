/**
 * CLI entry point for running all configured experiments.
 *
 * Usage:
 *   npm run experiments
 *
 *   # With real autogent wrapper data:
 *   SYSTEM_PROMPT_FILE=./prompt.txt TOOL_DEFS_FILE=./tools.json npm run experiments
 *
 *   # With live token counting (requires GITHUB_TOKEN):
 *   LIVE_MODE=true npm run experiments
 *
 *   # Skip refusal-rate probes (faster):
 *   SKIP_REFUSAL=true npm run experiments
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentRunner } from '../src/harness/runner.js';
import { SnapshotStore } from '../src/harness/snapshot.js';
import { diffSnapshots, formatDiffReport } from '../src/harness/diff.js';
import { ContextTaxExperiment } from '../src/experiments/context-tax.js';
import { RefusalRateExperiment } from '../src/experiments/refusal-rate.js';
import { hasGitHubToken } from '../src/harness/models-api-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINES_DIR = join(__dirname, '../baselines');

const LIVE_MODE = process.env['LIVE_MODE'] === 'true';
const SKIP_REFUSAL = process.env['SKIP_REFUSAL'] === 'true';

interface ToolDef {
  name: string;
  description: string;
  parameters?: unknown;
}

function loadFileIfExists(envVar: string): string | undefined {
  const path = process.env[envVar];
  if (!path) return undefined;
  if (!existsSync(path)) {
    console.warn(`  ⚠ ${envVar}=${path} not found — skipping`);
    return undefined;
  }
  return readFileSync(path, 'utf-8');
}

async function main(): Promise<void> {
  console.log('CLI Wrapper Monitor');
  console.log('===================\n');

  const liveAvailable = hasGitHubToken();
  console.log(`Live mode: ${LIVE_MODE && liveAvailable ? 'enabled' : 'disabled'}${LIVE_MODE && !liveAvailable ? ' (GITHUB_TOKEN not set)' : ''}`);
  console.log('');

  const store = new SnapshotStore(BASELINES_DIR);
  const existingBaseline = store.loadLatest();

  const runner = new ExperimentRunner();

  // -- Context Tax --
  const systemPromptRaw = loadFileIfExists('SYSTEM_PROMPT_FILE');
  const toolDefsRaw = loadFileIfExists('TOOL_DEFS_FILE');
  const toolDefs: ToolDef[] | undefined = toolDefsRaw
    ? (JSON.parse(toolDefsRaw) as ToolDef[])
    : undefined;

  runner.register(
    new ContextTaxExperiment({
      systemPrompt: systemPromptRaw,
      toolDefinitions: toolDefs,
      liveMode: LIVE_MODE,
    }),
  );

  // -- Refusal Rate --
  if (!SKIP_REFUSAL && (LIVE_MODE || liveAvailable)) {
    console.log('Refusal-rate experiment: live mode (GITHUB_TOKEN detected)');
    runner.register(
      new RefusalRateExperiment({
        maxProbesPerCategory: 3, // cap at 3 per category for cost control
      }),
    );
  } else if (!SKIP_REFUSAL) {
    console.log(
      'Refusal-rate experiment: skipped (set GITHUB_TOKEN or LIVE_MODE=true to enable)',
    );
  }
  console.log('');

  // Run all registered experiments
  console.log('Running experiments...');
  const snapshot = await runner.runAll();
  console.log('');

  const savedPath = store.save(snapshot);
  console.log(`Snapshot saved: ${savedPath}`);
  console.log('');

  // Print metrics
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

  // Compare with prior baseline if available
  if (existingBaseline) {
    const diff = diffSnapshots(existingBaseline, snapshot);
    console.log(formatDiffReport(diff));
    if (diff.hasRegressions) {
      console.error('\n❌ Regressions detected — please investigate');
      process.exitCode = 1;
    }
  } else {
    console.log(
      'No prior baseline found — this snapshot is the new baseline.\n' +
        'Run again next month to detect changes.',
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
