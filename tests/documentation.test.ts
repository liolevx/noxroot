import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { previewRepository } from "../src/core/preview.js";
import { renderPreview } from "../src/output.js";
import { fixtures } from "./helpers.js";

describe("documentation examples", () => {
  it("keeps the README opening and preview excerpt synchronized with a real fixture", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    expect(
      readme.startsWith("# Noxroot\n\nCLI that builds repository context for coding agents"),
    ).toBe(true);
    const output = renderPreview(await previewRepository(path.join(fixtures, "typescript")));
    for (const line of [
      "NOXROOT PREVIEW",
      "Repository files changed: 0",
      "Repository commands executed: 0",
      "Agent calls made: 0",
      "Network requests made by Noxroot: 0",
      "✓ [confirmed] Node.js project — package.json",
      "✓ [confirmed] TypeScript source — tsconfig.json",
      "Proposed changes: 6 files",
      "No repository changes were made.",
    ]) {
      expect(output).toContain(line);
      expect(readme).toContain(line);
    }
  });

  it("documents the application-agent framework boundary", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    expect(readme).toContain("Application-agent frameworks are detected project architectures");
    expect(readme).toContain("runtime sessions, state, memory, and user data");
  });
});
