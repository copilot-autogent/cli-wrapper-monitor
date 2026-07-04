import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";
import {
  loadAnnotation,
  loadAnnotations,
  truncateAnnotation,
  ANNOTATION_TRUNCATE_LEN,
} from "./annotations.js";

// ---------------------------------------------------------------------------
// truncateAnnotation
// ---------------------------------------------------------------------------

describe("truncateAnnotation", () => {
  it("returns short text unchanged", () => {
    expect(truncateAnnotation("hello")).toBe("hello");
  });

  it("trims whitespace from both ends", () => {
    expect(truncateAnnotation("  hello  ")).toBe("hello");
  });

  it("truncates at maxLen and appends ellipsis", () => {
    const text = "a".repeat(60);
    const result = truncateAnnotation(text, 50);
    expect(result.length).toBe(50);
    expect(result.endsWith("…")).toBe(true);
  });

  it("does not truncate when text is exactly maxLen", () => {
    const text = "a".repeat(50);
    expect(truncateAnnotation(text, 50)).toBe(text);
  });

  it("uses ANNOTATION_TRUNCATE_LEN as default maxLen", () => {
    const text = "a".repeat(ANNOTATION_TRUNCATE_LEN + 10);
    const result = truncateAnnotation(text);
    expect(result.length).toBe(ANNOTATION_TRUNCATE_LEN);
  });
});

// ---------------------------------------------------------------------------
// loadAnnotation
// ---------------------------------------------------------------------------

describe("loadAnnotation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-monitor-notes-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when file does not exist", () => {
    const result = loadAnnotation(tmpDir, "2026-06-03");
    expect(result).toBeUndefined();
  });

  it("returns file content when file exists", () => {
    writeFileSync(join(tmpDir, "2026-06-03.md"), "Post-PR #383 baseline fix.\n");
    expect(loadAnnotation(tmpDir, "2026-06-03")).toBe("Post-PR #383 baseline fix.");
  });

  it("trims whitespace from file content", () => {
    writeFileSync(join(tmpDir, "2026-07-01.md"), "  note text  \n");
    expect(loadAnnotation(tmpDir, "2026-07-01")).toBe("note text");
  });

  it("returns undefined for empty file", () => {
    writeFileSync(join(tmpDir, "2026-07-01.md"), "   \n");
    expect(loadAnnotation(tmpDir, "2026-07-01")).toBeUndefined();
  });

  it("does not throw when notesDir does not exist", () => {
    expect(() => loadAnnotation("/nonexistent/path/notes", "2026-06-03")).not.toThrow();
    expect(loadAnnotation("/nonexistent/path/notes", "2026-06-03")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loadAnnotations
// ---------------------------------------------------------------------------

describe("loadAnnotations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-monitor-notes-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty object when notes directory does not exist", () => {
    const result = loadAnnotations("/nonexistent/notes");
    expect(result).toEqual({});
  });

  it("returns empty object for empty directory", () => {
    expect(loadAnnotations(tmpDir)).toEqual({});
  });

  it("loads multiple annotations keyed by date", () => {
    writeFileSync(join(tmpDir, "2026-06-03.md"), "PR #383 landed.");
    writeFileSync(join(tmpDir, "2026-06-10.md"), "Model updated.");
    const result = loadAnnotations(tmpDir);
    expect(result["2026-06-03"]).toBe("PR #383 landed.");
    expect(result["2026-06-10"]).toBe("Model updated.");
    expect(Object.keys(result).length).toBe(2);
  });

  it("skips files that do not match YYYY-MM-DD.md pattern", () => {
    writeFileSync(join(tmpDir, "README.md"), "Notes directory.");
    writeFileSync(join(tmpDir, "2026-06-03.md"), "Valid note.");
    writeFileSync(join(tmpDir, "not-a-date.md"), "Should be ignored.");
    const result = loadAnnotations(tmpDir);
    expect(Object.keys(result)).toEqual(["2026-06-03"]);
  });

  it("skips empty annotation files", () => {
    writeFileSync(join(tmpDir, "2026-06-03.md"), "   ");
    expect(loadAnnotations(tmpDir)).toEqual({});
  });
});
