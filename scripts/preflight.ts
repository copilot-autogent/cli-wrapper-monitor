/**
 * Pre-flight validator: check auth and environment before capture starts.
 *
 * Runs 4 quick checks and exits with code 0 on all-pass or code 1 on any failure.
 * Designed to be called with `--preflight` on capture-autogent-baseline.ts,
 * or directly via `npm run preflight`.
 *
 * Checks:
 *   1. Auth check      — listModels() via CopilotClient with a short timeout
 *   2. Webhook check   — POST ping to DISCORD_WEBHOOK_URL (skipped when unset)
 *   3. Disk space      — at least 10 MB free in baselines/
 *   4. TypeScript      — tsc --noEmit passes (no pre-existing type errors)
 *
 * Usage:
 *   npx tsx scripts/preflight.ts
 *   npx tsx scripts/capture-autogent-baseline.ts --preflight
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CopilotClient } from '@github/copilot-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

const AUTH_TIMEOUT_MS = 10_000;
const MIN_FREE_BYTES = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreflightResult {
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Check 1: Auth
// ---------------------------------------------------------------------------

/** Dependencies for auth check — injectable for tests. */
export interface AuthCheckDeps {
  /**
   * Factory that creates a CopilotClient-compatible object with
   * `start(): Promise<void>` and `listModels(): Promise<unknown[]>`.
   */
  createClient?: () => {
    start(): Promise<void>;
    listModels(): Promise<unknown[]>;
    disconnect?(): Promise<void>;
  };
}

/**
 * Verify Copilot SDK auth is valid by calling listModels() with a timeout.
 *
 * On failure returns an actionable message telling the user to run /login.
 */
export async function checkAuth(deps: AuthCheckDeps = {}): Promise<PreflightResult> {
  const createClient =
    deps.createClient ??
    (() =>
      new CopilotClient({
        useLoggedInUser: true,
        useStdio: true,
        autoStart: true,
      }) as unknown as {
        start(): Promise<void>;
        listModels(): Promise<unknown[]>;
        disconnect?(): Promise<void>;
      });

  let client: ReturnType<typeof createClient> | undefined;
  try {
    client = createClient();
    await client.start();

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), AUTH_TIMEOUT_MS),
    );
    await Promise.race([client.listModels(), timeoutPromise]);

    return { ok: true, message: '✅ Auth check passed.' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `❌ Auth check failed: run /login in Copilot CLI first (${detail})`,
    };
  } finally {
    try {
      await client?.disconnect?.();
    } catch {
      // best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2: Webhook reachability
// ---------------------------------------------------------------------------

/** Dependencies for webhook check — injectable for tests. */
export interface WebhookCheckDeps {
  fetchFn?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
}

/**
 * Ping DISCORD_WEBHOOK_URL with a preflight-test payload and expect a 2xx response.
 * Skipped (pass) when DISCORD_WEBHOOK_URL is unset or empty.
 */
export async function checkWebhook(
  webhookUrl: string | undefined,
  deps: WebhookCheckDeps = {},
): Promise<PreflightResult> {
  if (!webhookUrl || !webhookUrl.trim()) {
    return { ok: true, message: '✅ Webhook check skipped (DISCORD_WEBHOOK_URL not set).' };
  }

  const fetchFn = deps.fetchFn ?? globalThis.fetch;

  try {
    const res = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'preflight-test' }),
    });

    if (res.ok) {
      return { ok: true, message: '✅ Webhook check passed.' };
    }
    return {
      ok: false,
      message: `❌ Webhook check failed: DISCORD_WEBHOOK_URL returned HTTP ${res.status} — check URL or network connectivity`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `❌ Webhook check failed: DISCORD_WEBHOOK_URL is unreachable — check URL or network connectivity (${detail})`,
    };
  }
}

// ---------------------------------------------------------------------------
// Check 3: Disk space
// ---------------------------------------------------------------------------

/** Dependencies for disk space check — injectable for tests. */
export interface DiskCheckDeps {
  /**
   * Return free bytes for the given path using `df -k`.
   * Injected in tests to avoid real filesystem calls.
   */
  getFreeBytesSync?: (dirPath: string) => number;
}

/**
 * Parse `df -k <path>` output and return available bytes.
 * Returns -1 when the command fails or output is unparseable.
 */
function getFreeBytesSync(dirPath: string): number {
  const result = spawnSync('df', ['-k', '--output=avail', dirPath], { encoding: 'utf-8' });
  if (result.status !== 0 || !result.stdout) return -1;
  const lines = result.stdout.trim().split('\n');
  // Header line is "Avail"; second line is the value in 1K-blocks
  const valueStr = lines[lines.length - 1]?.trim();
  if (!valueStr) return -1;
  const kb = parseInt(valueStr, 10);
  if (isNaN(kb)) return -1;
  return kb * 1024;
}

