#!/usr/bin/env -S npx tsx
/**
 * Generate a static SVG trend chart from all historical baseline JSON files.
 *
 * Plots system prompt size (chars) and tool count over time, with
 * annotations for key structural events.
 *
 * Usage:
 *   npx tsx scripts/generate-chart.ts [--output <path>]
 *   npm run chart
 *
 * Default output: chart.svg (repo root)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { resolve, join } from "path";
import type { MetricSnapshot } from "../src/harness/types.js";

interface DataPoint {
  date: Date;
  label: string;
  systemPromptChars: number;
  toolCount: number;
}

// Key events derived from baseline notes and known project history.
// series: "prompt" → annotation anchors to the prompt data point
//         "tools"  → annotation anchors to the tool-count data point
const EVENT_LABELS: Array<{ dateStr: string; label: string; series: "prompt" | "tools" }> = [
  { dateStr: "2026-05-31", label: "Untruncation fix\n(+108% prompt)", series: "prompt" },
  { dateStr: "2026-06-03", label: "Tool count\n\u221250%", series: "tools" },
  { dateStr: "2026-06-16", label: "autogent#571\nPLAYBOOK migration", series: "prompt" },
];

function loadDataPoints(dir: string): DataPoint[] {
  const absDir = resolve(dir);
  if (!existsSync(absDir)) throw new Error(`Directory not found: ${absDir}`);

  const files = readdirSync(absDir)
    .filter(
      (f) =>
        f.endsWith(".json") &&
        f !== "schema.json" &&
        f !== "latest.json" &&
        !f.startsWith("pre-capture")
    )
    .sort();

  const seen = new Set<string>();
  const points: DataPoint[] = [];

  for (const f of files) {
    const snap = JSON.parse(readFileSync(join(absDir, f), "utf-8")) as MetricSnapshot;

    const exp = snap.experiments?.["context-tax"];
    if (!exp) continue;

    if (seen.has(snap.capturedAt)) continue;
    seen.add(snap.capturedAt);

    const m = exp.metrics;
    const systemPromptChars = m["systemPromptChars"]?.value;
    const toolCount = m["toolCount"]?.value;
    // Skip baselines that lack the key metrics (e.g. schema-drifted or
    // partial captures) rather than silently plotting a misleading zero.
    if (systemPromptChars == null || toolCount == null) continue;

    const ts = typeof snap.capturedAt === "string" ? snap.capturedAt : String(snap.capturedAt);
    const parsedDate = new Date(ts);
    if (isNaN(parsedDate.getTime())) {
      console.warn(`Skipping ${f}: invalid capturedAt "${ts}"`);
      continue;
    }

    points.push({
      date: parsedDate,
      label: ts.slice(0, 10),
      systemPromptChars,
      toolCount,
    });
  }

  // `latest.json` is the rolling "current state" pointer and changes
  // timestamp when it advances, which would make historical chart diffs
  // non-reproducible. Exclude it — dated baseline files are the canonical
  // historical record.

  return points.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function niceMax(rawMax: number, step: number): number {
  if (rawMax === 0 || step === 0) return step > 0 ? step : 1;
  return Math.ceil(rawMax / step) * step;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtNum(v: number): string {
  // Locale-independent formatting: 56963 → "56,963"
  const s = Math.round(v).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function generateSVG(points: DataPoint[]): string {
  if (points.length === 0) throw new Error("No data points to chart.");

  // Chart dimensions
  const W = 900;
  const H = 480;
  const ML = 85;  // margin left
  const MR = 75;  // margin right
  const MT = 70;  // margin top
  const MB = 95;  // margin bottom
  const PW = W - ML - MR;
  const PH = H - MT - MB;

  const dates = points.map((p) => p.date.getTime());
  const minDate = Math.min(...dates);
  const maxDate = Math.max(...dates);
  const dateRange = maxDate - minDate || 1;

  const promptMax = niceMax(Math.max(...points.map((p) => p.systemPromptChars)), 50000);
  const toolsMax = niceMax(Math.max(...points.map((p) => p.toolCount)), 5);

  const xOf = (d: Date): number => ML + ((d.getTime() - minDate) / dateRange) * PW;
  const yOfPrompt = (v: number): number => MT + PH - (v / promptMax) * PH;
  const yOfTools = (v: number): number => MT + PH - (v / toolsMax) * PH;

  const fmtK = (v: number): string =>
    v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`;

  const lines: string[] = [];
  const push = (...args: string[]) => lines.push(...args);

  // ── SVG root ──────────────────────────────────────────────────────────────
  push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ` +
    `width="${W}" height="${H}" font-family="system-ui,-apple-system,sans-serif">`
  );

  // ── Background ────────────────────────────────────────────────────────────
  push(`<rect width="${W}" height="${H}" fill="#ffffff" rx="10"/>`);
  push(
    `<rect x="${ML}" y="${MT}" width="${PW}" height="${PH}" fill="#f8f9fa" rx="3" ` +
    `stroke="#e9ecef" stroke-width="1"/>`
  );

  // ── Title ─────────────────────────────────────────────────────────────────
  push(
    `<text x="${W / 2}" y="28" text-anchor="middle" font-size="16" font-weight="700" ` +
    `fill="#1a1a2e">Copilot CLI Wrapper — Historical Trend</text>`,
    `<text x="${W / 2}" y="48" text-anchor="middle" font-size="11" fill="#666">` +
    `System prompt size and tool count, ${points[0].label} → ${points[points.length - 1].label}` +
    `</text>`
  );

  // ── Horizontal grid lines + left Y-axis labels ─────────────────────────────
  const promptTicks = 5;
  for (let i = 0; i <= promptTicks; i++) {
    const y = MT + (PH * i) / promptTicks;
    const v = promptMax * (1 - i / promptTicks);
    push(
      `<line x1="${ML}" y1="${y.toFixed(1)}" x2="${ML + PW}" y2="${y.toFixed(1)}" ` +
      `stroke="${i === promptTicks ? "#888" : "#dee2e6"}" stroke-width="${i === promptTicks ? 1.5 : 1}"/>`
    );
    push(
      `<text x="${ML - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" ` +
      `font-size="10" fill="#495057">${fmtK(v)}</text>`
    );
  }

  // ── Right Y-axis labels (tool count) ──────────────────────────────────────
  const toolTicks = toolsMax <= 10 ? toolsMax : 5;
  for (let i = 0; i <= toolTicks; i++) {
    const y = MT + (PH * i) / toolTicks;
    const v = toolsMax * (1 - i / toolTicks);
    push(
      `<text x="${ML + PW + 7}" y="${(y + 4).toFixed(1)}" text-anchor="start" ` +
      `font-size="10" fill="#e67e22">${v.toFixed(0)}</text>`
    );
  }

  // ── Axis labels ────────────────────────────────────────────────────────────
  const midY = (MT + MT + PH) / 2;
  push(
    `<text x="${ML - 60}" y="${midY.toFixed(1)}" text-anchor="middle" font-size="11" ` +
    `fill="#2980b9" transform="rotate(-90 ${(ML - 60).toFixed(1)} ${midY.toFixed(1)})">` +
    `System Prompt (chars)</text>`,
    `<text x="${ML + PW + 58}" y="${midY.toFixed(1)}" text-anchor="middle" font-size="11" ` +
    `fill="#e67e22" transform="rotate(90 ${(ML + PW + 58).toFixed(1)} ${midY.toFixed(1)})">` +
    `Tool Count</text>`
  );

  // ── X-axis ticks + labels ──────────────────────────────────────────────────
  const baseline = MT + PH;
  for (const p of points) {
    const x = xOf(p.date);
    push(
      `<line x1="${x.toFixed(1)}" y1="${baseline}" x2="${x.toFixed(1)}" ` +
      `y2="${(baseline + 6).toFixed(1)}" stroke="#888" stroke-width="1"/>`,
      `<text x="${x.toFixed(1)}" y="${(baseline + 20).toFixed(1)}" ` +
      `text-anchor="end" font-size="9.5" fill="#555" ` +
      `transform="rotate(-40 ${x.toFixed(1)} ${(baseline + 20).toFixed(1)})">${p.label}</text>`
    );
  }

  // ── Border axes ───────────────────────────────────────────────────────────
  push(
    `<line x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + PH}" stroke="#888" stroke-width="1.5"/>`,
    `<line x1="${ML + PW}" y1="${MT}" x2="${ML + PW}" y2="${MT + PH}" ` +
    `stroke="#e67e22" stroke-width="1.5"/>`
  );

  // ── System prompt line ────────────────────────────────────────────────────
  const promptPath = points
    .map((p, i) =>
      `${i === 0 ? "M" : "L"}${xOf(p.date).toFixed(1)},${yOfPrompt(p.systemPromptChars).toFixed(1)}`
    )
    .join(" ");
  push(
    `<path d="${promptPath}" fill="none" stroke="#2980b9" stroke-width="2.5" ` +
    `stroke-linejoin="round" stroke-linecap="round"/>`,
    // Area fill under prompt line
    `<path d="${promptPath} L${(ML + PW).toFixed(1)},${(MT + PH).toFixed(1)} L${ML},${(MT + PH).toFixed(1)} Z" ` +
    `fill="#2980b9" fill-opacity="0.06"/>`
  );

  // ── Tool count line ───────────────────────────────────────────────────────
  const toolPath = points
    .map((p, i) =>
      `${i === 0 ? "M" : "L"}${xOf(p.date).toFixed(1)},${yOfTools(p.toolCount).toFixed(1)}`
    )
    .join(" ");
  push(
    `<path d="${toolPath}" fill="none" stroke="#e67e22" stroke-width="2.5" ` +
    `stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="7 4"/>`
  );

  // ── Data point dots ───────────────────────────────────────────────────────
  for (const p of points) {
    const x = xOf(p.date).toFixed(1);
    push(
      `<circle cx="${x}" cy="${yOfPrompt(p.systemPromptChars).toFixed(1)}" r="5" ` +
      `fill="#2980b9" stroke="#fff" stroke-width="2">` +
      `<title>${p.label}: ${fmtNum(p.systemPromptChars)} chars</title></circle>`,
      `<circle cx="${x}" cy="${yOfTools(p.toolCount).toFixed(1)}" r="5" ` +
      `fill="#e67e22" stroke="#fff" stroke-width="2">` +
      `<title>${p.label}: ${p.toolCount} tools</title></circle>`
    );
  }

  // ── Event annotations ─────────────────────────────────────────────────────
  for (const { dateStr, label: annLabel, series } of EVENT_LABELS) {
    const match = points.find((p) => p.label === dateStr);
    if (!match) continue;

    const px = xOf(match.date);
    // Anchor Y to the series the annotation describes
    const py = series === "tools" ? yOfTools(match.toolCount) : yOfPrompt(match.systemPromptChars);
    const textLines = annLabel.split("\n");
    const charWidth = 6.5;
    const lineH = 14;
    const boxW = Math.max(...textLines.map((l) => l.length)) * charWidth + 16;
    const boxH = textLines.length * lineH + 10;

    // Position box above the dot with some offset; clamp to chart bounds
    let boxX = px - boxW / 2;
    let boxY = py - boxH - 18;

    if (boxX < ML + 2) boxX = ML + 2;
    if (boxX + boxW > ML + PW - 2) boxX = ML + PW - 2 - boxW;
    if (boxY < MT + 2) boxY = MT + 2;

    // Connector line
    push(
      `<line x1="${px.toFixed(1)}" y1="${(py - 7).toFixed(1)}" ` +
      `x2="${px.toFixed(1)}" y2="${(boxY + boxH).toFixed(1)}" ` +
      `stroke="#9b59b6" stroke-width="1" stroke-dasharray="4 2"/>`
    );
    // Box
    push(
      `<rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" ` +
      `width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" ` +
      `fill="#f5eeff" stroke="#9b59b6" stroke-width="1" rx="4"/>`
    );
    for (let i = 0; i < textLines.length; i++) {
      const ty = boxY + 9 + i * lineH;
      push(
        `<text x="${(boxX + boxW / 2).toFixed(1)}" y="${ty.toFixed(1)}" ` +
        `text-anchor="middle" font-size="9.5" fill="#6c3483">${xmlEscape(textLines[i])}</text>`
      );
    }
  }

  // ── Legend ────────────────────────────────────────────────────────────────
  const lx = ML + 8;
  const ly = MT + 8;
  const lw = 220;
  const lh = 46;
  push(
    `<rect x="${lx}" y="${ly}" width="${lw}" height="${lh}" fill="white" ` +
    `fill-opacity="0.9" stroke="#dee2e6" stroke-width="1" rx="4"/>`,

    // Prompt legend
    `<line x1="${lx + 8}" y1="${ly + 14}" x2="${lx + 30}" y2="${ly + 14}" ` +
    `stroke="#2980b9" stroke-width="2.5"/>`,
    `<circle cx="${lx + 19}" cy="${ly + 14}" r="4" fill="#2980b9" stroke="#fff" stroke-width="1.5"/>`,
    `<text x="${lx + 36}" y="${ly + 18}" font-size="10" fill="#333">System Prompt (chars, left axis)</text>`,

    // Tool legend
    `<line x1="${lx + 8}" y1="${ly + 33}" x2="${lx + 30}" y2="${ly + 33}" ` +
    `stroke="#e67e22" stroke-width="2.5" stroke-dasharray="7 4"/>`,
    `<circle cx="${lx + 19}" cy="${ly + 33}" r="4" fill="#e67e22" stroke="#fff" stroke-width="1.5"/>`,
    `<text x="${lx + 36}" y="${ly + 37}" font-size="10" fill="#333">Tool Count (right axis)</text>`
  );

  push(`</svg>`);
  return lines.join("\n") + "\n";
}

function main(): void {
  const args = process.argv.slice(2);
  let output = "chart.svg";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) output = args[++i];
  }

  const points = loadDataPoints("baselines");
  console.log(`Loaded ${points.length} data points`);
  for (const p of points) {
    console.log(`  ${p.label}  prompt=${fmtNum(p.systemPromptChars)} chars  tools=${p.toolCount}`);
  }

  const svg = generateSVG(points);
  writeFileSync(resolve(output), svg, "utf-8");
  console.log(`\nChart written to: ${output}`);
}

main();
