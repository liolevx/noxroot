import { describe, expect, it } from "vitest";
import { listSavedRestaurants } from "../../lib/restaurant-store";

describe("saved restaurants", () => {
  it("returns a user's favourite restaurants", () => {
    expect(listSavedRestaurants()).toContain("North Star Cafe");
  });
});
