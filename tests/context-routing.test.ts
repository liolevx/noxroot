import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/core/context.js";
import { temporaryDirectory } from "./helpers.js";
import { fixtureCopy } from "./helpers.js";

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

  it("excludes fixture trees unless the task explicitly targets a fixture", async () => {
    const repository = await temporaryDirectory("noxroot-context-fixture-boundary-");
    try {
      await mkdir(path.join(repository, "src"));
      await mkdir(path.join(repository, "tests", "fixtures", "sample"), { recursive: true });
      await writeFile(path.join(repository, "src", "ranking.ts"), "export const ranking = true;\n");
      await writeFile(
        path.join(repository, "tests", "fixtures", "sample", "ranking.test.ts"),
        "// ranking fixture\n",
      );

      const ordinary = await buildContext("improve context ranking", repository);
      expect(ordinary.selected.some((item) => item.path.includes("tests/fixtures"))).toBe(false);
      const explicit = await buildContext("update the ranking fixture", repository);
      expect(explicit.selected.some((item) => item.path.includes("tests/fixtures"))).toBe(true);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
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

  it("names an oversized direct owner without exceeding the selected context budget", async () => {
    const root = await temporaryDirectory("noxroot-context-oversized-owner-");
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "package.json"), '{"name":"sample"}\n');
      await writeFile(
        path.join(root, "src", "context-ranking.ts"),
        `export const contextRanking = true;\n${"// context ranking behavior\n".repeat(900)}`,
      );

      const context = await buildContext("improve context ranking", root);
      expect(context.likelyOwningSource[0]).toBe("src/context-ranking.ts");
      expect(context.selected.map((item) => item.path)).not.toContain("src/context-ranking.ts");
      expect(context.budget.selectedBytes).toBeLessThanOrEqual(context.budget.maximumBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a large instruction entrypoint consume the entire task budget", async () => {
    const root = await temporaryDirectory("noxroot-context-large-instructions-");
    try {
      await mkdir(path.join(root, "src"));
      await mkdir(path.join(root, "tests"));
      await writeFile(path.join(root, "package.json"), '{"name":"sample"}\n');
      await writeFile(
        path.join(root, "AGENTS.md"),
        `# Repository instructions\n\n${"General repository guidance.\n".repeat(700)}`,
      );
      await writeFile(path.join(root, "src", "retry.ts"), "export const retry = true;\n");
      await writeFile(path.join(root, "tests", "retry.test.ts"), "// retry test\n");

      const context = await buildContext("improve retry behavior", root);
      const selected = context.selected.map((item) => item.path);

      expect(selected).not.toContain("AGENTS.md");
      expect(selected).toContain("src/retry.ts");
      expect(selected).toContain("tests/retry.test.ts");
      expect(context.constraints).toContain(
        "Follow AGENTS.md as the repository instruction entrypoint; load its relevant references selectively.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds a bounded task brief for a conventional Next.js feature", async () => {
    const fixture = await fixtureCopy("nextjs");
    try {
      const context = await buildContext(
        "add a page where users can save favourite restaurants",
        fixture.root,
      );
      const selected = context.selected.map((item) => item.path);

      expect(context.confidence).toBe("high");
      expect(context.likelyOwningSource).toContain("app/restaurants/page.tsx");
      expect(context.likelyOwningSource).toContain("components/restaurants/saved-restaurants.tsx");
      expect(context.likelyTests).toContain("tests/restaurants/saved-restaurants.test.tsx");
      expect(context.requiredVerification.map((command) => command.id)).toEqual([
        "lint",
        "typecheck",
        "test",
        "build",
      ]);
      expect(selected).not.toContain("app/settings/page.tsx");
      expect(selected).not.toContain("components/settings/profile-form.tsx");
      expect(context.budget.selectedBytes).toBeLessThan(context.budget.maximumBytes);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps a standalone Claude instruction entrypoint in the portable task brief", async () => {
    const root = await temporaryDirectory("noxroot-context-claude-");
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(
        path.join(root, "CLAUDE.md"),
        "# Claude instructions\n\nKeep public error messages stable.\n",
      );
      await writeFile(path.join(root, "package.json"), '{"name":"sample"}\n');
      await writeFile(path.join(root, "src", "errors.ts"), "export const message = 'stable';\n");

      const context = await buildContext("improve public error messages", root);

      expect(context.selected.map((item) => item.path)).toContain("CLAUDE.md");
      expect(context.constraints).toContain("Read CLAUDE.md before changing its routed surface.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a direct path match when broader files could consume the context budget", async () => {
    const root = await temporaryDirectory("noxroot-context-term-coverage-");
    try {
      await mkdir(path.join(root, "app", "dashboard", "invoices"), { recursive: true });
      await mkdir(path.join(root, "app", "ui"), { recursive: true });
      await writeFile(path.join(root, "package.json"), '{"name":"sample"}\n');
      const broadSource = "export const copy = 'dashboard invoice empty state';\n".repeat(52);
      for (const name of ["archive", "create", "edit", "overview", "settings"]) {
        await writeFile(
          path.join(root, "app", "dashboard", "invoices", `${name}.tsx`),
          broadSource,
        );
      }
      await writeFile(
        path.join(root, "app", "ui", "search.tsx"),
        "export function Search() { return <input aria-label='search' />; }\n".repeat(10),
      );

      const context = await buildContext("improve the dashboard invoice search empty state", root);

      expect(context.selected.map((item) => item.path)).toContain("app/ui/search.tsx");
      expect(context.budget.selectedBytes).toBeLessThanOrEqual(context.budget.maximumBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes language-native test filenames outside a test directory", async () => {
    const root = await temporaryDirectory("noxroot-context-native-tests-");
    try {
      await mkdir(path.join(root, "binding"), { recursive: true });
      await writeFile(path.join(root, "go.mod"), "module example.test/sample\n");
      await writeFile(
        path.join(root, "binding", "multipart_form_mapping.go"),
        "package binding\nfunc cleanupMultipart() {}\n",
      );
      await writeFile(
        path.join(root, "binding", "multipart_form_mapping_test.go"),
        "package binding\nfunc TestCleanupMultipart() {}\n",
      );

      const context = await buildContext("fix multipart form cleanup", root);

      expect(context.likelyOwningSource).toContain("binding/multipart_form_mapping.go");
      expect(context.likelyTests).toContain("binding/multipart_form_mapping_test.go");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps generated recordings and payload artifacts out of focused context", async () => {
    const root = await temporaryDirectory("noxroot-context-artifacts-");
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      await mkdir(path.join(root, "tests", "cassettes"), { recursive: true });
      await mkdir(path.join(root, "tests", "canary", "payloads"), { recursive: true });
      await mkdir(path.join(root, "tests", "golden"), { recursive: true });
      await writeFile(path.join(root, "package.json"), '{"name":"sample"}\n');
      await writeFile(path.join(root, "src", "retry.ts"), "export function retry() {}\n");
      await writeFile(path.join(root, "tests", "retry.test.ts"), "// retry behavior\n");
      await writeFile(path.join(root, "tests", "cassettes", "retry.yaml"), "retry: recorded\n");
      await writeFile(
        path.join(root, "tests", "canary", "payloads", "retry.json"),
        '{"retry":"sample"}\n',
      );
      await writeFile(
        path.join(root, "tests", "canary", "retry-findings.md"),
        "# Retry canary findings\n\nRetry behavior notes.\n",
      );
      await writeFile(path.join(root, "tests", "golden", "retry-output.md"), "retry output\n");

      const context = await buildContext("improve retry behavior", root);
      const selected = context.selected.map((item) => item.path);
      expect(context.likelyOwningSource).toContain("src/retry.ts");
      expect(context.likelyTests).toContain("tests/retry.test.ts");
      expect(selected).not.toContain("tests/cassettes/retry.yaml");
      expect(selected).not.toContain("tests/canary/payloads/retry.json");
      expect(selected).not.toContain("tests/canary/retry-findings.md");
      expect(selected).not.toContain("tests/golden/retry-output.md");

      const explicit = await buildContext("update the retry canary findings", root);
      expect(explicit.selected.map((item) => item.path)).toContain(
        "tests/canary/retry-findings.md",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
