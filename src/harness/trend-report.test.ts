import { describe, it, expect } from "vitest";
import {
  extractTrendRow,
  buildSparkline,
  generateTrendReport,
} from "./trend-report.js";
import type { MetricSnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(
  capturedAt: string,
  systemPromptChars: number,
  toolCount = 20,
  extraOverrides: Partial<MetricSnapshot> = {}
): MetricSnapshot {
  return {
    capturedAt,
    monitorVersion: "abc1234",
    sdkVersion: "^0.2.2",
    model: "claude-sonnet-4.6",
    experiments: {
      "context-tax": {
        name: "context-tax",
        description: "test",
        metrics: {
          systemPromptChars: {
            value: systemPromptChars,
            unit: "chars",
            description: "System prompt length in characters",
          },
          systemPromptTokensEstimated: {
            value: Math.round(systemPromptChars / 4),
            unit: "tokens",
            description: "Estimated token count",
          },
          toolCount: {
            value: toolCount,
            unit: "tools",
            description: "Number of registered tool definitions",
          },
        },
      },
    },
    ...extraOverrides,
  };
}

const SNAP_A = makeSnapshot("2026-05-01T00:00:00.000Z", 50_000, 25);
const SNAP_B = makeSnapshot("2026-06-01T00:00:00.000Z", 100_000, 28);
const SNAP_C = makeSnapshot("2026-07-01T00:00:00.000Z", 75_000, 22);

// ---------------------------------------------------------------------------
// extractTrendRow
// ---------------------------------------------------------------------------

describe("extractTrendRow", () => {
  it("extracts date as ISO date string", () => {
    const row = extractTrendRow(SNAP_A);
    expect(row.date).toBe("2026-05-01");
  });

  it("extracts systemPromptChars from context-tax experiment", () => {
    const row = extractTrendRow(SNAP_A);
    expect(row.systemPromptChars).toBe(50_000);
  });

  it("extracts systemPromptTokens from context-tax experiment", () => {
    const row = extractTrendRow(SNAP_A);
    expect(row.systemPromptTokens).toBe(12_500);
  });

  it("extracts toolCount from context-tax experiment", () => {
    const row = extractTrendRow(SNAP_A);
    expect(row.toolCount).toBe(25);
  });

  it("returns null headroomPct when contextWindowHeadroom is absent", () => {
    const row = extractTrendRow(SNAP_A);
    expect(row.headroomPct).toBeNull();
  });

  it("computes headroomPct from contextWindowHeadroom", () => {
    const snap = makeSnapshot("2026-07-01T00:00:00.000Z", 100_000, 20, {
      contextWindowHeadroom: [
        {
          modelId: "claude-sonnet-4.6",
          state: "enabled",
          contextWindow: 200_000,
          systemPromptTokens: 25_000,
          headroomTokens: 175_000,
          promptFillPct: 12.5,
          status: "ok",
        },
        {
          modelId: "gpt-4.1",
          state: "enabled",
          contextWindow: 100_000,
          systemPromptTokens: 25_000,
          headroomTokens: 75_000,
          promptFillPct: 25.0,
          status: "ok",
        },
      ],
    });
    const row = extractTrendRow(snap);
    expect(row.headroomPct).toBeCloseTo(18.75, 2); // average of 12.5 and 25.0
  });

  it("ignores disabled models when computing headroomPct", () => {
    const snap = makeSnapshot("2026-07-01T00:00:00.000Z", 100_000, 20, {
      contextWindowHeadroom: [
        {
          modelId: "enabled-model",
          state: "enabled",
          contextWindow: 200_000,
          systemPromptTokens: 25_000,
          headroomTokens: 175_000,
          promptFillPct: 12.5,
          status: "ok",
        },
        {
          modelId: "disabled-model",
          state: "disabled",
          contextWindow: 100_000,
          systemPromptTokens: 25_000,
          headroomTokens: 75_000,
          promptFillPct: 25.0,
          status: "ok",
        },
      ],
    });
    const row = extractTrendRow(snap);
    expect(row.headroomPct).toBeCloseTo(12.5, 2);
  });

  it("returns null injectionRefusedRate when absent", () => {
    const row = extractTrendRow(SNAP_A);
    expect(row.injectionRefusedRate).toBeNull();
  });

  it("extracts injectionRefusedRate from any experiment metrics", () => {
    const snap = makeSnapshot("2026-07-01T00:00:00.000Z", 100_000, 20, {
      experiments: {
        "context-tax": {
          name: "context-tax",
          description: "test",
          metrics: {
            systemPromptChars: { value: 100_000, unit: "chars", description: "" },
            systemPromptTokensEstimated: { value: 25_000, unit: "tokens", description: "" },
            toolCount: { value: 20, unit: "tools", description: "" },
            injectionRefusedRate: { value: 0.875, unit: "fraction", description: "injection probe refusal rate" },
          },
        },
      },
    });
    const row = extractTrendRow(snap);
    expect(row.injectionRefusedRate).toBe(0.875);
  });
});

// ---------------------------------------------------------------------------
// buildSparkline
// ---------------------------------------------------------------------------

describe("buildSparkline", () => {
  it("returns empty string for fewer than 2 non-null values", () => {
    expect(buildSparkline([])).toBe("");
    expect(buildSparkline([null])).toBe("");
    expect(buildSparkline([42])).toBe("");
    expect(buildSparkline([42, null])).toBe("");
  });

  it("returns non-empty string for 2+ non-null values", () => {
    const sparkline = buildSparkline([50_000, 100_000]);
    expect(sparkline.length).toBeGreaterThan(0);
  });

  it("starts low and ends high when values increase", () => {
    const BLOCKS = "▁▂▃▄▅▆▇█";
    const sparkline = buildSparkline([10_000, 50_000, 100_000]);
    // First char should be lower block index than last
    const first = BLOCKS.indexOf(sparkline[0]);
    const last = BLOCKS.indexOf(sparkline[sparkline.length - 1]);
    expect(first).toBeLessThan(last);
  });

  it("starts high and ends low when values decrease", () => {
    const BLOCKS = "▁▂▃▄▅▆▇█";
    const sparkline = buildSparkline([100_000, 50_000, 10_000]);
    const first = BLOCKS.indexOf(sparkline[0]);
    const last = BLOCKS.indexOf(sparkline[sparkline.length - 1]);
    expect(first).toBeGreaterThan(last);
  });

  it("renders · for null values", () => {
    const sparkline = buildSparkline([50_000, null, 100_000]);
    expect(sparkline[1]).toBe("·");
  });

  it("length matches input array length", () => {
    const values = [10_000, 50_000, 75_000, 100_000];
    const sparkline = buildSparkline(values);
    expect(sparkline.length).toBe(values.length);
  });
});

// ---------------------------------------------------------------------------
// generateTrendReport
// ---------------------------------------------------------------------------

describe("generateTrendReport", () => {
  it("returns no-data message for empty snapshot array", () => {
    const report = generateTrendReport([]);
    expect(report).toContain("No baseline snapshots found");
  });

  it("returns single-snapshot warning when only one snapshot provided", () => {
    const report = generateTrendReport([SNAP_A]);
    expect(report).toContain("Only one snapshot available");
  });

  it("produces 3 data rows in the table for 3 snapshots", () => {
    const report = generateTrendReport([SNAP_A, SNAP_B, SNAP_C]);
    // Table rows start with "| 2026-"
    const dataRows = report.split("\n").filter((line) => line.startsWith("| 2026-"));
    expect(dataRows).toHaveLength(3);
  });

  it("first data row shows 'baseline' in Δ column", () => {
    const report = generateTrendReport([SNAP_A, SNAP_B, SNAP_C]);
    const rows = report.split("\n").filter((line) => line.startsWith("| 2026-"));
    expect(rows[0]).toContain("baseline");
  });

  it("subsequent rows show delta percentage in Δ column", () => {
    const report = generateTrendReport([SNAP_A, SNAP_B, SNAP_C]);
    const rows = report.split("\n").filter((line) => line.startsWith("| 2026-"));
    // SNAP_B has 100_000 vs 50_000 first → +100.0%
    expect(rows[1]).toContain("+100.0%");
  });

  it("includes sparkline section when ≥3 data points are available", () => {
    const report = generateTrendReport([SNAP_A, SNAP_B, SNAP_C]);
    expect(report).toContain("systemPromptChars sparkline");
  });

  it("does not include sparkline section when fewer than 3 data points", () => {
    const report = generateTrendReport([SNAP_A, SNAP_B]);
    expect(report).not.toContain("sparkline");
  });

  it("includes all required column headers", () => {
    const report = generateTrendReport([SNAP_A, SNAP_B, SNAP_C]);
    expect(report).toContain("systemPromptChars");
    expect(report).toContain("systemPromptTokens");
    expect(report).toContain("toolCount");
    expect(report).toContain("headroomPct");
    expect(report).toContain("injectionRefusedRate");
    expect(report).toContain("Δ chars");
  });

  it("sparkline direction is upward when prompt size grew", () => {
    // SNAP_A(50k) → SNAP_B(100k) → (with a 3rd larger) → upward sparkline
    const SNAP_D = makeSnapshot("2026-08-01T00:00:00.000Z", 150_000, 30);
    const report = generateTrendReport([SNAP_A, SNAP_B, SNAP_D]);
    // Extract the sparkline line
    const sparklineLine = report.split("\n").find((l) => l.startsWith("`▁"));
    expect(sparklineLine).toBeDefined();
    const BLOCKS = "▁▂▃▄▅▆▇█";
    const sparkline = sparklineLine!.replace(/`/g, "").split(" ")[0];
    const firstIdx = BLOCKS.indexOf(sparkline[0]);
    const lastIdx = BLOCKS.indexOf(sparkline[sparkline.length - 1]);
    expect(firstIdx).toBeLessThan(lastIdx);
  });
});
