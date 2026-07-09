import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MetricSnapshot, PromptSectionChange } from './types.js';
import { diffSnapshots } from './diff.js';
import type { DiffReport } from './types.js';
import { diffPromptSectionTexts } from './prompt-sections.js';
import {
  buildDriftMagnitude,
  classifyDigestTier,
} from './digest-tier.js';
import type { DigestTierConfig, DigestTier } from './digest-tier.js';

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
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f !== 'schema.json' && f !== 'latest.json')
      .sort(); // ISO-date prefix sorts lexicographically === chronologically
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Baselines directory not found: ${dir}`);
    }
    throw err;
  }

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

/** Maximum number of changed sections to show before truncating with "…and N more". */
const MAX_SECTION_ENTRIES = 5;

/**
 * Format a single section's size change as a compact string.
 * E.g. "+1,234 chars (+5.2%)" or "-500 chars (-2.0%)" or "new" or "removed"
 */
function formatSectionChange(change: PromptSectionChange): string {
  if (change.baselineCharCount === null) {
    // New section: show size only when non-zero to avoid "new (+0 chars)" noise
    if (change.deltaAbsolute === 0) return 'new';
    // Use Math.abs — a "new" section always grows from 0, delta is always positive
    return `new (+${Math.abs(change.deltaAbsolute).toLocaleString('en-US')} chars)`;
  }
  if (change.currentCharCount === null) return 'removed';
  const charSign = change.deltaAbsolute >= 0 ? '+' : '';
  const absStr = `${charSign}${change.deltaAbsolute.toLocaleString('en-US')} chars`;
  if (change.deltaPct !== null && isFinite(change.deltaPct)) {
    // Skip the percentage for non-finite values (e.g. Infinity when baseline charCount was 0)
    const pctSign = change.deltaPct >= 0 ? '+' : '';
    return `${absStr} (${pctSign}${change.deltaPct.toFixed(1)}%)`;
  }
  return absStr;
}

/** Sanitize a section name for safe Discord embedding (strip @-mentions, newlines, Markdown). */
function sanitizeSectionName(name: string): string {
  return name
    .replace(/@/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[`*_~|]/g, '')
    .trim();
}

/**
 * Build the optional "Section changes:" block for the digest.
 *
 * Uses char-count deltas from the DiffReport and, when section text is available
 * (capturePromptSectionText=true), also surfaces same-size rewrites via
 * line-level text diffs (diffPromptSectionTexts).
 *
 * Returns an empty array when sections are unavailable or unchanged.
 */
function buildSectionChangesBlock(
  report: DiffReport,
  prior: MetricSnapshot,
  current: MetricSnapshot,
): string[] {
  if (!report.promptSectionsAvailable) return [];

  // Sections with a non-zero char-count delta OR a null side (section added/removed)
  const sizeChanges = report.promptSectionChanges.filter(
    (c) => c.deltaAbsolute !== 0 || c.baselineCharCount === null || c.currentCharCount === null,
  );
  const sizeChangeNames = new Set(sizeChanges.map((c) => c.name));

  // Additionally detect same-size rewrites via line-level text diffs (when text captured)
  // diffPromptSectionTexts accepts undefined/null for either side — handled defensively.
  const textDiffs = diffPromptSectionTexts(prior.promptSections, current.promptSections, 5);
  const rewriteEntries: Array<{ name: string; label: string; magnitude: number }> = [];
  for (const [name, td] of textDiffs) {
    if (sizeChangeNames.has(name)) continue; // already covered
    if (!td.unavailable && td.totalChangedLines > 0) {
      rewriteEntries.push({
        name: sanitizeSectionName(name),
        label: 'same size, text rewritten',
        magnitude: td.totalChangedLines, // use line count as relevance signal
      });
    }
  }

  const allChanges: Array<{ name: string; label: string; magnitude: number }> = [
    ...sizeChanges.map((c) => ({
      name: sanitizeSectionName(c.name),
      label: formatSectionChange(c),
      magnitude: Math.abs(c.deltaAbsolute),
    })),
    ...rewriteEntries,
  ];

  // Sort by magnitude descending so the most significant changes appear first
  allChanges.sort((a, b) => b.magnitude - a.magnitude);

  if (allChanges.length === 0) return [];

  const lines: string[] = ['**Section changes:**'];
  const toShow = allChanges.slice(0, MAX_SECTION_ENTRIES);
  const extra = allChanges.length - MAX_SECTION_ENTRIES;

  for (const { name, label } of toShow) {
    lines.push(`  • ${name}: ${label}`);
  }
  if (extra > 0) {
    lines.push(`  …and ${extra} more section${extra > 1 ? 's' : ''} changed`);
  }

  return lines;
}

