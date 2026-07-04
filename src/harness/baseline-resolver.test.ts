import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listAllBaselines,
  resolveBaselineByDate,
  findLatestBaseline,
  findPreviousBaseline,
  type BaselineEntry,
} from "./baseline-resolver.js";

// ---------------------------------------------------------------------------
// fs mock
// ---------------------------------------------------------------------------

/**
 * Tracks which "files" exist in the virtual FS.
 * Keys are absolute paths; value is always true.
 */
const mockFiles = new Set<string>();
/**
 * Virtual directory listing: dir path → array of filenames.
 */
const mockDirs = new Map<string, string[]>();

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockImplementation((p: unknown) => {
      const s = String(p);
      return mockFiles.has(s) || mockDirs.has(s);
    }),
    statSync: vi.fn().mockImplementation((p: unknown) => {
      const s = String(p);
      if (mockDirs.has(s)) return { isDirectory: () => true };
      if (mockFiles.has(s)) return { isDirectory: () => false };
      const err = Object.assign(new Error(`ENOENT: ${s}`), { code: "ENOENT" });
      throw err;
    }),
    readdirSync: vi.fn().mockImplementation((p: unknown) => {
      const s = typeof p === "string" ? p : String(p);
      if (mockDirs.has(s)) return mockDirs.get(s)!;
      const err = Object.assign(new Error(`ENOENT: ${s}`), { code: "ENOENT" });
      throw err;
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "/baselines";

function setupBaselines(monthly: string[], weekly: string[]): void {
  mockFiles.clear();
  mockDirs.clear();

  // Always register the baselines root dir (even when empty)
  mockDirs.set(BASE, monthly.map((d) => `${d}.json`));
  for (const d of monthly) {
    mockFiles.add(`${BASE}/${d}.json`);
  }

  // Always register the weekly dir when there are weekly entries
  if (weekly.length > 0) {
    mockDirs.set(`${BASE}/weekly`, weekly.map((d) => `${d}.json`));
    for (const d of weekly) {
      mockFiles.add(`${BASE}/weekly/${d}.json`);
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFiles.clear();
  mockDirs.clear();
});

// ---------------------------------------------------------------------------
// listAllBaselines
// ---------------------------------------------------------------------------

describe("listAllBaselines", () => {
  it("returns monthly entries sorted descending", () => {
    setupBaselines(["2026-05-20", "2026-06-03", "2026-05-31"], []);
    const entries = listAllBaselines(BASE);
    expect(entries.map((e) => e.date)).toEqual(["2026-06-03", "2026-05-31", "2026-05-20"]);
    expect(entries.every((e) => e.type === "monthly")).toBe(true);
  });

  it("returns weekly entries when no monthly dir", () => {
    setupBaselines([], ["2026-06-10", "2026-06-03"]);
    const entries = listAllBaselines(BASE);
    expect(entries.map((e) => e.date)).toEqual(["2026-06-10", "2026-06-03"]);
    expect(entries.every((e) => e.type === "weekly")).toBe(true);
  });

  it("merges monthly and weekly entries sorted descending", () => {
    setupBaselines(["2026-05-20", "2026-06-03"], ["2026-05-27", "2026-06-10"]);
    const entries = listAllBaselines(BASE);
    expect(entries.map((e) => e.date)).toEqual([
      "2026-06-10",
      "2026-06-03",
      "2026-05-27",
      "2026-05-20",
    ]);
  });

  it("places monthly before weekly when same date", () => {
    setupBaselines(["2026-06-03"], ["2026-06-03"]);
    const entries = listAllBaselines(BASE);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("monthly");
    expect(entries[1].type).toBe("weekly");
  });

  it("ignores non-date files (schema.json, latest.json)", () => {
    mockDirs.set(BASE, ["schema.json", "latest.json", "2026-06-03.json", "notes.md"]);
    mockFiles.add(`${BASE}/2026-06-03.json`);
    const entries = listAllBaselines(BASE);
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe("2026-06-03");
  });

  it("returns empty array when baselines dir does not exist", () => {
    // mockDirs is empty so existsSync returns false for BASE
    const entries = listAllBaselines(BASE);
    expect(entries).toEqual([]);
  });

  it("returns absolute paths", () => {
    setupBaselines(["2026-06-03"], ["2026-06-10"]);
    const entries = listAllBaselines(BASE);
    for (const entry of entries) {
      expect(entry.path.startsWith("/")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveBaselineByDate
// ---------------------------------------------------------------------------

describe("resolveBaselineByDate", () => {
  it("resolves a monthly baseline", () => {
    setupBaselines(["2026-06-03"], []);
    const path = resolveBaselineByDate("2026-06-03", BASE);
    expect(path).toBe(`${BASE}/2026-06-03.json`);
  });

  it("resolves a weekly baseline when monthly does not exist", () => {
    setupBaselines([], ["2026-06-10"]);
    const path = resolveBaselineByDate("2026-06-10", BASE);
    expect(path).toBe(`${BASE}/weekly/2026-06-10.json`);
  });

  it("prefers monthly over weekly when both exist", () => {
    setupBaselines(["2026-06-03"], ["2026-06-03"]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const path = resolveBaselineByDate("2026-06-03", BASE);
    expect(path).toBe(`${BASE}/2026-06-03.json`);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("monthly and weekly"));
    stderrSpy.mockRestore();
  });

  it("throws for an invalid date format", () => {
    expect(() => resolveBaselineByDate("20260603", BASE)).toThrow(/Invalid date format/);
    expect(() => resolveBaselineByDate("2026/06/03", BASE)).toThrow(/Invalid date format/);
    expect(() => resolveBaselineByDate("", BASE)).toThrow(/Invalid date format/);
  });

  it("throws for out-of-range month or day", () => {
    expect(() => resolveBaselineByDate("2026-13-01", BASE)).toThrow(/Invalid date/);
    expect(() => resolveBaselineByDate("2026-00-01", BASE)).toThrow(/Invalid date/);
    expect(() => resolveBaselineByDate("2026-06-00", BASE)).toThrow(/Invalid date/);
    expect(() => resolveBaselineByDate("2026-06-32", BASE)).toThrow(/Invalid date/);
  });

  it("throws for structurally valid but impossible calendar dates", () => {
    expect(() => resolveBaselineByDate("2026-02-30", BASE)).toThrow(/Invalid date/);
    expect(() => resolveBaselineByDate("2026-04-31", BASE)).toThrow(/Invalid date/);
  });

  it("throws with --list hint when date not found", () => {
    setupBaselines(["2026-06-03"], []);
    expect(() => resolveBaselineByDate("2026-05-01", BASE)).toThrow(
      /No baseline found for 2026-05-01.*--list/
    );
  });
});

// ---------------------------------------------------------------------------
// findLatestBaseline
// ---------------------------------------------------------------------------

describe("findLatestBaseline", () => {
  it("returns the first entry (highest date) from a sorted list", () => {
    const entries: BaselineEntry[] = [
      { date: "2026-06-10", path: "/a", type: "weekly" },
      { date: "2026-06-03", path: "/b", type: "monthly" },
      { date: "2026-05-20", path: "/c", type: "monthly" },
    ];
    expect(findLatestBaseline(entries)?.date).toBe("2026-06-10");
  });

  it("returns null for an empty list", () => {
    expect(findLatestBaseline([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findPreviousBaseline
// ---------------------------------------------------------------------------

describe("findPreviousBaseline", () => {
  const entries: BaselineEntry[] = [
    { date: "2026-06-10", path: "/d", type: "weekly" },
    { date: "2026-06-03", path: "/c", type: "monthly" },
    { date: "2026-05-31", path: "/b", type: "monthly" },
    { date: "2026-05-20", path: "/a", type: "monthly" },
  ];

  it("returns the entry just before the current date", () => {
    expect(findPreviousBaseline("2026-06-10", entries)?.date).toBe("2026-06-03");
    expect(findPreviousBaseline("2026-06-03", entries)?.date).toBe("2026-05-31");
    expect(findPreviousBaseline("2026-05-31", entries)?.date).toBe("2026-05-20");
  });

  it("returns null when current date is the oldest entry", () => {
    expect(findPreviousBaseline("2026-05-20", entries)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(findPreviousBaseline("2026-06-03", [])).toBeNull();
  });

  it("skips entries on the same date (strict less-than)", () => {
    const withDupe: BaselineEntry[] = [
      { date: "2026-06-03", path: "/monthly", type: "monthly" },
      { date: "2026-06-03", path: "/weekly", type: "weekly" },
      { date: "2026-05-31", path: "/prev", type: "monthly" },
    ];
    // Looking for previous of "2026-06-03" → should return "2026-05-31", not another "2026-06-03"
    expect(findPreviousBaseline("2026-06-03", withDupe)?.date).toBe("2026-05-31");
  });
});
