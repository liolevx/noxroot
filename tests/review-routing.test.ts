import { describe, expect, it } from "vitest";
import { assessReviewNeed } from "../src/orchestration/review.js";

describe("actual-diff review routing", () => {
  it("routes a user-facing diff to UX review without relying on browser tooling", () => {
    expect(
      assessReviewNeed(
        ["src/components/Navigation.tsx"],
        "diff --git a/src/components/Navigation.tsx b/src/components/Navigation.tsx",
      ),
    ).toMatchObject({ required: true, kinds: ["ux"] });
  });

  it("does not route a backend-only diff to UX review merely because tooling may exist", () => {
    expect(
      assessReviewNeed(
        ["src/server/cache.ts"],
        "diff --git a/src/server/cache.ts b/src/server/cache.ts",
      ),
    ).toEqual({ required: false, kinds: [], reasons: [] });
  });

  it("routes security-sensitive paths from the actual diff", () => {
    expect(
      assessReviewNeed([], "diff --git a/src/auth/session.ts b/src/auth/session.ts"),
    ).toMatchObject({ required: true, kinds: ["security"] });
  });
});
