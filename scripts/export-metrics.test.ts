/**
 * Unit tests for scripts/export-metrics.ts
 *
 * Tests extractRow, serializeCSV, and serializeJSON using in-memory fixture
 * snapshots — no disk reads.
 */
import { describe, it, expect } from "vitest";
import { extractRow, serializeCSV, serializeJSON, buildExportRows } from "./export-metrics.js";
import type { ExportRow } from "./export-metrics.js";
import type { MetricSnapshot } from "../src/harness/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    capturedAt: "2026-05-20T17:00:00.000Z",
    monitorVersion: "abc1234",
    sdkVersion: "^0.2.2",
    model: "claude-sonnet-4.6",
    schemaVersion: "1.0",
    experiments: {
      "context-tax": {
        name: "context-tax",
        description: "Context tax measurement",
        metrics: {
          systemPromptChars: { value: 56963, unit: "chars", description: "" },
          systemPromptTokensEstimated: { value: 14241, unit: "tokens", description: "" },
          toolCount: { value: 29, unit: "tools", description: "" },
        },
      },
    },
    ...overrides,
  };
}

/** Snapshot with all optional fields populated */
function makeFullSnapshot(): MetricSnapshot {
  return makeSnapshot({
    capturedAt: "2026-06-16T21:20:00.000Z",
    hookCount: 3,
    hookSourceHash: "sha256:abc",
    modelPool: {
      capturedAt: "2026-06-16T21:20:00.000Z",
      models: [
        { id: "model-a", state: "enabled", contextWindow: 200000 },
        { id: "model-b", state: "enabled", contextWindow: 100000 },
      ],
    },
    contextWindowHeadroom: [
      {
        modelId: "model-a",
        state: "enabled",
        contextWindow: 200000,
        systemPromptTokens: 39061,
        headroomTokens: 160939,
        promptFillPct: 19.53,
        status: "ok",
      },
      {
        modelId: "model-b",
        state: "enabled",
        contextWindow: 100000,
        systemPromptTokens: 39061,
        headroomTokens: 60939,
        promptFillPct: 39.06,
        status: "ok",
      },
    ],
  });
}

