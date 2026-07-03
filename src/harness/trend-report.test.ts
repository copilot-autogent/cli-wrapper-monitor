import { describe, it, expect } from "vitest";
import {
  extractTrendRow,
  buildSparkline,
  generateTrendReport,
  buildTrendMatrix,
  buildTrendMatrixMarkdown,
  DEFAULT_TREND_WINDOWS,
  type TrendWindow,
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

  it("computes headroomPct as capacity-weighted remaining headroom percentage", () => {
    const snap = makeSnapshot("2026-07-01T00:00:00.000Z", 100_000, 20, {
      contextWindowHeadroom: [
        {
          modelId: "claude-sonnet-4.6",
          state: "enabled",
          contextWindow: 200_000,
          systemPromptTokens: 25_000,
          headroomTokens: 175_000, // 87.5% remaining
          promptFillPct: 12.5,
          status: "ok",
        },
        {
          modelId: "gpt-4.1",
          state: "enabled",
          contextWindow: 100_000,
          systemPromptTokens: 25_000,
          headroomTokens: 75_000, // 75% remaining
          promptFillPct: 25.0,
          status: "ok",
        },
      ],
    });
    const row = extractTrendRow(snap);
    // Weighted: (175_000 + 75_000) / (200_000 + 100_000) * 100 = 250_000 / 300_000 * 100 ≈ 83.33%
    expect(row.headroomPct).toBeCloseTo(83.33, 1);
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
    // Only enabled-model: 175_000 / 200_000 * 100 = 87.5%
    expect(row.headroomPct).toBeCloseTo(87.5, 2);
  });

  it("returns null injectionRefusedRate when absent", () => {
    const row = extractTrendRow(SNAP_A);
    expect(row.injectionRefusedRate).toBeNull();
  });

  it("averages injectionRefusedRate across all experiments that have it", () => {
    const snap = makeSnapshot("2026-07-01T00:00:00.000Z", 100_000, 20, {
      experiments: {
        "context-tax": {
          name: "context-tax",
          description: "test",
          metrics: {
            systemPromptChars: { value: 100_000, unit: "chars", description: "" },
            systemPromptTokensEstimated: { value: 25_000, unit: "tokens", description: "" },
            toolCount: { value: 20, unit: "tools", description: "" },
            injectionRefusedRate: { value: 0.8, unit: "fraction", description: "" },
          },
        },
        "injection-probes": {
          name: "injection-probes",
          description: "test",
          metrics: {
            injectionRefusedRate: { value: 0.6, unit: "fraction", description: "" },
          },
        },
      },
    });
    const row = extractTrendRow(snap);
    expect(row.injectionRefusedRate).toBeCloseTo(0.7, 5); // (0.8 + 0.6) / 2
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
    expect(row.injectionRefusedRate).toBe(0.875); // stored as 0–1 fraction
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
    // SNAP_A(50k) → SNAP_B(100k) → SNAP_D(150k) — monotonically increasing
    const SNAP_D = makeSnapshot("2026-08-01T00:00:00.000Z", 150_000, 30);
    // Use buildSparkline directly for a more precise and robust assertion
    const sparkline = buildSparkline([50_000, 100_000, 150_000]);
    const BLOCKS = "▁▂▃▄▅▆▇█";
    const firstIdx = BLOCKS.indexOf(sparkline[0]);
    const lastIdx = BLOCKS.indexOf(sparkline[sparkline.length - 1]);
    expect(firstIdx).toBeLessThan(lastIdx);
    // Also verify the report embeds a sparkline section
    const report = generateTrendReport([SNAP_A, SNAP_B, SNAP_D]);
    expect(report).toContain("systemPromptChars sparkline");
  });
});

// ---------------------------------------------------------------------------
// extractTrendRow — securityPostureScore
// ---------------------------------------------------------------------------

