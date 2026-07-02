#!/usr/bin/env npx ts-node --esm
/**
 * Generate a self-contained static HTML dashboard from all historical baselines.
 *
 * Usage:
 *   npx tsx scripts/generate-dashboard.ts [--output <path>]
 *   npm run dashboard
 *
 * Default output: reports/dashboard.html
 * The file can be opened in any browser, emailed, or linked from the README.
 * No external dependencies — pure HTML/CSS/inline SVG.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, lstatSync, mkdirSync } from "fs";
import { resolve, join, dirname } from "path";
import type { MetricSnapshot } from "../src/harness/types.js";
import { validateBaselineFile } from "../src/harness/validator.js";
import {
  extractSummaryCard,
  extractToolCountSeries,
  extractSystemPromptTokensSeries,
  extractInjectionRefusalSeries,
  extractRegressions,
  extractModelPoolHistory,
  generateSparklineSVG,
  type SummaryCardData,
  type RegressionEntry,
  type ModelPoolEntry,
  type SparklinePoint,
} from "../src/harness/dashboard.js";

// ---------------------------------------------------------------------------
// Baseline loader (mirrors trend-report.ts)
// ---------------------------------------------------------------------------

function collectJsonFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      results.push(...collectJsonFiles(full));
    } else if (entry.endsWith(".json") && entry !== "schema.json" && entry !== "latest.json") {
      results.push(full);
    }
  }
  return results;
}

function loadAll(dir: string): MetricSnapshot[] {
  const absDir = resolve(dir);
  if (!existsSync(absDir)) {
    throw new Error(`Baselines directory not found: ${absDir}`);
  }

  const files = readdirSync(absDir)
    .filter((f) => {
      if (!f.endsWith(".json") || f === "schema.json" || f === "latest.json") return false;
      // Skip symlinks at the root baselines/ dir (consistent with collectJsonFiles)
      const st = lstatSync(join(absDir, f));
      return !st.isSymbolicLink() && st.isFile();
    })
    .sort();

  let anyInvalid = false;
  for (const f of files) {
    const filePath = join(absDir, f);
    const result = validateBaselineFile(filePath);
    if (!result.valid) {
      anyInvalid = true;
      console.error(`Error: baseline integrity check failed for ${f}:`);
      for (const err of result.errors) console.error(`  [${err.field}] ${err.message}`);
    }
  }

  const archivedFilePaths = collectJsonFiles(join(absDir, "archive"));
  for (const filePath of archivedFilePaths) {
    const result = validateBaselineFile(filePath);
    if (!result.valid) {
      anyInvalid = true;
      console.error(`Error: baseline integrity check failed for ${filePath}:`);
      for (const err of result.errors) console.error(`  [${err.field}] ${err.message}`);
    }
  }

  if (anyInvalid) {
    console.error("Aborting dashboard: one or more baseline files are invalid.");
    process.exit(1);
  }

  const snapshots: MetricSnapshot[] = [
    ...files.map((f) => JSON.parse(readFileSync(join(absDir, f), "utf-8")) as MetricSnapshot),
    ...archivedFilePaths.map((p) => JSON.parse(readFileSync(p, "utf-8")) as MetricSnapshot),
  ];

  const seen = new Set<string>();
  const deduped = snapshots.filter((s) => {
    if (seen.has(s.capturedAt)) return false;
    seen.add(s.capturedAt);
    return true;
  });

  // Include latest.json if not already represented
  const latestPath = join(absDir, "latest.json");
  if (existsSync(latestPath)) {
    const latestResult = validateBaselineFile(latestPath);
    if (!latestResult.valid) {
      console.error("Error: baseline integrity check failed for latest.json:");
      for (const err of latestResult.errors) console.error(`  [${err.field}] ${err.message}`);
      console.error("Aborting dashboard: latest.json is invalid.");
      process.exit(1);
    }
    const latest = JSON.parse(readFileSync(latestPath, "utf-8")) as MetricSnapshot;
    if (!deduped.some((s) => s.capturedAt === latest.capturedAt)) {
      deduped.push(latest);
    }
  }

  return deduped.sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime()
  );
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function esc(s: string | number | null | undefined): string {
  if (s == null) return "—";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtNum(v: number | null): string {
  if (v === null) return "—";
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtPct(v: number | null, decimals = 1): string {
  if (v === null) return "—";
  return `${v.toFixed(decimals)}%`;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderSummaryCard(card: SummaryCardData): string {
  const headroomDisplay = card.headroomPct !== null ? fmtPct(card.headroomPct) : "—";
  const hookDisplay = card.hookCount !== null ? String(card.hookCount) : "—";

  return `
<section class="section summary-section">
  <h2>📊 Summary</h2>
  <div class="card-grid">
    <div class="card">
      <div class="card-label">Baseline Date</div>
      <div class="card-value">${esc(card.date)}</div>
    </div>
    <div class="card">
      <div class="card-label">Model</div>
      <div class="card-value model-value">${esc(card.model)}</div>
    </div>
    <div class="card">
      <div class="card-label">SDK Version</div>
      <div class="card-value">${esc(card.sdkVersion)}</div>
    </div>
    <div class="card">
      <div class="card-label">Tool Count</div>
      <div class="card-value highlight">${fmtNum(card.toolCount)}</div>
    </div>
    <div class="card">
      <div class="card-label">Hook Count</div>
      <div class="card-value">${esc(hookDisplay)}</div>
    </div>
    <div class="card">
      <div class="card-label">System Prompt</div>
      <div class="card-value">${fmtNum(card.systemPromptChars)} chars</div>
    </div>
    <div class="card">
      <div class="card-label">Est. Tokens</div>
      <div class="card-value">${fmtNum(card.systemPromptTokens)}</div>
    </div>
    <div class="card">
      <div class="card-label">Context Headroom</div>
      <div class="card-value ${card.headroomPct === null ? "" : card.headroomPct < 20 ? "danger" : card.headroomPct < 40 ? "warning" : "ok"}">${headroomDisplay}</div>
    </div>
  </div>
</section>`;
}

function renderSparklines(
  toolSeries: SparklinePoint[],
  tokensSeries: SparklinePoint[],
  injectionSeries: SparklinePoint[]
): string {
  const toolSvg = generateSparklineSVG(toolSeries, {
    strokeColor: "#e67e22",
    label: "Tool Count over time",
    formatValue: (v) => Math.round(v).toString(),
  });
  const tokensSvg = generateSparklineSVG(tokensSeries, {
    strokeColor: "#2980b9",
    label: "System Prompt Tokens (est.) over time",
    formatValue: (v) => `${Math.round(v / 1000)}k`,
  });

  const hasInjectionData = injectionSeries.some((p) => p.value !== null);
  const injectionSvg = hasInjectionData
    ? generateSparklineSVG(injectionSeries, {
        strokeColor: "#27ae60",
        label: "Injection Refusal Rate over time",
        formatValue: (v) => `${(v * 100).toFixed(1)}%`,
      })
    : `<div class="no-data">No injection refusal data available in current baselines.</div>`;

  return `
<section class="section sparklines-section">
  <h2>📈 Trend Sparklines</h2>
  <div class="sparkline-grid">
    <div class="sparkline-card">
      ${toolSvg}
    </div>
    <div class="sparkline-card">
      ${tokensSvg}
    </div>
    <div class="sparkline-card">
      ${injectionSvg}
    </div>
  </div>
</section>`;
}

function renderRegressionTimeline(regressions: RegressionEntry[], snapshotCount: number): string {
  if (regressions.length === 0) {
    return `
<section class="section regressions-section">
  <h2>📋 Regression Timeline</h2>
  <p class="no-data">No BREAKING or WARNING regressions detected across ${snapshotCount} snapshot${snapshotCount !== 1 ? "s" : ""}. ✅</p>
</section>`;
  }

  const rows = regressions.map((r) => `
    <tr>
      <td class="date-cell">${esc(r.date)}</td>
      <td><span class="badge badge-${r.severity.toLowerCase()}">${esc(r.severity)}</span></td>
      <td class="description-cell">${esc(r.description)}</td>
    </tr>`).join("");

  return `
<section class="section regressions-section">
  <h2>📋 Regression Timeline</h2>
  <p class="subtitle">${regressions.length} event${regressions.length !== 1 ? "s" : ""} detected across ${snapshotCount} snapshot${snapshotCount !== 1 ? "s" : ""}</p>
  <div class="table-wrapper">
    <table class="regression-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Severity</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
</section>`;
}

function renderModelPool(models: ModelPoolEntry[], snapshotCount: number): string {
  if (models.length === 0) {
    return `
<section class="section model-pool-section">
  <h2>🤖 Model Pool</h2>
  <p class="no-data">No model pool data available in current baselines. Model pool tracking requires baselines captured with <code>capture-autogent-baseline.ts</code> v2+.</p>
</section>`;
  }

  const active = models.filter((m) => m.lastSeen === null);
  const retired = models.filter((m) => m.lastSeen !== null);

  const modelRows = (entries: ModelPoolEntry[], showRemoved: boolean) =>
    entries.map((m) => `
    <tr>
      <td class="model-id">${esc(m.id)}</td>
      <td><span class="badge badge-${m.state}">${esc(m.state)}</span></td>
      <td>${m.contextWindow > 0 ? fmtNum(m.contextWindow) + " ctx" : "—"}</td>
      <td>${esc(m.firstSeen)}</td>
      ${showRemoved ? `<td class="date-removed">${esc(m.lastSeen)}</td>` : ""}
    </tr>`).join("");

  const activeSection = active.length > 0 ? `
  <h3>Active Models (${active.length})</h3>
  <div class="table-wrapper">
    <table class="model-table">
      <thead><tr><th>Model</th><th>State</th><th>Context</th><th>First Seen</th></tr></thead>
      <tbody>${modelRows(active, false)}</tbody>
    </table>
  </div>` : "";

  const retiredSection = retired.length > 0 ? `
  <h3>Retired Models (${retired.length})</h3>
  <div class="table-wrapper">
    <table class="model-table">
      <thead><tr><th>Model</th><th>Last State</th><th>Context</th><th>First Seen</th><th>Last Seen</th></tr></thead>
      <tbody>${modelRows(retired, true)}</tbody>
    </table>
  </div>` : "";

  return `
<section class="section model-pool-section">
  <h2>🤖 Model Pool</h2>
  ${activeSection}
  ${retiredSection}
</section>`;
}

// ---------------------------------------------------------------------------
// Full HTML generation
// ---------------------------------------------------------------------------

function generateDashboardHTML(snapshots: MetricSnapshot[]): string {
  const generatedAt = new Date().toISOString();
  const snapshotCount = snapshots.length;
  const dateRange = snapshotCount > 0
    ? `${snapshots[0].capturedAt.slice(0, 10)} → ${snapshots[snapshotCount - 1].capturedAt.slice(0, 10)}`
    : "—";

  const card = extractSummaryCard(snapshots);
  const toolSeries = extractToolCountSeries(snapshots);
  const tokensSeries = extractSystemPromptTokensSeries(snapshots);
  const injectionSeries = extractInjectionRefusalSeries(snapshots);
  const regressions = extractRegressions(snapshots);
  const modelHistory = extractModelPoolHistory(snapshots);

  const summarySection = card ? renderSummaryCard(card) : `<section class="section"><p class="no-data">No baseline data available.</p></section>`;
  const sparklinesSection = renderSparklines(toolSeries, tokensSeries, injectionSeries);
  const regressionsSection = renderRegressionTimeline(regressions, snapshotCount);
  const modelPoolSection = renderModelPool(modelHistory, snapshotCount);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Copilot CLI Wrapper Monitor — Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }

    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      margin: 0;
      padding: 0;
      background: #f0f2f5;
      color: #1a1a2e;
      line-height: 1.5;
    }

    header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      padding: 32px 40px 24px;
      border-bottom: 3px solid #2980b9;
    }

    header h1 {
      margin: 0 0 6px;
      font-size: 1.6rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    header .meta {
      font-size: 0.85rem;
      opacity: 0.7;
    }

    main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 32px 24px;
    }

    .section {
      background: #fff;
      border-radius: 10px;
      padding: 28px 32px;
      margin-bottom: 24px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }

    .section h2 {
      margin: 0 0 20px;
      font-size: 1.15rem;
      font-weight: 700;
      color: #1a1a2e;
      border-bottom: 2px solid #f0f2f5;
      padding-bottom: 10px;
    }

    .section h3 {
      margin: 20px 0 12px;
      font-size: 0.95rem;
      font-weight: 600;
      color: #444;
    }

    /* Summary card grid */
    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px;
    }

    .card {
      background: #f8f9fa;
      border: 1px solid #e9ecef;
      border-radius: 8px;
      padding: 14px 16px;
    }

    .card-label {
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #888;
      margin-bottom: 4px;
    }

    .card-value {
      font-size: 1.05rem;
      font-weight: 700;
      color: #1a1a2e;
      word-break: break-word;
    }

    .card-value.model-value {
      font-size: 0.8rem;
    }

    .card-value.highlight { color: #2980b9; }
    .card-value.danger   { color: #e74c3c; }
    .card-value.warning  { color: #e67e22; }
    .card-value.ok       { color: #27ae60; }

    /* Sparklines */
    .sparkline-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
    }

    .sparkline-card {
      border: 1px solid #e9ecef;
      border-radius: 8px;
      overflow: hidden;
    }

    .sparkline-card svg {
      display: block;
      width: 100%;
      height: auto;
    }

    /* Badges */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .badge-breaking { background: #fde8e8; color: #c0392b; }
    .badge-warning  { background: #fef3cd; color: #9a6200; }
    .badge-enabled  { background: #d5f5e3; color: #1e8449; }
    .badge-disabled { background: #fde8e8; color: #c0392b; }
    .badge-unconfigured { background: #eaf0fb; color: #2980b9; }

    /* Tables */
    .table-wrapper { overflow-x: auto; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.88rem;
    }

    thead th {
      background: #f8f9fa;
      border-bottom: 2px solid #e9ecef;
      padding: 10px 14px;
      text-align: left;
      font-weight: 600;
      color: #555;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    tbody td {
      padding: 10px 14px;
      border-bottom: 1px solid #f0f2f5;
      vertical-align: middle;
    }

    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: #f8f9fa; }

    td.date-cell { white-space: nowrap; font-family: monospace; font-size: 0.82rem; }
    td.description-cell { font-family: monospace; font-size: 0.82rem; }
    td.date-removed { color: #e74c3c; }
    td.model-id { font-family: monospace; font-size: 0.82rem; }

    /* Misc */
    .subtitle { margin: -12px 0 16px; font-size: 0.85rem; color: #888; }

    .no-data {
      color: #888;
      font-style: italic;
      padding: 12px 0;
      margin: 0;
    }

    code {
      background: #f0f2f5;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 0.9em;
    }

    footer {
      text-align: center;
      padding: 24px;
      font-size: 0.78rem;
      color: #aaa;
    }

    footer a { color: #2980b9; text-decoration: none; }
  </style>
</head>
<body>
  <header>
    <h1>🔍 Copilot CLI Wrapper Monitor — Dashboard</h1>
    <div class="meta">
      ${snapshotCount} snapshot${snapshotCount !== 1 ? "s" : ""} · ${dateRange} · Generated ${generatedAt.slice(0, 19).replace("T", " ")} UTC
    </div>
  </header>

  <main>
    ${summarySection}
    ${sparklinesSection}
    ${regressionsSection}
    ${modelPoolSection}
  </main>

  <footer>
    Generated by <a href="https://github.com/copilot-autogent/cli-wrapper-monitor">cli-wrapper-monitor</a> ·
    Zero external dependencies · Pure HTML/CSS/inline SVG
  </footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  let output = "reports/dashboard.html";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) {
        console.error(`Error: --output requires a path argument`);
        process.exit(1);
      }
      output = args[++i];
    }
  }

  const snapshots = loadAll("baselines");
  console.log(`Loaded ${snapshots.length} baseline snapshot${snapshots.length !== 1 ? "s" : ""}`);
  for (const s of snapshots) {
    const date = s.capturedAt.slice(0, 10);
    const toolCount = s.experiments?.["context-tax"]?.metrics?.["toolCount"]?.value ?? "—";
    console.log(`  ${date}  tools=${toolCount}  model=${s.model}`);
  }

  const html = generateDashboardHTML(snapshots);

  const outPath = resolve(output);
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  writeFileSync(outPath, html, "utf-8");
  console.log(`\nDashboard written to: ${outPath}`);
}

main();
