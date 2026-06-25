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
 *   SKIP_PROVENANCE=true npx tsx scripts/capture-autogent-baseline.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CopilotClient } from '@github/copilot-sdk';
import { ExperimentRunner } from '../src/harness/runner.js';
import { SnapshotStore } from '../src/harness/snapshot.js';
import { diffSnapshots, formatDiffReport } from '../src/harness/diff.js';
import { computeSizeDelta, formatSizeDeltaTable, sendSizeAlertWebhook } from '../src/harness/size-delta.js';
import {
  computeContextWindowHeadroom,
  formatHeadroomTable,
  detectFirstTimeCrossings,
  extractSystemPromptTokens,
  sendHeadroomAlertWebhook,
} from '../src/harness/context-window-headroom.js';
import { ContextTaxExperiment } from '../src/experiments/context-tax.js';
import { RefusalRateExperiment } from '../src/experiments/refusal-rate.js';
import { hasGitHubToken } from '../src/harness/models-api-client.js';
import type { ModelPool, ToolParamSchema } from '../src/harness/types.js';
import { fetchProvenanceLinks } from '../src/harness/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINES_DIR = join(__dirname, '../baselines');

const AUTOGENT_PATH = process.env['AUTOGENT_PATH'] ?? '/app';
const LIVE_MODE = process.env['LIVE_MODE'] === 'true';
const SKIP_REFUSAL = process.env['SKIP_REFUSAL'] === 'true';
const SKIP_MODEL_POOL = process.env['SKIP_MODEL_POOL'] === 'true';
const SKIP_PROVENANCE = process.env['SKIP_PROVENANCE'] === 'true';

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
 * Hook handler patterns: the three SDK hook callbacks that govern tool
 * execution behaviour and security posture.
 *
 * Patterns cover the most common source forms:
 *   - Object-literal property:  `onPreToolUse:`
 *   - Assignment form:          `.onPreToolUse =`
 *   - Method shorthand:         `onPreToolUse(`
 *
 * Note: `hookCount` is a best-effort heuristic based on static pattern
 * matching. The `hookSourceHash` is the authoritative change signal.
 */
