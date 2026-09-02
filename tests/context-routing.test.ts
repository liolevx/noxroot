import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/core/context.js";

describe("bounded relevance routing", () => {
  it("ranks reviewer ownership and tests without letting fixtures consume the package", async () => {
    const first = await buildContext("improve reviewer decision safety", path.resolve("."));
    const second = await buildContext("improve reviewer decision safety", path.resolve("."));
    const selected = first.selected.map((item) => item.path);

    expect(first).toEqual(second);
    expect(selected.slice(0, 6)).toContain("src/adapters/agents.ts");
    expect(first.likelyTests).toContain("tests/orchestration-learning-vcs.test.ts");
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
});