/**
 * Verify that at least 10 MB is free in the baselines directory.
 * Creates the directory if it doesn't exist (so the check is always actionable).
 */
export async function checkDiskSpace(
  baselinesDir: string,
  deps: DiskCheckDeps = {},
): Promise<PreflightResult> {
  if (!existsSync(baselinesDir)) {
    try {
      mkdirSync(baselinesDir, { recursive: true });
    } catch {
      // non-fatal: df will still run
    }
  }

  const getFreeBytes = deps.getFreeBytesSync ?? getFreeBytesSync;
  const freeBytes = getFreeBytes(baselinesDir);

  if (freeBytes < 0) {
    return {
      ok: false,
      message: '❌ Disk check failed: could not determine free space in baselines/ — ensure the directory exists and df is available',
    };
  }

  const freeMB = (freeBytes / (1024 * 1024)).toFixed(1);
  if (freeBytes < MIN_FREE_BYTES) {
    return {
      ok: false,
      message: `❌ Disk check failed: only ${freeMB} MB free in baselines/ (need ≥10 MB) — clear old baselines or free up disk space`,
    };
  }

  return { ok: true, message: `✅ Disk check passed (${freeMB} MB free).` };
}

// ---------------------------------------------------------------------------
// Check 4: TypeScript compilation
// ---------------------------------------------------------------------------

/** Dependencies for TypeScript check — injectable for tests. */
export interface TscCheckDeps {
  /** Run tsc --noEmit and return exit code + stderr. */
  runTscSync?: () => { exitCode: number; stderr: string };
}

function runTscSync(projectRoot: string): { exitCode: number; stderr: string } {
  const result = spawnSync('npx', ['tsc', '--noEmit'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
  return {
    exitCode: result.status ?? 1,
    stderr: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

/**
 * Verify that `tsc --noEmit` passes (no pre-existing type errors).
 */
export async function checkTypeScript(
  projectRoot: string,
  deps: TscCheckDeps = {},
): Promise<PreflightResult> {
  const run = deps.runTscSync ?? (() => runTscSync(projectRoot));

  try {
    const { exitCode, stderr } = run();
    if (exitCode === 0) {
      return { ok: true, message: '✅ TypeScript check passed.' };
    }

    const hint = stderr.trim()
      ? `\n  First error: ${stderr.trim().split('\n')[0]}`
      : '';
    return {
      ok: false,
      message: `❌ TypeScript check failed: tsc --noEmit errors — fix type errors before capturing${hint}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `❌ TypeScript check failed: could not run tsc — ensure TypeScript is installed (${detail})`,
    };
  }
}

// ---------------------------------------------------------------------------
// runPreflight: orchestrate all checks
// ---------------------------------------------------------------------------

export interface PreflightOptions {
  baselinesDir?: string;
  webhookUrl?: string;
  projectRoot?: string;
  deps?: {
    auth?: AuthCheckDeps;
    webhook?: WebhookCheckDeps;
    disk?: DiskCheckDeps;
    tsc?: TscCheckDeps;
  };
}

/**
 * Run all 4 pre-flight checks.
 *
 * Prints each result to stdout/stderr as it runs.
 * Returns true when all checks pass, false on any failure.
 */
export async function runPreflight(opts: PreflightOptions = {}): Promise<boolean> {
  const baselinesDir =
    opts.baselinesDir ??
    (process.env['BASELINES_DIR']
      ? process.env['BASELINES_DIR']
      : join(__dirname, '../baselines'));

  const webhookUrl = opts.webhookUrl ?? process.env['DISCORD_WEBHOOK_URL'];
  const projectRoot = opts.projectRoot ?? join(__dirname, '..');

  console.log('Pre-flight checks\n─────────────────');

  const checks = [
    () => checkAuth(opts.deps?.auth),
    () => checkWebhook(webhookUrl, opts.deps?.webhook),
    () => checkDiskSpace(baselinesDir, opts.deps?.disk),
    () => checkTypeScript(projectRoot, opts.deps?.tsc),
  ];

  let allPassed = true;
  for (const check of checks) {
    const result = await check();
    if (result.ok) {
      console.log(result.message);
    } else {
      console.error(result.message);
      allPassed = false;
    }
  }

  console.log('─────────────────');
  if (allPassed) {
    console.log('✅ Pre-flight checks passed — ready to capture.');
  } else {
    console.error('❌ One or more pre-flight checks failed — resolve the issues above before capturing.');
  }

  return allPassed;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPreflight()
    .then((passed) => {
      process.exit(passed ? 0 : 1);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