const HOOK_HANDLER_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'onPreToolUse', pattern: /\bonPreToolUse\s*[:(=]/ },
  { name: 'onPermissionRequest', pattern: /\bonPermissionRequest\s*[:(=]/ },
  { name: 'onPostToolUse', pattern: /\bonPostToolUse\s*[:(=]/ },
];

/**
 * Hook source files to scan (dist paths, falling back to src).
 *
 * Strategy 1 (dist): requires dist/hooks/ to have at least one .js file.
 *   - Loads all .js files from dist/hooks/
 *   - Also loads dist/session.js when present (contains onPermissionRequest)
 *
 * Strategy 2 (src fallback): used when dist/hooks/ is absent or empty.
 *   - Loads all .ts files from src/hooks/
 *   - Also loads src/session.ts when present
 *
 * Returns hookSourceHash: 'unknown' when no source is found or any read fails.
 */
interface HookIntrospectionResult {
  hookCount: number;
  hookSourceHash: string;
}

function extractHookDefs(autogentPath: string): HookIntrospectionResult {
  const sourceChunks: string[] = [];
  /** Set to true if any file read fails so we can mark the hash as unreliable. */
  let readError = false;

  /** Read all .js files from a compiled dist directory. Returns file count loaded. */
  function loadDistDir(dir: string): number {
    if (!existsSync(dir)) return 0;
    let count = 0;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .sort();
    for (const file of files) {
      try {
        sourceChunks.push(readFileSync(join(dir, file), 'utf-8'));
        count++;
      } catch {
        readError = true;
      }
    }
    return count;
  }

  /** Read all .ts files from a TypeScript source directory. */
  function loadSrcDir(dir: string): void {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .sort();
    for (const file of files) {
      try {
        sourceChunks.push(readFileSync(join(dir, file), 'utf-8'));
      } catch {
        readError = true;
      }
    }
  }

  /** Read a single file into sourceChunks if it exists. */
  function loadFile(filePath: string): void {
    if (!existsSync(filePath)) return;
    try {
      sourceChunks.push(readFileSync(filePath, 'utf-8'));
    } catch {
      readError = true;
    }
  }

  // Strategy 1: dist/hooks/*.js is the primary source for hook implementations.
  // Only use dist strategy when hooks dir exists AND contributes .js files —
  // avoids silently using only dist/session.js (which has onPermissionRequest but
  // not onPreToolUse/onPostToolUse) when dist/hooks/ is missing.
  const distHooksDir = join(autogentPath, 'dist', 'hooks');
  const distSessionFile = join(autogentPath, 'dist', 'session.js');
  const hooksFilesLoaded = loadDistDir(distHooksDir);
  if (hooksFilesLoaded > 0) {
    // dist/hooks/ was present and contributed files — also load session.js
    loadFile(distSessionFile);
  } else {
    // Strategy 2: TypeScript source fallback
    sourceChunks.length = 0; // discard any partial load
    const srcHooksDir = join(autogentPath, 'src', 'hooks');
    const srcSessionFile = join(autogentPath, 'src', 'session.ts');
    loadSrcDir(srcHooksDir);
    loadFile(srcSessionFile);
  }

  if (readError) {
    console.warn('⚠️  Hook source read error — hookSourceHash marked as unknown');
    return { hookCount: 0, hookSourceHash: 'unknown' };
  }
  if (sourceChunks.length === 0) {
    return { hookCount: 0, hookSourceHash: 'unknown' };
  }

  // Detect which hook handler types are present across all loaded files
  const allSource = sourceChunks.join('\n');
  const registeredHooks = new Set<string>();
  for (const { name, pattern } of HOOK_HANDLER_PATTERNS) {
    if (pattern.test(allSource)) {
      registeredHooks.add(name);
    }
  }

  const hookSourceHash = 'sha256:' + sha256(allSource);
  return { hookCount: registeredHooks.size, hookSourceHash };
}

/**
 * Attempt to extract tool definitions from the autogent dist build.
 *
 * Looks for *.js files in dist/tools/builtin/ that export tool metadata.
 * Also attempts to extract the `parameters` JSON schema from each file.
 *
 * Falls back to parsing the TypeScript source with a simple regex when
 * the dist directory isn't available.
 */
function extractToolDefs(autogentPath: string): ToolDef[] {
  const tools: ToolDef[] = [];

  /** Extract required parameter names and property names from JS/TS source content.
   *
   * Uses targeted regex extraction rather than JSON.parse, which breaks on
   * compiled JS object literals with unquoted keys, single-quote strings,
   * and trailing commas. String-aware brace counting prevents `{`/`}` inside
   * schema descriptions from desync-ing the depth counter.
   *
   * Scopes both searches to within the `parameters:` block to avoid matching
   * `required:` or `properties:` from description text or nested schemas.
   */
  function extractParamInfo(content: string): { required: string[]; propNames: string[] } {
    // Find the `parameters:` block. Skip if not present (tool has no params).
    const paramsIdx = content.search(/\bparameters\s*:/);
    if (paramsIdx === -1) return { required: [], propNames: [] };
    const paramsBraceStart = content.indexOf('{', paramsIdx);
    if (paramsBraceStart === -1) return { required: [], propNames: [] };

    // Extract the full parameters block with string-aware brace counting.
    // Handles escaped backslashes correctly: count consecutive backslashes before
    // the quote to determine if the quote is escaped (odd count = escaped).
    const paramsBlock = extractBlock(content, paramsBraceStart);

    // Extract required array: `required: ["a", "b"]` scoped to paramsBlock
    const required: string[] = [];
    const requiredMatch = paramsBlock.match(/\brequired\s*:\s*\[([^\]]*)\]/);
    if (requiredMatch) {
      for (const m of requiredMatch[1].matchAll(/['"]([^'"]+)['"]/g)) {
        required.push(m[1]);
      }
    }

    // Extract property names from the `properties:` block inside paramsBlock
    const propNames: string[] = [];
    const propsSearch = paramsBlock.search(/\bproperties\s*:/);
    if (propsSearch !== -1) {
      const propsBraceStart = paramsBlock.indexOf('{', propsSearch);
      if (propsBraceStart !== -1) {
        const propsBlock = extractBlock(paramsBlock, propsBraceStart);
        // Walk the properties block at depth 1 to find top-level keys.
        // Matches both bare `name:` and quoted `"name":` / `'name':` keys.
        let depth = 0;
        let i = 0;
        let inString = false;
        let strChar = '';
        while (i < propsBlock.length) {
          const ch = propsBlock[i];
          if (inString) {
            if (ch === strChar && !isEscaped(propsBlock, i)) inString = false;
          } else if (ch === '"' || ch === "'") {
            if (depth === 1) {
              // Quoted key: `"keyName":` or `'keyName':`
              const keyEnd = findStringEnd(propsBlock, i + 1, ch);
              if (keyEnd !== -1) {
                const keyName = propsBlock.slice(i + 1, keyEnd);
                const afterKey = propsBlock.slice(keyEnd + 1).trimStart();
                if (afterKey.startsWith(':') && /^[a-zA-Z_$][\w$]*$/.test(keyName)) {
                  propNames.push(keyName);
                }
                i = keyEnd;
              } else {
                inString = true;
                strChar = ch;
              }
            } else {
              inString = true;
              strChar = ch;
            }
          } else if (ch === '{') {
            depth++;
          } else if (ch === '}') {
            depth--;
            if (depth < 0) break;
          } else if (depth === 1) {
            // Bare identifier key: `name:`
            const slice = propsBlock.slice(i);
            const keyMatch = slice.match(/^([a-zA-Z_$][\w$]*)\s*:/);
            if (keyMatch) {
              propNames.push(keyMatch[1]);
              i += keyMatch[0].length - 1;
            }
          }
          i++;
        }
      }
    }

    return { required: required.sort(), propNames: propNames.sort() };
  }

  /** Extract a brace-delimited block starting at `start` (the opening `{`). */
  function extractBlock(content: string, start: number): string {
    let depth = 0;
    let i = start;
    let inString = false;
    let strChar = '';
    while (i < content.length) {
      const ch = content[i];
      if (inString) {
        if (ch === strChar && !isEscaped(content, i)) inString = false;
      } else if (ch === '"' || ch === "'") {
        inString = true;
        strChar = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return content.slice(start, i + 1);
      }
      i++;
    }
    return content.slice(start); // unterminated block, return rest
  }

  /** True when the character at `pos` is preceded by an odd number of backslashes. */
  function isEscaped(content: string, pos: number): boolean {
    let count = 0;
    let j = pos - 1;
    while (j >= 0 && content[j] === '\\') { count++; j--; }
    return count % 2 === 1;
  }

  /** Find the closing quote for a string starting at `from`, where `quoteChar` is `"` or `'`. */
  function findStringEnd(content: string, from: number, quoteChar: string): number {
    for (let i = from; i < content.length; i++) {
      if (content[i] === quoteChar && !isEscaped(content, i)) return i;
    }
    return -1;
  }

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
          const { required, propNames } = extractParamInfo(content);
          tools.push({
            name: nameMatch[1],
            description: descMatch[1],
            parameters: { required, propNames },
          });
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
          const { required, propNames } = extractParamInfo(content);
          tools.push({
            name: nameMatch[1],
            description: descMatch[1],
            parameters: { required, propNames },
          });
        }
      }
    } catch {
      // fall through
    }
  }

  return tools;
}

