import { describe, it, expect } from "vitest";
import type { MetricSnapshot } from "./types.js";
import {
  extractSummaryCard,
  extractToolCountSeries,
  extractSystemPromptTokensSeries,
  extractInjectionRefusalSeries,
  extractRegressions,
  extractModelPoolHistory,
  generateSparklineSVG,
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

  it("detects BREAKING tool count drop", () => {
    const regressions = extractRegressions([SNAP_B, SNAP_TOOL_DROP]);
    const r = regressions.find((r) => r.description.includes("toolCount"));
    expect(r).toBeDefined();
    expect(r!.severity).toBe("BREAKING");
    expect(r!.description).toContain("-10");
  });

  it("detects WARNING for tool count increase", () => {
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
    const regressions = extractRegressions([SNAP_A, snapIncrease]);
    const r = regressions.find((r) => r.description.includes("toolCount"));
    expect(r).toBeDefined();
    expect(r!.severity).toBe("WARNING");
  });

  it("detects BREAKING hookCount drop", () => {
    const snapHook3 = makeSnap({ capturedAt: "2026-05-01T00:00:00.000Z", hookCount: 3 });
    const snapHook1 = makeSnap({ capturedAt: "2026-06-01T00:00:00.000Z", hookCount: 1 });
    const regressions = extractRegressions([snapHook3, snapHook1]);
    const r = regressions.find((r) => r.description.includes("hookCount"));
    expect(r).toBeDefined();
    expect(r!.severity).toBe("BREAKING");
  });

  it("ignores hookCount when absent in either snapshot", () => {
    const regressions = extractRegressions([SNAP_A, SNAP_B]);
    expect(regressions.every((r) => !r.description.includes("hookCount"))).toBe(true);
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

  it("generates valid SVG with points", () => {
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

  it("renders with single data point", () => {
    const svg = generateSparklineSVG([{ date: "2026-05-01", value: 100 }]);
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("No data");
  });

  it("embeds label when provided", () => {
    const svg = generateSparklineSVG(
      [{ date: "2026-05-01", value: 100 }],
      { label: "My Metric" }
    );
    expect(svg).toContain("My Metric");
  });

  it("respects custom stroke color", () => {
    const svg = generateSparklineSVG(
      [{ date: "2026-05-01", value: 100 }],
      { strokeColor: "#ff0000" }
    );
    expect(svg).toContain("#ff0000");
  });
});
