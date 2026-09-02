import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { previewRepository } from "../src/core/preview.js";
import { temporaryDirectory } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((operation) => operation())));

it("treats application-agent frameworks as ordinary architecture without hard-coded integrations", async () => {
  const root = await temporaryDirectory();
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "pyproject.toml"),
    `[project]
name = "agent-application"
version = "0.0.0"
dependencies = ["agno", "pydantic-ai", "google-adk"]
`,
  );
  const preview = await previewRepository(root);
  expect(preview.profile.evidence.map((item) => item.claim)).toEqual(["Python project"]);
  const proposalText = preview.proposedFiles.map((item) => item.content ?? "").join("\n");
  expect(proposalText).toContain("application runtime sessions");
  expect(proposalText.toLowerCase()).not.toContain("agno");
  expect(proposalText.toLowerCase()).not.toContain("pydanticai");
  expect(proposalText.toLowerCase()).not.toContain("google adk");
});
