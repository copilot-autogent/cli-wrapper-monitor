/**
 * Unit tests for scripts/generate-dashboard.ts argument parsing.
 *
 * Covers both the space-separated (`--output <path>`) and equals
 * (`--output=<path>`) forms of the --output flag. The equals form is used by
 * the Publish Dashboard workflow (`npm run dashboard -- --output=dist/index.html`).
 */
import { describe, it, expect } from "vitest";
import { parseOutputArg } from "./generate-dashboard.js";

describe("parseOutputArg", () => {
  it("returns the default when no flag is given", () => {
    expect(parseOutputArg([])).toBe("reports/dashboard.html");
  });

  it("parses the space-separated form: --output <path>", () => {
    expect(parseOutputArg(["--output", "foo.html"])).toBe("foo.html");
  });

  it("parses the equals form: --output=<path>", () => {
    expect(parseOutputArg(["--output=dist/index.html"])).toBe("dist/index.html");
  });

  it("handles equals-form paths that themselves contain '='", () => {
    expect(parseOutputArg(["--output=a=b.html"])).toBe("a=b.html");
  });

  it("last flag wins when both forms are supplied", () => {
    expect(parseOutputArg(["--output", "first.html", "--output=second.html"])).toBe(
      "second.html",
    );
  });

  it("ignores unrelated args", () => {
    expect(parseOutputArg(["--verbose", "--output=out.html", "extra"])).toBe("out.html");
  });

  it("throws when space form has no path argument", () => {
    expect(() => parseOutputArg(["--output"])).toThrow(/requires a path/);
  });

  it("throws when equals form has an empty value", () => {
    expect(() => parseOutputArg(["--output="])).toThrow(/requires a path/);
  });
});