/** Snapshot with an injectionRefusedRate experiment metric */
function makeInjectionSnapshot(): MetricSnapshot {
  return makeSnapshot({
    capturedAt: "2026-07-01T12:00:00.000Z",
    experiments: {
      "context-tax": {
        name: "context-tax",
        description: "",
        metrics: {
          systemPromptChars: { value: 100000, unit: "chars", description: "" },
          systemPromptTokensEstimated: { value: 25000, unit: "tokens", description: "" },
          toolCount: { value: 20, unit: "tools", description: "" },
        },
      },
      "injection-refusal": {
        name: "injection-refusal",
        description: "",
        metrics: {
          injectionRefusedRate: { value: 0.95, unit: "rate", description: "" },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// extractRow
// ---------------------------------------------------------------------------

describe("extractRow", () => {
  it("extracts core fields from a minimal snapshot", () => {
    const snap = makeSnapshot();
    const row = extractRow(snap);

    expect(row.date).toBe("2026-05-20T17:00:00.000Z");
    expect(row.systemPromptChars).toBe(56963);
    expect(row.systemPromptTokens).toBe(14241);
    expect(row.toolCount).toBe(29);
    expect(row.schemaVersion).toBe("1.0");
  });

  it("returns null for optional fields absent in older baselines", () => {
    const snap = makeSnapshot({ hookCount: undefined, modelPool: undefined, contextWindowHeadroom: undefined });
    const row = extractRow(snap);

    expect(row.modelCount).toBeNull();
    expect(row.hookCount).toBeNull();
    expect(row.injectionRefusedRate).toBeNull();
    expect(row.headroomMin).toBeNull();
    expect(row.securityPostureScore).toBeNull(); // no prevSnapshot
  });

  it("populates modelCount, hookCount from a full snapshot", () => {
    const snap = makeFullSnapshot();
    const row = extractRow(snap);

    expect(row.modelCount).toBe(2);
    expect(row.hookCount).toBe(3);
  });

  it("computes headroomMin as the minimum headroomTokens", () => {
    const snap = makeFullSnapshot(); // model-a: 160939, model-b: 60939
    const row = extractRow(snap);

    expect(row.headroomMin).toBe(60939);
  });

  it("extracts injectionRefusedRate from injection-refusal experiment", () => {
    const snap = makeInjectionSnapshot();
    const row = extractRow(snap);

    expect(row.injectionRefusedRate).toBe(0.95);
  });

  it("returns null securityPostureScore when no previous snapshot provided", () => {
    const snap = makeSnapshot();
    const row = extractRow(snap);
    expect(row.securityPostureScore).toBeNull();
  });

  it("computes securityPostureScore 0 when nothing regressed", () => {
    const prev = makeSnapshot({ capturedAt: "2026-05-20T00:00:00.000Z" });
    const curr = makeSnapshot({ capturedAt: "2026-05-27T00:00:00.000Z" });
    const row = extractRow(curr, prev);
    expect(row.securityPostureScore).toBe(0);
  });

  it("computes non-zero securityPostureScore when hook count drops", () => {
    const prev = makeSnapshot({ capturedAt: "2026-05-20T00:00:00.000Z", hookCount: 3 });
    const curr = makeSnapshot({ capturedAt: "2026-05-27T00:00:00.000Z", hookCount: 1 });
    const row = extractRow(curr, prev);
    // Hook count drop = 20 pts
    expect(row.securityPostureScore).toBeGreaterThan(0);
  });

  it("returns null schemaVersion for pre-versioned snapshots", () => {
    const snap = makeSnapshot({ schemaVersion: undefined });
    const row = extractRow(snap);
    expect(row.schemaVersion).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serializeCSV
// ---------------------------------------------------------------------------

describe("serializeCSV", () => {
  it("produces correct headers on the first line", () => {
    const rows: ExportRow[] = [];
    const csv = serializeCSV(rows);
    const firstLine = csv.split("\n")[0];
    expect(firstLine).toBe(
      "date,systemPromptChars,systemPromptTokens,toolCount,modelCount,hookCount,injectionRefusedRate,headroomMin,securityPostureScore,schemaVersion",
    );
  });

  it("produces one data row per ExportRow", () => {
    const rows: ExportRow[] = [
      {
        date: "2026-05-20T17:00:00.000Z",
        systemPromptChars: 56963,
        systemPromptTokens: 14241,
        toolCount: 29,
        modelCount: null,
        hookCount: null,
        injectionRefusedRate: null,
        headroomMin: null,
        securityPostureScore: null,
        schemaVersion: "1.0",
      },
    ];
    const csv = serializeCSV(rows);
    const lines = csv.trimEnd().split("\n");
    expect(lines).toHaveLength(2); // header + 1 data row
    expect(lines[1]).toBe("2026-05-20T17:00:00.000Z,56963,14241,29,,,,,,1.0");
  });

  it("serialises null fields as empty strings", () => {
    const rows: ExportRow[] = [
      {
        date: "2026-05-20T17:00:00.000Z",
        systemPromptChars: null,
        systemPromptTokens: null,
        toolCount: null,
        modelCount: null,
        hookCount: null,
        injectionRefusedRate: null,
        headroomMin: null,
        securityPostureScore: null,
        schemaVersion: null,
      },
    ];
    const csv = serializeCSV(rows);
    const dataLine = csv.trimEnd().split("\n")[1];
    expect(dataLine).toBe("2026-05-20T17:00:00.000Z,,,,,,,,,");
  });

  it("serialises multiple rows in order", () => {
    const rows: ExportRow[] = [
      { date: "2026-05-20T17:00:00.000Z", systemPromptChars: 1, systemPromptTokens: 2, toolCount: 3, modelCount: null, hookCount: null, injectionRefusedRate: null, headroomMin: null, securityPostureScore: null, schemaVersion: "1.0" },
      { date: "2026-05-27T17:00:00.000Z", systemPromptChars: 4, systemPromptTokens: 5, toolCount: 6, modelCount: 2, hookCount: 3, injectionRefusedRate: 0.9, headroomMin: 50000, securityPostureScore: 0, schemaVersion: "1.0" },
    ];
    const csv = serializeCSV(rows);
    const lines = csv.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("2026-05-20T17:00:00.000Z");
    expect(lines[2]).toContain("2026-05-27T17:00:00.000Z");
  });

  it("ends with a trailing newline", () => {
    const csv = serializeCSV([]);
    expect(csv.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// serializeJSON
// ---------------------------------------------------------------------------

describe("serializeJSON", () => {
  it("produces a valid JSON array", () => {
    const rows: ExportRow[] = [
      {
        date: "2026-05-20T17:00:00.000Z",
        systemPromptChars: 56963,
        systemPromptTokens: 14241,
        toolCount: 29,
        modelCount: null,
        hookCount: null,
        injectionRefusedRate: null,
        headroomMin: null,
        securityPostureScore: null,
        schemaVersion: "1.0",
      },
    ];
    const json = serializeJSON(rows);
    const parsed = JSON.parse(json) as ExportRow[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it("preserves numeric types (not strings)", () => {
    const rows: ExportRow[] = [
      {
        date: "2026-05-20T17:00:00.000Z",
        systemPromptChars: 56963,
        systemPromptTokens: 14241,
        toolCount: 29,
        modelCount: 3,
        hookCount: 2,
        injectionRefusedRate: 0.9,
        headroomMin: 50000,
        securityPostureScore: 20,
        schemaVersion: "1.0",
      },
    ];
    const parsed = JSON.parse(serializeJSON(rows)) as ExportRow[];
    const row = parsed[0];
    expect(typeof row.systemPromptChars).toBe("number");
    expect(typeof row.toolCount).toBe("number");
    expect(typeof row.injectionRefusedRate).toBe("number");
    expect(typeof row.headroomMin).toBe("number");
    expect(typeof row.securityPostureScore).toBe("number");
  });

  it("serialises null fields as JSON null (not empty string)", () => {
    const rows: ExportRow[] = [
      {
        date: "2026-05-20T17:00:00.000Z",
        systemPromptChars: null,
        systemPromptTokens: null,
        toolCount: null,
        modelCount: null,
        hookCount: null,
        injectionRefusedRate: null,
        headroomMin: null,
        securityPostureScore: null,
        schemaVersion: null,
      },
    ];
    const parsed = JSON.parse(serializeJSON(rows)) as ExportRow[];
    const row = parsed[0];
    expect(row.systemPromptChars).toBeNull();
    expect(row.schemaVersion).toBeNull();
  });

  it("ends with a trailing newline", () => {
    const json = serializeJSON([]);
    expect(json.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildExportRows (integration: reads fixture directory)
// ---------------------------------------------------------------------------

describe("buildExportRows", () => {
  it("returns empty array for a non-existent directory", () => {
    const rows = buildExportRows("/tmp/nonexistent-baselines-fixtures-xyz");
    expect(rows).toEqual([]);
  });

  it("reads all baseline JSON files and skips schema.json / latest.json", async () => {
    // Use the real baselines/ directory as a live fixture.
    const rows = buildExportRows("baselines");
    // Should have at least the known baseline files, excluding schema.json & latest.json
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      expect(typeof row.date).toBe("string");
      // systemPromptChars should be a number for all existing baselines
      expect(typeof row.systemPromptChars).toBe("number");
    }
  });

  it("first row has null securityPostureScore; subsequent rows have a number", () => {
    const rows = buildExportRows("baselines");
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].securityPostureScore).toBeNull();
    for (const row of rows.slice(1)) {
      expect(typeof row.securityPostureScore).toBe("number");
    }
  });

  it("produces rows in ascending date order (sorted by filename)", () => {
    const rows = buildExportRows("baselines");
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i].date).getTime()).toBeGreaterThanOrEqual(
        new Date(rows[i - 1].date).getTime(),
      );
    }
  });
});
