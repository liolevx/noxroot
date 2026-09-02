import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/fixtures/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
    testTimeout: 15_000,
  },
});