describe("extractTrendRow — securityPostureScore", () => {
  it("returns null securityPostureScore when no previous snapshot provided", () => {
    const row = extractTrendRow(SNAP_A);
    expect(row.securityPostureScore).toBeNull();
  });

  it("returns 0 when previous and current snapshots are identical", () => {
    const row = extractTrendRow(SNAP_A, SNAP_A);
    expect(row.securityPostureScore).toBe(0);
  });

  it("returns a positive score when there is a regression between snapshots", () => {
    const withHookChange = makeSnapshot("2026-06-01T00:00:00.000Z", 100_000, 28, {
      hookCount: 3, hookSourceHash: "sha256:bbbb",
    });
    const prev = makeSnapshot("2026-05-01T00:00:00.000Z", 50_000, 25, {
      hookCount: 3, hookSourceHash: "sha256:aaaa",
    });
    const row = extractTrendRow(withHookChange, prev);
    // hook body changed with same count → 5 pts
    expect(row.securityPostureScore).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// generateTrendReport — securityPostureScore column
// ---------------------------------------------------------------------------

describe("generateTrendReport — securityPostureScore column", () => {
  it("includes securityPostureScore column header", () => {
    const report = generateTrendReport([SNAP_A, SNAP_B, SNAP_C]);
    expect(report).toContain("securityPostureScore");
  });

  it("shows '—' for the first row (no previous to compare)", () => {
    const report = generateTrendReport([SNAP_A, SNAP_B, SNAP_C]);
    const rows = report.split("\n").filter((line) => line.startsWith("| 2026-"));
    // First row should have '—' in score column
    expect(rows[0]).toContain("| — |");
  });

  it("shows '0/100' for subsequent rows with no regression", () => {
    const report = generateTrendReport([SNAP_A, SNAP_B, SNAP_C]);
    const rows = report.split("\n").filter((line) => line.startsWith("| 2026-"));
    // SNAP_A and SNAP_B have no security-relevant diff → 0/100
    expect(rows[1]).toContain("0/100");
  });
});

// ---------------------------------------------------------------------------
// buildTrendMatrix
// ---------------------------------------------------------------------------

// Helpers: snapshots at known absolute timestamps relative to a common "current"
// 2026-07-01 = current, 2026-06-24 = 7 days ago, 2026-06-01 = 30 days ago,
// 2026-04-02 = 90 days ago, 2026-01-02 = 180 days ago

function snapAt(isoDate: string, chars: number, tools: number): MetricSnapshot {
  return makeSnapshot(`${isoDate}T12:00:00.000Z`, chars, tools);
}

const CURRENT = snapAt("2026-07-01", 60_000, 22);
const WEEK_REF = snapAt("2026-06-24", 60_000, 24); // same chars, 2 more tools → tool Δ = −2
const MONTH_REF = snapAt("2026-06-01", 50_000, 24); // 10k fewer chars → +10k Δ chars
const THREE_MONTH_REF = snapAt("2026-04-02", 30_000, 19); // 30k fewer chars → +100% Δ chars
// no 6-month snapshot → window should show "—"

const MATRIX_SNAPS = [THREE_MONTH_REF, MONTH_REF, WEEK_REF, CURRENT];

const SHORT_WINDOWS: TrendWindow[] = [
  { label: "7d",  days: 7   },
  { label: "30d", days: 30  },
  { label: "90d", days: 90  },
  { label: "180d", days: 180 },
];

describe("buildTrendMatrix", () => {
  it("returns empty rows for fewer than 2 snapshots", () => {
    const m = buildTrendMatrix([CURRENT], SHORT_WINDOWS);
    expect(m.rows).toHaveLength(0);
  });

  it("currentDate reflects the most-recent snapshot", () => {
    const m = buildTrendMatrix(MATRIX_SNAPS, SHORT_WINDOWS);
    expect(m.currentDate).toBe("2026-07-01");
  });

  it("returns 4 metric rows when snapshots are sufficient", () => {
    const m = buildTrendMatrix(MATRIX_SNAPS, SHORT_WINDOWS);
    expect(m.rows).toHaveLength(4);
  });

  it("window resolution: exact-match snapshot is used as reference", () => {
    // WEEK_REF is exactly 7 days before CURRENT
    const m = buildTrendMatrix(MATRIX_SNAPS, [{ label: "7d", days: 7 }]);
    const refDate = m.rows[0].cells[0].referenceDate;
    expect(refDate).toBe("2026-06-24");
  });

  it("window resolution: closest-before snapshot is used when no exact match", () => {
    // 6d window: threshold = 2026-06-25. WEEK_REF (2026-06-24) is the latest
    // snapshot on or before that threshold → used as reference.
    const m = buildTrendMatrix(MATRIX_SNAPS, [{ label: "6d", days: 6 }]);
    const refDate = m.rows[0].cells[0].referenceDate;
    expect(refDate).toBe("2026-06-24");
  });

  it("window resolution: shows '—' when no snapshot exists before the window threshold", () => {
    // 180d window: oldest snapshot is THREE_MONTH_REF (90 days), not ≥180 days before CURRENT
    const m = buildTrendMatrix(MATRIX_SNAPS, [{ label: "180d", days: 180 }]);
    expect(m.rows[0].cells[0].formatted).toBe("—");
    expect(m.rows[0].cells[0].referenceDate).toBeNull();
  });

  it("systemPromptChars: shows absolute delta when < 10% change", () => {
    // WEEK_REF has same chars as CURRENT → Δ = 0 → "+0"
    const m = buildTrendMatrix(MATRIX_SNAPS, [{ label: "7d", days: 7 }]);
    const cell = m.rows[0].cells[0];
    expect(cell.formatted).toBe("+0");
  });

  it("systemPromptChars: shows percentage delta when ≥ 10% change", () => {
    // THREE_MONTH_REF: 30k, CURRENT: 60k → +100%
    const m = buildTrendMatrix(MATRIX_SNAPS, [{ label: "90d", days: 90 }]);
    const cell = m.rows[0].cells[0];
    expect(cell.formatted).toBe("+100%");
  });

  it("toolCount: shows negative delta when tools decreased", () => {
    // WEEK_REF had 24 tools, CURRENT has 22 → delta = −2
    const m = buildTrendMatrix(MATRIX_SNAPS, [{ label: "7d", days: 7 }]);
    const cell = m.rows[1].cells[0];
    expect(cell.formatted).toBe("−2");
  });

  it("toolCount: shows positive delta when tools increased", () => {
    // THREE_MONTH_REF had 19 tools, CURRENT has 22 → delta = +3
    const m = buildTrendMatrix(MATRIX_SNAPS, [{ label: "90d", days: 90 }]);
    const cell = m.rows[1].cells[0];
    expect(cell.formatted).toBe("+3");
  });

  it("injectionRefusedRate: shows reference snapshot value as percentage", () => {
    const snapWithRate = makeSnapshot("2026-06-01T12:00:00.000Z", 50_000, 22, {
      experiments: {
        "context-tax": {
          name: "context-tax",
          description: "test",
          metrics: {
            systemPromptChars: { value: 50_000, unit: "chars", description: "" },
            systemPromptTokensEstimated: { value: 12_500, unit: "tokens", description: "" },
            toolCount: { value: 22, unit: "tools", description: "" },
            injectionRefusedRate: { value: 0.875, unit: "fraction", description: "injection probe refusal rate" },
          },
        },
      },
    });
    const m = buildTrendMatrix([snapWithRate, CURRENT], [{ label: "30d", days: 30 }]);
    const cell = m.rows[2].cells[0];
    expect(cell.formatted).toBe("87.5%");
  });

  it("injectionRefusedRate: shows '—' when reference snapshot lacks the metric", () => {
    const m = buildTrendMatrix(MATRIX_SNAPS, [{ label: "7d", days: 7 }]);
    // WEEK_REF has no injectionRefusedRate metric
    const cell = m.rows[2].cells[0];
    expect(cell.formatted).toBe("—");
  });

  it("windows are propagated unchanged to the output", () => {
    const m = buildTrendMatrix(MATRIX_SNAPS, SHORT_WINDOWS);
    expect(m.windows).toBe(SHORT_WINDOWS);
  });

  it("uses DEFAULT_TREND_WINDOWS when no windows argument provided", () => {
    const m = buildTrendMatrix(MATRIX_SNAPS);
    expect(m.windows).toEqual(DEFAULT_TREND_WINDOWS);
  });
});

// ---------------------------------------------------------------------------
// buildTrendMatrixMarkdown
// ---------------------------------------------------------------------------

describe("buildTrendMatrixMarkdown", () => {
  it("returns a fallback message for empty matrix", () => {
    const m = buildTrendMatrix([CURRENT], SHORT_WINDOWS);
    const md = buildTrendMatrixMarkdown(m);
    expect(md).toContain("Not enough snapshots");
  });

  it("includes window labels as column headers", () => {
    const m = buildTrendMatrix(MATRIX_SNAPS, SHORT_WINDOWS);
    const md = buildTrendMatrixMarkdown(m);
    expect(md).toContain("7d");
    expect(md).toContain("30d");
    expect(md).toContain("90d");
    expect(md).toContain("180d");
  });

  it("includes metric names as row labels", () => {
    const m = buildTrendMatrix(MATRIX_SNAPS, SHORT_WINDOWS);
    const md = buildTrendMatrixMarkdown(m);
    expect(md).toContain("System prompt chars");
    expect(md).toContain("Tool count");
    expect(md).toContain("Injection refusal rate");
    expect(md).toContain("Security posture score");
  });

  it("includes separator row", () => {
    const m = buildTrendMatrix(MATRIX_SNAPS, SHORT_WINDOWS);
    const md = buildTrendMatrixMarkdown(m);
    expect(md).toContain("|--------|");
  });

  it("table rows start with pipe character", () => {
    const m = buildTrendMatrix(MATRIX_SNAPS, SHORT_WINDOWS);
    const md = buildTrendMatrixMarkdown(m);
    const tableRows = md.split("\n").filter((l) => l.startsWith("|"));
    // header + separator + 4 metric rows = 6
    expect(tableRows.length).toBeGreaterThanOrEqual(6);
  });
});
