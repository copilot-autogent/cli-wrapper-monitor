import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MetricSnapshot } from './types.js';
import { diffSnapshots } from './diff.js';
import type { DiffReport } from './types.js';

/**
 * Resolve the two most recent ISO-date-sorted baseline files from `baselinesDir`.
 * Files named `latest.json` and `schema.json` are excluded.
 * Subdirectories (e.g. `weekly/`) are not traversed — only root-level monthly baselines.
 * Returns absolute paths: [penultimate, latest] sorted ascending by filename.
 */
export function resolveLatestBaselinePair(
  baselinesDir: string = 'baselines',
): [string, string] | [null, string] {
  const dir = resolve(baselinesDir);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'schema.json' && f !== 'latest.json')
    .sort(); // ISO-date prefix sorts lexicographically === chronologically

  if (files.length === 0) {
    throw new Error(`No baseline files found in ${dir}`);
  }

  const latestFile = files[files.length - 1] as string;
  const penultimateFile = files.length >= 2 ? (files[files.length - 2] as string) : null;

  const latest = join(dir, latestFile);
  const penultimate = penultimateFile ? join(dir, penultimateFile) : null;
  return [penultimate, latest];
}

/**
 * Load and parse a MetricSnapshot from a JSON file path.
 */
export function loadSnapshot(filePath: string): MetricSnapshot {
  const abs = resolve(filePath);
  if (!existsSync(abs)) throw new Error(`Snapshot not found: ${abs}`);
  return JSON.parse(readFileSync(abs, 'utf-8')) as MetricSnapshot;
}

/**
 * Extract the headroom percentage from a MetricSnapshot.
 * Returns null when data is unavailable or ambiguous.
 */
function headroomPct(snap: MetricSnapshot): number | null {
  const entries = snap.contextWindowHeadroom;
  if (!entries || entries.length === 0) return null;
  const enabled = entries.filter(
    (e) => e.state === 'enabled' && e.contextWindow > 0 && e.status !== 'unknown',
  );
  if (enabled.length === 0) return null;
  const totalHeadroom = enabled.reduce((sum, e) => sum + e.headroomTokens, 0);
  const totalWindow = enabled.reduce((sum, e) => sum + e.contextWindow, 0);
  return Math.round((totalHeadroom / totalWindow) * 100);
}

/** Format an ISO timestamp as a short date (YYYY-MM-DD). */
function isoToDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Discord message content limit. */
const DISCORD_CONTENT_LIMIT = 2000;
const TRUNCATION_SUFFIX = '\n…(truncated — see baselines/ for full diff)';

/**
 * Truncate a message to fit within Discord's 2000-character content limit.
 * Appends a notice when truncation occurs.
 */
function truncateForDiscord(msg: string): string {
  if (msg.length <= DISCORD_CONTENT_LIMIT) return msg;
  const cutoff = DISCORD_CONTENT_LIMIT - TRUNCATION_SUFFIX.length;
  return msg.slice(0, cutoff) + TRUNCATION_SUFFIX;
}

/**
 * Build a compact Discord-ready digest message from two snapshots.
 *
 * When `prior` is null (only a single baseline exists) a "first capture" notice
 * is returned instead of a diff.
 *
 * @param current   - The latest snapshot.
 * @param prior     - The second-most-recent snapshot, or null if unavailable.
 * @param runDate   - ISO date string for the digest date (defaults to today).
 */
export function buildDigestMessage(
  current: MetricSnapshot,
  prior: MetricSnapshot | null,
  runDate?: string,
): string {
  const today = runDate ?? new Date().toISOString().slice(0, 10);
  const captureDate = isoToDate(current.capturedAt);

  const lines: string[] = [`📊 **CLI Wrapper Monitor — Weekly Digest** (${today})`];

  if (prior === null) {
    lines.push(`✅ First baseline captured (${captureDate}) — no prior snapshot to compare.`);
    lines.push(...buildMetricLines(current));
    return truncateForDiscord(lines.join('\n'));
  }

  const report = diffSnapshots(prior, current);
  lines.push(...buildStatusLine(report, captureDate, isoToDate(prior.capturedAt)));
  lines.push(...buildMetricLines(current, report));
  return truncateForDiscord(lines.join('\n'));
}

