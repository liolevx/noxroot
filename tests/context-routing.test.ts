import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/core/context.js";
import { temporaryDirectory } from "./helpers.js";

describe("bounded relevance routing", () => {
  it("ranks reviewer ownership and tests without letting fixtures consume the package", async () => {
    const first = await buildContext("improve reviewer decision safety", path.resolve("."));
    const second = await buildContext("improve reviewer decision safety", path.resolve("."));
    const selected = first.selected.map((item) => item.path);

    expect(first).toEqual(second);
    expect(selected.slice(0, 6)).toContain("src/adapters/agents.ts");
    expect(first.likelyTests).toContain("tests/agent-review.test.ts");
    expect(first.budget.maximumBytes).toBe(16_000);
    expect(first.budget.selectedBytes).toBeLessThan(15_000);
    expect(selected.filter((item) => item.includes("tests/fixtures/"))).toHaveLength(0);
    expect(
      first.selected.find((item) => item.path === "src/adapters/agents.ts")?.reasons,
    ).toContain("content contains task terms “review”, “decision”");
  });

  it("treats route includes as eligibility without blanket relevance", async () => {
    const context = await buildContext("document package release", path.resolve("."));
    const unrelated = context.selected.filter(
      (item) => item.reasons.length === 1 && item.reasons[0]?.startsWith("eligible through route"),
    );
    expect(unrelated).toEqual([]);
  });

  it("preserves negative constraints without activating them as relevance or authority", async () => {
    const context = await buildContext(
      "Improve reviewer output. Do not deploy or change authentication.",
      path.resolve("."),
    );
    expect(context.intent).toMatchObject({
      requiredOutcomes: ["Improve reviewer output"],
      explicitExclusions: ["Do not deploy or change authentication"],
      requestedAuthority: [],
    });
    expect(context.constraints).toContain("Do not deploy or change authentication");
    expect(context.selected.some((item) => /deploy|auth/i.test(item.path))).toBe(false);
  });

  it("keeps an unconventional source root and selects a large directly matched owner", async () => {
    const root = await temporaryDirectory("noxroot-context-owner-");
    try {
      await mkdir(path.join(root, "engine"), { recursive: true });
      await writeFile(path.join(root, "pyproject.toml"), '[project]\nname = "sample"\n');
      await writeFile(
        path.join(root, "engine", "watchlist.py"),
        `# Watchlist owner\n${"watchlist behavior\n".repeat(650)}`,
      );
      await writeFile(path.join(root, "engine", "other.py"), "unrelated = True\n");

      const context = await buildContext("improve watchlist behavior", root);
      expect(context.likelyOwningSource[0]).toBe("engine/watchlist.py");
      expect(
        context.selected.find((item) => item.path === "engine/watchlist.py")?.reasons,
      ).toContain("basename matches task term “watchlist”");
      expect(context.selected.every((item) => item.reasons.length > 0)).toBe(true);
      expect(context.budget.selectedBytes).toBeLessThanOrEqual(context.budget.maximumBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
