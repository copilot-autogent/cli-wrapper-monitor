import { describe, it, expect } from "vitest";
import type { MetricSnapshot } from "./types.js";
import {
  extractSummaryCard,
  extractToolCountSeries,
  extractSystemPromptTokensSeries,
  extractSystemPromptCharsSeries,
  extractInjectionRefusalSeries,
  extractRegressions,
  extractModelPoolHistory,
  generateSparklineSVG,
  buildStatusHero,
  generateStatusHeroHTML,
} from "./dashboard.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnap(overrides: Partial<MetricSnapshot> & { capturedAt: string }): MetricSnapshot {
  return {
    monitorVersion: "test",
    sdkVersion: "^0.2.2",
    model: "claude-sonnet-4.6",
    experiments: {
      "context-tax": {
        name: "context-tax",
        description: "test",
        metrics: {
          systemPromptChars: { value: 100000, unit: "chars", description: "" },
          systemPromptTokensEstimated: { value: 25000, unit: "tokens", description: "" },
          toolCount: { value: 20, unit: "tools", description: "" },
        },
      },
    },
    ...overrides,
  };
}

const SNAP_A = makeSnap({ capturedAt: "2026-05-01T00:00:00.000Z" });
const SNAP_B = makeSnap({
  capturedAt: "2026-06-01T00:00:00.000Z",
  experiments: {
    "context-tax": {
      name: "context-tax",
      description: "test",
      metrics: {
        systemPromptChars: { value: 150000, unit: "chars", description: "" },
        systemPromptTokensEstimated: { value: 37500, unit: "tokens", description: "" },
        toolCount: { value: 20, unit: "tools", description: "" },
      },
    },
  },
});
const SNAP_TOOL_DROP = makeSnap({
  capturedAt: "2026-07-01T00:00:00.000Z",
  experiments: {
    "context-tax": {
      name: "context-tax",
      description: "test",
      metrics: {
        systemPromptChars: { value: 150000, unit: "chars", description: "" },
        systemPromptTokensEstimated: { value: 37500, unit: "tokens", description: "" },
        toolCount: { value: 10, unit: "tools", description: "" },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// extractSummaryCard
// ---------------------------------------------------------------------------

describe("extractSummaryCard", () => {
  it("returns null for empty snapshots", () => {
    expect(extractSummaryCard([])).toBeNull();
  });

  it("returns summary data for the latest snapshot", () => {
    const card = extractSummaryCard([SNAP_A, SNAP_B]);
    expect(card).not.toBeNull();
    expect(card!.date).toBe("2026-06-01");
    expect(card!.toolCount).toBe(20);
    expect(card!.systemPromptChars).toBe(150000);
    expect(card!.model).toBe("claude-sonnet-4.6");
  });

  it("sorts unsorted input and picks the latest", () => {
    // Pass snapshots in reverse order
    const card = extractSummaryCard([SNAP_B, SNAP_A]);
    expect(card!.date).toBe("2026-06-01"); // SNAP_B is later
  });

  it("includes hookCount when present", () => {
    const snap = makeSnap({ capturedAt: "2026-06-01T00:00:00.000Z", hookCount: 3 });
    const card = extractSummaryCard([snap]);
    expect(card!.hookCount).toBe(3);
  });

  it("hookCount is null when absent", () => {
    const card = extractSummaryCard([SNAP_A]);
    expect(card!.hookCount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sparkline data transforms
// ---------------------------------------------------------------------------

describe("extractToolCountSeries", () => {
  it("returns one point per snapshot", () => {
    const series = extractToolCountSeries([SNAP_A, SNAP_B]);
    expect(series).toHaveLength(2);
    expect(series[0].date).toBe("2026-05-01");
    expect(series[0].value).toBe(20);
    expect(series[1].date).toBe("2026-06-01");
  });

  it("returns empty array for no snapshots", () => {
    expect(extractToolCountSeries([])).toHaveLength(0);
  });
});

describe("extractSystemPromptTokensSeries", () => {
  it("extracts systemPromptTokensEstimated", () => {
    const series = extractSystemPromptTokensSeries([SNAP_A, SNAP_B]);
    expect(series[0].value).toBe(25000);
    expect(series[1].value).toBe(37500);
  });
});

describe("extractInjectionRefusalSeries", () => {
  it("returns null values when metric absent", () => {
    const series = extractInjectionRefusalSeries([SNAP_A]);
    expect(series[0].value).toBeNull();
  });

  it("extracts injectionRefusedRate when present", () => {
    const snap = makeSnap({
      capturedAt: "2026-06-01T00:00:00.000Z",
      experiments: {
        "context-tax": {
          name: "context-tax",
          description: "test",
          metrics: {
            systemPromptChars: { value: 100000, unit: "chars", description: "" },
            systemPromptTokensEstimated: { value: 25000, unit: "tokens", description: "" },
            toolCount: { value: 20, unit: "tools", description: "" },
            injectionRefusedRate: { value: 0.9, unit: "rate", description: "" },
          },
        },
      },
    });
    const series = extractInjectionRefusalSeries([snap]);
    expect(series[0].value).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// extractSystemPromptCharsSeries
// ---------------------------------------------------------------------------

describe("extractSystemPromptCharsSeries", () => {
  it("extracts systemPromptChars from each snapshot", () => {
    const series = extractSystemPromptCharsSeries([SNAP_A, SNAP_B]);
    expect(series).toHaveLength(2);
    expect(series[0].value).toBe(100000);
    expect(series[1].value).toBe(150000);
  });

  it("returns null when systemPromptChars metric is absent", () => {
    const snap = makeSnap({
      capturedAt: "2026-05-01T00:00:00.000Z",
      experiments: {},
    });
    const series = extractSystemPromptCharsSeries([snap]);
    expect(series[0].value).toBeNull();
  });

  it("returns empty array for no snapshots", () => {
    expect(extractSystemPromptCharsSeries([])).toHaveLength(0);
  });

  it("preserves date from snapshot capturedAt", () => {
    const series = extractSystemPromptCharsSeries([SNAP_A]);
    expect(series[0].date).toBe("2026-05-01");
  });
});

// ---------------------------------------------------------------------------
// extractRegressions
// ---------------------------------------------------------------------------

describe("extractRegressions", () => {
  it("returns empty for single snapshot", () => {
    expect(extractRegressions([SNAP_A])).toHaveLength(0);
  });

  it("returns empty for no snapshots", () => {
    expect(extractRegressions([])).toHaveLength(0);
  });

  it("detects BREAKING systemPromptChars increase >10%", () => {
    const regressions = extractRegressions([SNAP_A, SNAP_B]);
    const r = regressions.find((r) => r.description.includes("systemPromptChars"));
    expect(r).toBeDefined();
    expect(r!.severity).toBe("BREAKING");
    expect(r!.date).toBe("2026-06-01");
  });

  it("sorts unsorted input before comparing", () => {
    // Reverse order — should still find the regression
    const regressions = extractRegressions([SNAP_B, SNAP_A]);
    const r = regressions.find((r) => r.description.includes("systemPromptChars"));
    expect(r).toBeDefined();
    expect(r!.date).toBe("2026-06-01"); // SNAP_B is the later/larger one
  });

  it("does NOT flag systemPromptChars DECREASE as regression", () => {
    // SNAP_B (150k) → SNAP_A (100k): a decrease is good, not a regression
    const snapLarge = makeSnap({
      capturedAt: "2026-05-01T00:00:00.000Z",
      experiments: {
        "context-tax": {
          name: "context-tax",
          description: "test",
          metrics: {
            systemPromptChars: { value: 200000, unit: "chars", description: "" },
            systemPromptTokensEstimated: { value: 50000, unit: "tokens", description: "" },
            toolCount: { value: 20, unit: "tools", description: "" },
          },
        },
      },
    });
    const snapSmall = makeSnap({
      capturedAt: "2026-06-01T00:00:00.000Z",
      experiments: {
        "context-tax": {
          name: "context-tax",
          description: "test",
          metrics: {
            systemPromptChars: { value: 100000, unit: "chars", description: "" },
            systemPromptTokensEstimated: { value: 25000, unit: "tokens", description: "" },
            toolCount: { value: 20, unit: "tools", description: "" },
          },
        },
      },
    });
    const regressions = extractRegressions([snapLarge, snapSmall]);
    const r = regressions.find((r) => r.description.includes("systemPromptChars"));
    expect(r).toBeUndefined(); // decrease = no regression
  });

  it("detects BREAKING tool count drop", () => {
    const regressions = extractRegressions([SNAP_B, SNAP_TOOL_DROP]);
    const r = regressions.find((r) => r.description.includes("toolCount"));
    expect(r).toBeDefined();
    expect(r!.severity).toBe("BREAKING");
    expect(r!.description).toContain("-10");
  });

  it("detects BREAKING for large tool count increase above BREAKING threshold", () => {
    const snapIncrease = makeSnap({
      capturedAt: "2026-07-01T00:00:00.000Z",
      experiments: {
        "context-tax": {
          name: "context-tax",
          description: "test",
          metrics: {
            systemPromptChars: { value: 100000, unit: "chars", description: "" },
            systemPromptTokensEstimated: { value: 25000, unit: "tokens", description: "" },
            toolCount: { value: 25, unit: "tools", description: "" },
          },
        },
      },
    });
    // +5 tools from 20 = +25% → above BREAKING_THRESHOLD (10%) → BREAKING
    const regressions = extractRegressions([SNAP_A, snapIncrease]);
    const r = regressions.find((r) => r.description.includes("toolCount"));
    expect(r).toBeDefined();
    expect(r!.severity).toBe("BREAKING");
  });

  it("does NOT flag trivial +1 tool count addition as regression", () => {
    const snapPlusOne = makeSnap({
      capturedAt: "2026-07-01T00:00:00.000Z",
      experiments: {
        "context-tax": {
          name: "context-tax",
          description: "test",
          metrics: {
            systemPromptChars: { value: 100000, unit: "chars", description: "" },
            systemPromptTokensEstimated: { value: 25000, unit: "tokens", description: "" },
            toolCount: { value: 21, unit: "tools", description: "" },
          },
        },
      },
    });
    // +1 from 20 = +5% — exactly at WARNING_THRESHOLD, not above, so no regression
    const regressions = extractRegressions([SNAP_A, snapPlusOne]);
    const r = regressions.find((r) => r.description.includes("toolCount"));
    expect(r).toBeUndefined();
  });

  it("detects BREAKING hookCount drop", () => {
    const snapHook3 = makeSnap({ capturedAt: "2026-05-01T00:00:00.000Z", hookCount: 3 });
    const snapHook1 = makeSnap({ capturedAt: "2026-06-01T00:00:00.000Z", hookCount: 1 });
    const regressions = extractRegressions([snapHook3, snapHook1]);
    const r = regressions.find((r) => r.description.includes("hookCount"));
    expect(r).toBeDefined();
    expect(r!.severity).toBe("BREAKING");
  });

  it("detects WARNING for moderate hook addition (5-10% range)", () => {
    // Use 20 hooks base: +2 = +10%  → exactly at BREAKING_THRESHOLD
    // Use +1 from 14 = +7.1% → >5% but <10% = WARNING
    const snapHook14 = makeSnap({ capturedAt: "2026-05-01T00:00:00.000Z", hookCount: 14 });
    const snapHook15 = makeSnap({ capturedAt: "2026-06-01T00:00:00.000Z", hookCount: 15 });
    // +1 from 14 = +7.1% → > 5% but < 10% = WARNING
    const regressions = extractRegressions([snapHook14, snapHook15]);
    const r = regressions.find((r) => r.description.includes("hookCount"));
    expect(r?.severity).toBe("WARNING");
  });

  it("ignores hookCount when absent in either snapshot", () => {
    const regressions = extractRegressions([SNAP_A, SNAP_B]);
    expect(regressions.every((r) => !r.description.includes("hookCount"))).toBe(true);
  });

  it("does NOT flag injection refusal drop when absolute change is tiny", () => {
    const makeWithInjection = (capturedAt: string, rate: number) =>
      makeSnap({
        capturedAt,
        experiments: {
          "context-tax": {
            name: "context-tax",
            description: "test",
            metrics: {
              systemPromptChars: { value: 100000, unit: "chars", description: "" },
              systemPromptTokensEstimated: { value: 25000, unit: "tokens", description: "" },
              toolCount: { value: 20, unit: "tools", description: "" },
              injectionRefusedRate: { value: rate, unit: "rate", description: "" },
            },
          },
        },
      });

    // Near-zero: 0.02 → 0.0 (absolute drop = 0.02 < 0.05 threshold)
    const r1 = extractRegressions([
      makeWithInjection("2026-05-01T00:00:00.000Z", 0.02),
      makeWithInjection("2026-06-01T00:00:00.000Z", 0.0),
    ]);
    expect(r1.find((r) => r.description.includes("injectionRefusal"))).toBeUndefined();

    // Large drop: 0.9 → 0.7 (absolute drop = 0.2 > 0.1 threshold) → BREAKING
    const r2 = extractRegressions([
      makeWithInjection("2026-05-01T00:00:00.000Z", 0.9),
      makeWithInjection("2026-06-01T00:00:00.000Z", 0.7),
    ]);
    expect(r2.find((r) => r.description.includes("injectionRefusal"))?.severity).toBe("BREAKING");
  });
});

// ---------------------------------------------------------------------------
// extractModelPoolHistory
// ---------------------------------------------------------------------------

describe("extractModelPoolHistory", () => {
  it("returns empty for snapshots without modelPool", () => {
    expect(extractModelPoolHistory([SNAP_A, SNAP_B])).toHaveLength(0);
  });

  it("tracks models across snapshots", () => {
    const snap1 = makeSnap({
      capturedAt: "2026-05-01T00:00:00.000Z",
      modelPool: {
        capturedAt: "2026-05-01T00:00:00.000Z",
        models: [
          { id: "model-a", state: "enabled", contextWindow: 100000 },
          { id: "model-b", state: "enabled", contextWindow: 200000 },
        ],
      },
    });
    const snap2 = makeSnap({
      capturedAt: "2026-06-01T00:00:00.000Z",
      modelPool: {
        capturedAt: "2026-06-01T00:00:00.000Z",
        models: [
          { id: "model-a", state: "enabled", contextWindow: 100000 },
        ],
      },
    });
    const history = extractModelPoolHistory([snap1, snap2]);
    expect(history).toHaveLength(2);

    const modelA = history.find((m) => m.id === "model-a");
    expect(modelA!.firstSeen).toBe("2026-05-01");
    expect(modelA!.lastSeen).toBeNull(); // still in latest

    const modelB = history.find((m) => m.id === "model-b");
    expect(modelB!.firstSeen).toBe("2026-05-01");
    expect(modelB!.lastSeen).toBe("2026-05-01"); // not in latest
  });
});

// ---------------------------------------------------------------------------
// generateSparklineSVG
// ---------------------------------------------------------------------------

describe("generateSparklineSVG", () => {
  it("returns no-data SVG when all values are null", () => {
    const svg = generateSparklineSVG([
      { date: "2026-05-01", value: null },
      { date: "2026-06-01", value: null },
    ]);
    expect(svg).toContain("No data");
  });

  it("generates valid SVG with ≥3 points", () => {
    const svg = generateSparklineSVG([
      { date: "2026-05-01", value: 100 },
      { date: "2026-06-01", value: 150 },
      { date: "2026-07-01", value: 130 },
    ]);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("<path");
    expect(svg).toContain("<circle");
  });

  it("returns not-enough-data SVG for single valid data point", () => {
    const svg = generateSparklineSVG([{ date: "2026-05-01", value: 100 }]);
    expect(svg).toContain("Not enough data");
    expect(svg).toContain("1 point");
  });

  it("returns not-enough-data SVG for exactly two valid data points", () => {
    const svg = generateSparklineSVG([
      { date: "2026-05-01", value: 100 },
      { date: "2026-06-01", value: 150 },
    ]);
    expect(svg).toContain("Not enough data");
    expect(svg).toContain("2 points");
  });

  it("renders correctly for exactly three valid data points", () => {
    const svg = generateSparklineSVG([
      { date: "2026-05-01", value: 100 },
      { date: "2026-06-01", value: 120 },
      { date: "2026-07-01", value: 110 },
    ]);
    expect(svg).toContain("<path");
    expect(svg).toContain("<circle");
    expect(svg).not.toContain("Not enough data");
  });

  it("embeds label when provided", () => {
    const svg = generateSparklineSVG(
      [
        { date: "2026-05-01", value: 100 },
        { date: "2026-06-01", value: 120 },
        { date: "2026-07-01", value: 110 },
      ],
      { label: "My Metric" }
    );
    expect(svg).toContain("My Metric");
  });

  it("respects custom stroke color", () => {
    const svg = generateSparklineSVG(
      [
        { date: "2026-05-01", value: 100 },
        { date: "2026-06-01", value: 120 },
        { date: "2026-07-01", value: 110 },
      ],
      { strokeColor: "#ff0000" }
    );
    expect(svg).toContain("#ff0000");
  });

  it("orders points by date regardless of input order (monotonic x-axis)", () => {
    // Provide points out-of-order; the SVG should still render correctly (no crash)
    const svg = generateSparklineSVG([
      { date: "2026-07-01", value: 130 },
      { date: "2026-05-01", value: 100 },
      { date: "2026-06-01", value: 150 },
    ]);
    expect(svg).toContain("<path");
    // First date label should be the earliest (2026-05-01)
    const firstLabelIdx = svg.indexOf("2026-05-01");
    const lastLabelIdx = svg.lastIndexOf("2026-07-01");
    expect(firstLabelIdx).toBeLessThan(lastLabelIdx);
  });

  it("embeds date+value in dot tooltips", () => {
    const svg = generateSparklineSVG([
      { date: "2026-05-01", value: 100 },
      { date: "2026-06-01", value: 200 },
      { date: "2026-07-01", value: 150 },
    ]);
    expect(svg).toContain("2026-05-01");
    expect(svg).toContain("2026-06-01");
    expect(svg).toContain("2026-07-01");
  });

  it("handles sparse data with some null values gracefully", () => {
    // 2 valid + 1 null → only 2 valid → not enough data
    const svg = generateSparklineSVG([
      { date: "2026-05-01", value: 100 },
      { date: "2026-06-01", value: null },
      { date: "2026-07-01", value: 130 },
    ]);
    expect(svg).toContain("Not enough data");
  });

  it("renders full sparkline when nulls bring valid count to ≥3", () => {
    const svg = generateSparklineSVG([
      { date: "2026-04-01", value: 90 },
      { date: "2026-05-01", value: 100 },
      { date: "2026-06-01", value: null },
      { date: "2026-07-01", value: 130 },
    ]);
    // 3 valid points (null excluded) → full sparkline
    expect(svg).toContain("<path");
    expect(svg).not.toContain("Not enough data");
  });
});

// ---------------------------------------------------------------------------
// buildStatusHero
// ---------------------------------------------------------------------------

describe("buildStatusHero", () => {
  it("returns tier=null and snapshotCount=0 for empty snapshots", () => {
    const hero = buildStatusHero([]);
    expect(hero.tier).toBeNull();
    expect(hero.snapshotCount).toBe(0);
    expect(hero.latestDate).toBeNull();
    expect(hero.previousDate).toBeNull();
  });

  it("returns tier=null for a single snapshot", () => {
    const hero = buildStatusHero([SNAP_A]);
    expect(hero.tier).toBeNull();
    expect(hero.snapshotCount).toBe(1);
    expect(hero.latestDate).toBe("2026-05-01");
    expect(hero.previousDate).toBeNull();
  });

  it("returns STABLE when no meaningful drift between two identical snapshots", () => {
    const hero = buildStatusHero([SNAP_A, SNAP_A]);
    expect(hero.tier).toBe("stable");
    expect(hero.systemPromptDeltaPct).toBe(0);
    expect(hero.toolCountDelta).toBe(0);
    expect(hero.probeRefusalDeltaPp).toBe(0);
  });

  it("returns CHANGE when system prompt grows but below ALERT threshold", () => {
    // SNAP_B has systemPromptChars=150000 vs SNAP_A=100000 → 50% → ALERT
    // Use a small increase to test CHANGE path
    const snapBSmall = makeSnap({
      capturedAt: "2026-06-01T00:00:00.000Z",
      experiments: {
        "context-tax": {
          name: "context-tax",
          description: "test",
          metrics: {
            systemPromptChars: { value: 103000, unit: "chars", description: "" }, // +3% → below 5% ALERT
            systemPromptTokensEstimated: { value: 25750, unit: "tokens", description: "" },
            toolCount: { value: 20, unit: "tools", description: "" },
          },
        },
      },
    });
    const hero = buildStatusHero([SNAP_A, snapBSmall]);
    expect(hero.tier).toBe("change");
    expect(hero.systemPromptDeltaPct).toBeCloseTo(3, 0);
  });

  it("returns ALERT when system prompt delta exceeds threshold", () => {
    // SNAP_A=100k, SNAP_B=150k → +50% → ALERT (signed)
    const hero = buildStatusHero([SNAP_A, SNAP_B]);
    expect(hero.tier).toBe("alert");
    expect(hero.systemPromptDeltaPct).toBeCloseTo(50, 0);
  });

  it("systemPromptDeltaPct is negative when prompt shrinks", () => {
    const snapSmaller = makeSnap({
      capturedAt: "2026-06-01T00:00:00.000Z",
      experiments: {
        "context-tax": {
          name: "context-tax",
          description: "test",
          metrics: {
            systemPromptChars: { value: 90000, unit: "chars", description: "" }, // -10%
            systemPromptTokensEstimated: { value: 22500, unit: "tokens", description: "" },
            toolCount: { value: 20, unit: "tools", description: "" },
          },
        },
      },
    });
    const hero = buildStatusHero([SNAP_A, snapSmaller]);
    expect(hero.systemPromptDeltaPct).toBeCloseTo(-10, 0);
  });

  it("returns ALERT when tool count changes", () => {
    // SNAP_B (toolCount=20) → SNAP_TOOL_DROP (toolCount=10) → ALERT
    const hero = buildStatusHero([SNAP_B, SNAP_TOOL_DROP]);
    expect(hero.tier).toBe("alert");
    expect(hero.toolCountDelta).toBe(-10);
  });

  it("uses two most-recent snapshots when more than two provided", () => {
    // Three snapshots: A(100k) → B(150k) → TOOL_DROP(150k, 10 tools)
    // Hero should compare B vs TOOL_DROP (two most recent)
    const hero = buildStatusHero([SNAP_A, SNAP_B, SNAP_TOOL_DROP]);
    expect(hero.previousDate).toBe("2026-06-01");
    expect(hero.latestDate).toBe("2026-07-01");
    expect(hero.tier).toBe("alert"); // tool count changed
  });

  it("sets previousDate and latestDate from the comparison pair", () => {
    const hero = buildStatusHero([SNAP_A, SNAP_B]);
    expect(hero.previousDate).toBe("2026-05-01");
    expect(hero.latestDate).toBe("2026-06-01");
  });
});

// ---------------------------------------------------------------------------
// generateStatusHeroHTML
// ---------------------------------------------------------------------------

describe("generateStatusHeroHTML", () => {
  it("renders STABLE badge with green background class", () => {
    const hero = buildStatusHero([SNAP_A, SNAP_A]);
    const html = generateStatusHeroHTML(hero);
    expect(html).toContain("hero-badge-stable");
    expect(html).toContain("✅ STABLE");
    expect(html).toContain("status-hero-stable");
  });

  it("renders CHANGE badge with yellow background class", () => {
    const snapChange = makeSnap({
      capturedAt: "2026-06-01T00:00:00.000Z",
      experiments: {
        "context-tax": {
          name: "context-tax",
          description: "test",
          metrics: {
            systemPromptChars: { value: 103000, unit: "chars", description: "" },
            systemPromptTokensEstimated: { value: 25750, unit: "tokens", description: "" },
            toolCount: { value: 20, unit: "tools", description: "" },
          },
        },
      },
    });
    const hero = buildStatusHero([SNAP_A, snapChange]);
    const html = generateStatusHeroHTML(hero);
    expect(html).toContain("hero-badge-change");
    expect(html).toContain("🔄 CHANGE");
    expect(html).toContain("status-hero-change");
  });

  it("renders ALERT badge with red background class", () => {
    const hero = buildStatusHero([SNAP_A, SNAP_B]);
    const html = generateStatusHeroHTML(hero);
    expect(html).toContain("hero-badge-alert");
    expect(html).toContain("🚨 ALERT");
    expect(html).toContain("status-hero-alert");
  });

  it("renders key deltas in the hero", () => {
    const hero = buildStatusHero([SNAP_A, SNAP_B]);
    const html = generateStatusHeroHTML(hero);
    expect(html).toContain("System Prompt Δ");
    expect(html).toContain("Tool Count Δ");
    expect(html).toContain("Probe Refusal Δ");
  });

  it("renders comparison window dates", () => {
    const hero = buildStatusHero([SNAP_A, SNAP_B]);
    const html = generateStatusHeroHTML(hero);
    expect(html).toContain("Latest vs Previous: 2026-05-01 → 2026-06-01");
  });

  it("renders generated timestamp when provided", () => {
    const hero = buildStatusHero([SNAP_A, SNAP_B]);
    const html = generateStatusHeroHTML(hero, "2026-07-10T10:00:00.000Z");
    expect(html).toContain("Dashboard generated: 2026-07-10 10:00Z");
  });

  it("omits generated timestamp when not provided", () => {
    const hero = buildStatusHero([SNAP_A, SNAP_B]);
    const html = generateStatusHeroHTML(hero);
    expect(html).not.toContain("Dashboard generated:");
  });

  it("renders insufficient-data message for 0 snapshots", () => {
    const hero = buildStatusHero([]);
    const html = generateStatusHeroHTML(hero);
    expect(html).toContain("INSUFFICIENT DATA");
    expect(html).toContain("0 baselines captured");
    expect(html).toContain("hero-badge-insufficient");
  });

  it("renders insufficient-data message for 1 snapshot", () => {
    const hero = buildStatusHero([SNAP_A]);
    const html = generateStatusHeroHTML(hero);
    expect(html).toContain("INSUFFICIENT DATA");
    expect(html).toContain("1 baseline captured");
  });

  it("shows signed delta for tool count increases", () => {
    const snapMore = makeSnap({
      capturedAt: "2026-06-01T00:00:00.000Z",
      experiments: {
        "context-tax": {
          name: "context-tax",
          description: "test",
          metrics: {
            systemPromptChars: { value: 100000, unit: "chars", description: "" },
            systemPromptTokensEstimated: { value: 25000, unit: "tokens", description: "" },
            toolCount: { value: 25, unit: "tools", description: "" }, // +5 vs SNAP_A
          },
        },
      },
    });
    const hero = buildStatusHero([SNAP_A, snapMore]);
    const html = generateStatusHeroHTML(hero);
    expect(html).toContain("+5"); // signed tool delta
  });

  it("shows +% prefix when system prompt grew", () => {
    // SNAP_A=100k → SNAP_B=150k → +50%
    const hero = buildStatusHero([SNAP_A, SNAP_B]);
    const html = generateStatusHeroHTML(hero);
    expect(html).toContain("+50.0%");
  });

  it("shows negative % when system prompt shrank", () => {
    const snapSmaller = makeSnap({
      capturedAt: "2026-06-01T00:00:00.000Z",
      experiments: {
        "context-tax": {
          name: "context-tax",
          description: "test",
          metrics: {
            systemPromptChars: { value: 90000, unit: "chars", description: "" }, // -10%
            systemPromptTokensEstimated: { value: 22500, unit: "tokens", description: "" },
            toolCount: { value: 20, unit: "tools", description: "" },
          },
        },
      },
    });
    const hero = buildStatusHero([SNAP_A, snapSmaller]);
    const html = generateStatusHeroHTML(hero);
    expect(html).toContain("-10.0%");
  });
});