/**
 * Build per-tool ToolParamSchema records from a list of extracted tool definitions.
 * Returns a map keyed by tool name, and the sha256 hash of the whole schema set
 * (canonical JSON sorted by name). Both are used as change signals in diff reports.
 */
function buildToolSchemas(
  tools: ToolDef[],
): { schemas: Record<string, ToolParamSchema>; hash: string } {
  const schemas: Record<string, ToolParamSchema> = {};

  for (const tool of tools) {
    // Parameters are now stored as { required: string[]; propNames: string[] }
    // from the regex-based extractor in extractToolDefs.
    const params = tool.parameters as { required?: string[]; propNames?: string[] } | undefined;
    const required = params?.required ?? [];
    const propNames = params?.propNames ?? [];

    // Union all known param names (required + all property names from propNames)
    const allParamNames = [...new Set([...required, ...propNames])].sort();
    // Only report required params that are actually present in the parameter list
    const filteredRequired = required.filter((p) => allParamNames.includes(p));
    const requiredSet = new Set(filteredRequired);
    const optionalParams = allParamNames.filter((p) => !requiredSet.has(p));

    schemas[tool.name] = {
      parameterCount: allParamNames.length,
      requiredParams: filteredRequired,
      optionalParams,
      descriptionHash: sha256(tool.description),
    };
  }

  // Sort by name for a canonical, stable JSON representation (binary compare for locale stability)
  const sorted = Object.fromEntries(
    Object.entries(schemas).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const hash = 'sha256:' + sha256(JSON.stringify(sorted));
  return { schemas, hash };
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
  let client: CopilotClient | undefined;
  try {
    // Constructor inside try so failures are caught by the same handler.
    client = new CopilotClient({
      useLoggedInUser: true,
      useStdio: true,
      autoStart: true,
    });
    await client.start();
    // Timestamp immediately before the call so ModelPool.capturedAt reflects
    // when the model list was actually fetched, not when startup began.
    const capturedAt = new Date().toISOString();
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
    if (client) {
      try {
        await (client as unknown as { disconnect?: () => Promise<void> }).disconnect?.();
      } catch {
        // best-effort cleanup
      }
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
  const { hookCount, hookSourceHash } = autogentExists
    ? extractHookDefs(AUTOGENT_PATH)
    : { hookCount: 0, hookSourceHash: 'unknown' };
  const { schemas: toolSchemas, hash: toolSchemaHash } = buildToolSchemas(toolDefs);

  console.log(`System prompt extracted: ${systemPrompt.length} chars`);
  console.log(`Tool definitions extracted: ${toolDefs.length} tools`);
  if (toolDefs.length > 0) {
    console.log(
      `  Tools: ${toolDefs.map((t) => t.name).join(', ')}`,
    );
  }
  console.log(`Tool schema hash:   ${toolSchemaHash}`);
  console.log(`Hook definitions extracted: ${hookCount} handlers`);
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
  console.log(`Hook source hash:   ${hookSourceHash}`);
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
  snapshot.hookCount = hookCount;
  snapshot.hookSourceHash = hookSourceHash;
  if (Object.keys(toolSchemas).length > 0) {
    snapshot.toolSchemas = toolSchemas;
    snapshot.toolSchemaHash = toolSchemaHash;
  }

  // Capture model pool
  if (!SKIP_MODEL_POOL) {
    console.log('Capturing model pool...');
    const modelPool = await captureModelPool();
    if (modelPool) {
      snapshot.modelPool = modelPool;
      console.log(`Model pool captured: ${modelPool.models.length} models`);
      const enabled = modelPool.models.filter((m) => m.state === 'enabled').length;
      console.log(`  Enabled: ${enabled}  Total: ${modelPool.models.length}`);

      // Compute context window headroom now that we have both the model pool
      // and the context-tax token count. This is safe here because
      // runner.runAll() (which populates snapshot.experiments) runs before
      // the model pool capture block, so the context-tax metrics are available.
      const systemPromptTokens = extractSystemPromptTokens(snapshot);
      if (systemPromptTokens > 0) {
        snapshot.contextWindowHeadroom = computeContextWindowHeadroom(
          modelPool,
          systemPromptTokens,
        );
      }
    } else if (existingBaseline?.modelPool) {
      // The previous baseline had a model pool but this capture failed.
      // Warn explicitly so operators know the monitor was blind this run.
      console.warn(
        '⚠️  Model pool capture failed — previous baseline had a pool. ' +
          'Model pool changes cannot be detected for this run.',
      );
    }
  }

  // ── Provenance linking ─────────────────────────────────────────────────────
  // Query autogent PRs merged between the previous baseline date and now that
  // touched src/workspace/, src/tools/builtin/, or src/hooks/. Embed matched
  // PRs in the snapshot so reports can explain observed deltas.
  // Requires GITHUB_TOKEN (or GH_TOKEN). Silent no-op when token absent.
  if (existingBaseline && !SKIP_PROVENANCE) {
    console.log('Linking provenance...');
    const causes = await fetchProvenanceLinks(
      existingBaseline.capturedAt,
      snapshot.capturedAt,
    );
    if (causes.length > 0) {
      snapshot.possibleCauses = causes;
      console.log(`Provenance: ${causes.length} matched PR(s):`);
      for (const c of causes) {
        console.log(`  ${c.pr}: "${c.title}" (${c.mergedAt}) [${c.touchedPaths.join(', ')}]`);
      }
    } else {
      console.log('Provenance: no matched autogent PRs in date range');
    }
    console.log('');
  } else if (!existingBaseline) {
    console.log('Provenance linking: skipped (no prior baseline)');
    console.log('');
  } else {
    console.log('Provenance linking: skipped (SKIP_PROVENANCE=true)');
    console.log('');
  }

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

  // Context window headroom table (emitted whenever headroom was computed)
  if (snapshot.contextWindowHeadroom && snapshot.contextWindowHeadroom.length > 0) {
    console.log(formatHeadroomTable(snapshot.contextWindowHeadroom));
  }

  const ciRunUrl =
    process.env['GITHUB_SERVER_URL'] && process.env['GITHUB_REPOSITORY'] && process.env['GITHUB_RUN_ID']
      ? `${process.env['GITHUB_SERVER_URL']}/${process.env['GITHUB_REPOSITORY']}/actions/runs/${process.env['GITHUB_RUN_ID']}`
      : undefined;

  if (existingBaseline) {
    // Send Discord webhook notification when SIZE ALERT fires.
    // Only meaningful when a prior baseline exists for comparison.
    // DISCORD_WEBHOOK_URL absent → silent no-op (no CI failure).
    await sendSizeAlertWebhook(sizeDelta, ciRunUrl);

    // Fire HEADROOM ALERT when any model newly crosses the >50% fill threshold.
    const headroomCrossings = detectFirstTimeCrossings(
      snapshot.contextWindowHeadroom ?? [],
      existingBaseline.contextWindowHeadroom,
    );
    if (headroomCrossings.length > 0) {
      console.warn(
        `⚠️  ${headroomCrossings.length} model(s) newly crossed the 50% headroom threshold: ` +
          headroomCrossings.map((e) => e.modelId).join(', '),
      );
    }
    await sendHeadroomAlertWebhook(headroomCrossings, ciRunUrl);

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
    if (diff.hookChanged) {
      const prev = existingBaseline.hookSourceHash?.slice(0, 16) ?? '?';
      const curr = snapshot.hookSourceHash?.slice(0, 16) ?? '?';
      const prevCount = existingBaseline.hookCount ?? '?';
      const currCount = snapshot.hookCount ?? '?';
      const countNote = prevCount !== currCount ? ` (count: ${prevCount} → ${currCount})` : '';
      console.warn(`🚨  Hook definitions changed: ${prev}… → ${curr}…${countNote}`);
    }
    if (diff.toolSchemaChanged) {
      const prev = existingBaseline.toolSchemaHash?.slice(0, 16) ?? '?';
      const curr = snapshot.toolSchemaHash?.slice(0, 16) ?? '?';
      console.warn(`⚠️  Tool schemas changed: ${prev}… → ${curr}…`);
      for (const change of diff.toolSchemaChanges) {
        if (change.type === 'added') {
          console.log(`  + tool added: ${change.toolName}`);
        } else if (change.type === 'removed') {
          console.warn(`  - tool removed: ${change.toolName}`);
        } else if (change.type === 'params_changed') {
          const added = change.addedParams?.map((p) => `+${p}`).join(', ') ?? '';
          const removed = change.removedParams?.map((p) => `-${p}`).join(', ') ?? '';
          console.warn(`  ~ params changed: ${change.toolName} [${[added, removed].filter(Boolean).join(', ')}]`);
        } else if (change.type === 'description_changed') {
          console.warn(`  ~ description changed: ${change.toolName}`);
        }
      }
    }
    if (diff.binaryChanged || diff.systemPromptChanged || diff.hookChanged || diff.toolSchemaChanged) {
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
      if (stateChanges.some((c) => c.after?.state !== 'enabled')) {
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
