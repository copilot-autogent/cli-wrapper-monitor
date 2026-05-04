/**
 * Capture a context-tax baseline using real autogent source data.
 *
 * Reads the system prompt template and tool definitions from a local
 * autogent checkout (defaults to /app) and runs the context-tax experiment
 * against them. This gives a real baseline reflecting the actual token
 * overhead of the CLI wrapper in production.
 *
 * Usage:
 *   npx tsx scripts/capture-autogent-baseline.ts
 *   AUTOGENT_PATH=/path/to/autogent npx tsx scripts/capture-autogent-baseline.ts
 *   LIVE_MODE=true GITHUB_TOKEN=<token> npx tsx scripts/capture-autogent-baseline.ts
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentRunner } from '../src/harness/runner.js';
import { SnapshotStore } from '../src/harness/snapshot.js';
import { diffSnapshots, formatDiffReport } from '../src/harness/diff.js';
import { ContextTaxExperiment } from '../src/experiments/context-tax.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINES_DIR = join(__dirname, '../baselines');

const AUTOGENT_PATH = process.env['AUTOGENT_PATH'] ?? '/app';
const LIVE_MODE = process.env['LIVE_MODE'] === 'true';

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
  console.log(`Live mode: ${LIVE_MODE ? 'enabled' : 'disabled (set LIVE_MODE=true to enable)'}`);
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

  console.log('Running experiments...');
  const snapshot = await runner.runAll();
  console.log('');

  const savedPath = store.save(snapshot);
  console.log(`Snapshot saved: ${savedPath}`);
  console.log('');

  // Print metrics summary
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
        'Commit baselines/latest.json and the timestamped snapshot file.\n' +
        'Run again next month to detect changes.',
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