/**
 * Generate the status/header line and any regression details.
 */
function buildStatusLine(
  report: DiffReport,
  captureDate: string,
  priorDate: string,
): string[] {
  const lines: string[] = [];

  if (report.hasBreaking) {
    lines.push(`🔴 **BREAKING regressions detected** since last capture (${priorDate})`);
    for (const sb of report.structuralBreaks) {
      lines.push(`  • 🔴 ${sb}`);
    }
    for (const change of report.changes.filter((c) => c.severity === 'BREAKING')) {
      lines.push(`  • 🔴 ${change.experiment}/${change.metric}: ${change.deltaPct.toFixed(1)}%`);
    }
  } else if (
    report.severitySummary.warning > 0 ||
    report.warnings.length > 0
  ) {
    lines.push(`🟡 **Warnings detected** since last capture (${priorDate})`);
    for (const w of report.warnings) {
      lines.push(`  • 🟡 ${w}`);
    }
    for (const change of report.changes.filter((c) => c.severity === 'WARNING')) {
      lines.push(`  • 🟡 ${change.experiment}/${change.metric}: ${change.deltaPct.toFixed(1)}%`);
    }
  } else {
    lines.push(`✅ No regressions detected since last capture (${priorDate})`);
  }
  lines.push(`  Latest snapshot: ${captureDate}`);
  return lines;
}

/**
 * Generate bullet-point metric lines summarising the current snapshot.
 */
function buildMetricLines(
  current: MetricSnapshot,
  report?: DiffReport,
): string[] {
  const lines: string[] = [];
  const ctax = current.experiments['context-tax']?.metrics;

  const toolCount = ctax?.['toolCount']?.value;
  const modelCount = current.modelPool?.models.filter((m) => m.state === 'enabled').length;
  const hookCount = current.hookCount;
  const sysChars = ctax?.['systemPromptChars']?.value;
  const sysTokens = ctax?.['systemPromptTokensEstimated']?.value;
  const headroom = headroomPct(current);

  if (toolCount !== undefined) {
    const toolChanged =
      report?.toolSchemaChanges.some((c) => c.type === 'added' || c.type === 'removed') ||
      (report?.structuralBreaks.some((s) => s.includes('Tool count')) ?? false);
    const mark = toolChanged ? ' 🔄' : '';
    lines.push(`• Tools: ${toolCount}${mark}`);
  }

  if (modelCount !== undefined) {
    const modelChanged = (report?.modelPoolChanges.length ?? 0) > 0;
    const mark = modelChanged ? ' 🔄' : '';
    lines.push(`• Models (enabled): ${modelCount}${mark}`);
  }

  if (hookCount !== undefined) {
    const hookBodyChanged = report?.hookChanged ?? false;
    const mark = hookBodyChanged ? ' 🔄' : '';
    lines.push(`• Hooks: ${hookCount} (fingerprint${hookBodyChanged ? ' changed 🔄' : ' stable'})`);
  }

  if (sysChars !== undefined && sysTokens !== undefined) {
    const sysChanged = report?.systemPromptChanged ?? false;
    const mark = sysChanged ? ' 🔄' : '';
    lines.push(
      `• System prompt: ${sysChars.toLocaleString()} chars / ${sysTokens.toLocaleString()} tokens${mark}`,
    );
  }

  if (headroom !== null) {
    const above = headroom >= 50;
    const emoji = above ? '✅' : '⚠️';
    lines.push(`• Headroom: ${headroom}% (${above ? 'above' : 'below'} 50% threshold) ${emoji}`);
  }

  return lines;
}

/**
 * Run the digest end-to-end: find latest two baselines, diff, and return the
 * Discord message string.  Uses the provided baselines directory.
 */
export async function runWeeklyDigest(baselinesDir: string = 'baselines'): Promise<string> {
  const [priorPath, latestPath] = resolveLatestBaselinePair(baselinesDir);
  const current = loadSnapshot(latestPath);
  const prior = priorPath ? loadSnapshot(priorPath) : null;
  return buildDigestMessage(current, prior);
}