/**
 * Build a compact Discord-ready digest message from two snapshots.
 *
 * When `tierConfig` is provided, drift-magnitude tiering is applied:
 *   - 'alert': 🚨 ALERT header + full section-changes + probe breakdown
 *   - 'change': current format (unchanged)
 *   - 'stable': single-line "✅ Stable — no significant changes detected (YYYY-MM-DD)"
 *
 * When `tierConfig` is absent the function behaves exactly as before
 * (defaults to CHANGE-level verbosity for backward compatibility).
 *
 * @param current    - The latest snapshot.
 * @param prior      - The second-most-recent snapshot, or null if unavailable.
 * @param runDate    - ISO date string for the digest date (defaults to today).
 * @param tierConfig - Optional tier-threshold config from capture.config.json.
 * @returns          `{ message, tier }` — tier is null when prior is null (first capture).
 */
export function buildDigestMessage(
  current: MetricSnapshot,
  prior: MetricSnapshot | null,
  runDate?: string,
  tierConfig?: DigestTierConfig,
): { message: string; tier: DigestTier | null } {
  const today = runDate ?? new Date().toISOString().slice(0, 10);
  const captureDate = isoToDate(current.capturedAt);

  const lines: string[] = [`📊 **CLI Wrapper Monitor — Weekly Digest** (${today})`];

  if (prior === null) {
    lines.push(`✅ First baseline captured (${captureDate}) — no prior snapshot to compare.`);
    lines.push(...buildMetricLines(current));
    return { message: truncateForDiscord(lines.join('\n')), tier: null };
  }

  const report = diffSnapshots(prior, current);
  const magnitude = buildDriftMagnitude(report);
  const tier = classifyDigestTier(magnitude, tierConfig);

  // STABLE: collapse to a single line
  if (tier === 'stable') {
    const stableLine = `✅ Stable — no significant changes detected (${today})`;
    return { message: truncateForDiscord(stableLine), tier };
  }

  // ALERT: prepend 🚨 header + include section changes + probe breakdown
  if (tier === 'alert') {
    lines[0] = `🚨 **ALERT — CLI Wrapper Monitor — Weekly Digest** (${today})`;
    lines.push(...buildStatusLine(report, captureDate, isoToDate(prior.capturedAt)));
    lines.push(...buildMetricLines(current, report));
    lines.push(...buildSectionChangesBlock(report, prior, current));
    lines.push(...buildProbeBreakdown(report));
    return { message: truncateForDiscord(lines.join('\n')), tier };
  }

  // CHANGE: current format (unchanged)
  lines.push(...buildStatusLine(report, captureDate, isoToDate(prior.capturedAt)));
  lines.push(...buildMetricLines(current, report));
  lines.push(...buildSectionChangesBlock(report, prior, current));
  return { message: truncateForDiscord(lines.join('\n')), tier };
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
 * Build a probe-refusal breakdown block for ALERT-tier digests.
 *
 * Surfaces the injection-refusal rate delta from any experiment that carries
 * an `injectionRefusedRate` metric, so the reader can see exactly which
 * experiment drove the ALERT.
 *
 * Returns an empty array when no relevant probe data is available.
 */
function buildProbeBreakdown(report: DiffReport): string[] {
  const lines: string[] = [];
  let found = false;

  for (const [expName, baselineExp] of Object.entries(report.baseline.experiments ?? {})) {
    const currentExp = report.current.experiments?.[expName];
    if (!currentExp) continue;
    const baselineRate = baselineExp.metrics?.['injectionRefusedRate']?.value;
    const currentRate = currentExp.metrics?.['injectionRefusedRate']?.value;
    if (baselineRate === undefined || currentRate === undefined) continue;
    if (!found) {
      lines.push('**Probe breakdown:**');
      found = true;
    }
    const dropPp = (baselineRate - currentRate) * 100;
    const sign = dropPp > 0 ? '-' : '+';
    const absVal = Math.abs(dropPp).toFixed(1);
    const marker = dropPp > 0 ? ' ⬇️' : '';
    lines.push(
      `  • ${expName}/injectionRefusedRate: ${(currentRate * 100).toFixed(1)}% (${sign}${absVal} pp${marker})`,
    );
  }

  return lines;
}


/**
 * Run the digest end-to-end: find latest two baselines, diff, and return the
 * Discord message string and tier.  Uses the provided baselines directory.
 *
 * @param baselinesDir - Directory containing baseline JSON files.
 * @param tierConfig   - Optional tier-threshold config from capture.config.json.
 * @returns `{ message, tier }` — tier is null when there is no prior snapshot.
 */
export function runWeeklyDigest(
  baselinesDir: string = 'baselines',
  tierConfig?: DigestTierConfig,
): { message: string; tier: DigestTier | null } {
  const [priorPath, latestPath] = resolveLatestBaselinePair(baselinesDir);
  const current = loadSnapshot(latestPath);
  const prior = priorPath ? loadSnapshot(priorPath) : null;
  return buildDigestMessage(current, prior, undefined, tierConfig);
}
