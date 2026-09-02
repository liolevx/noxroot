import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWithin, normalizeRelative, resolveWithin } from "../src/security/paths.js";

describe("cross-platform path handling", () => {
  it("normalizes platform separators for repository evidence", () => {
    expect(normalizeRelative(path.join("src", "feature", "index.ts"))).toBe("src/feature/index.ts");
  });

  it("accepts descendants and rejects parent traversal", () => {
    const root = path.resolve("fixture-root");
    expect(isWithin(root, path.join(root, "src", "index.ts"))).toBe(true);
    expect(() => resolveWithin(root, path.join("..", "outside.txt"))).toThrow("escapes");
  });
});
