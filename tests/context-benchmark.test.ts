import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext } from "../src/core/context.js";
import { temporaryDirectory } from "./helpers.js";

interface BenchmarkCase {
  task: string;
  owner: string;
  test: string;
}

const concepts = {
  next: ["restaurants", "projects", "profile", "invoices", "notifications"],
  typescript: ["sessions", "webhooks", "uploads", "permissions", "pagination"],
  python: ["retries", "embeddings", "queues", "exports", "imports"],
  go: ["cache", "middleware", "telemetry", "routing", "validation"],
  rust: ["matcher", "ignore", "parser", "printer", "decoder"],
  ruby: ["billing", "subscriptions", "refunds", "coupons", "receipts"],
} as const;

function benchmarkCases(): BenchmarkCase[] {
  return [
    ...concepts.next.map((concept) => ({
      task: `change the ${concept} page`,
      owner: `app/${concept}/page.tsx`,
      test: `tests/${concept}/page.test.tsx`,
    })),
    ...concepts.typescript.map((concept) => ({
      task: `change the ${concept} controller`,
      owner: `src/${concept}/controller.ts`,
      test: `tests/${concept}/controller.test.ts`,
    })),
    ...concepts.python.map((concept) => ({
      task: `change the ${concept} worker`,
      owner: `service/${concept}/worker.py`,
      test: `tests/${concept}/test_worker.py`,
    })),
    ...concepts.go.map((concept) => ({
      task: `change the ${concept} handler`,
      owner: `internal/${concept}/handler.go`,
      test: `internal/${concept}/handler_test.go`,
    })),
    ...concepts.rust.map((concept) => ({
      task: `change the ${concept} engine`,
      owner: `crates/${concept}/src/engine.rs`,
      test: `crates/${concept}/tests/engine.rs`,
    })),
    ...concepts.ruby.map((concept) => ({
      task: `change the ${concept} service`,
      owner: `lib/${concept}/service.rb`,
      test: `test/${concept}/service_test.rb`,
    })),
  ];
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((operation) => operation())));

describe("task-context routing benchmark", () => {
  it("finds the expected owner and test across 30 cross-stack tasks", async () => {
    const root = await temporaryDirectory("noxroot-context-benchmark-");
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, ".noxroot", "knowledge"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "Read .noxroot/knowledge/INDEX.md.\n");
    await writeFile(path.join(root, ".noxroot", "knowledge", "INDEX.md"), "# Knowledge\n");
    await writeFile(
      path.join(root, ".noxroot", "routes.yml"),
      [
        "version: 1",
        "routes:",
        "  - id: default",
        "    match: ['**/*']",
        "    include: ['AGENTS.md', '.noxroot/knowledge/INDEX.md', 'app/**', 'src/**', 'service/**', 'internal/**', 'crates/**', 'lib/**', 'test/**', 'tests/**']",
        "",
      ].join("\n"),
    );
    const cases = benchmarkCases();
    for (const item of cases) {
      await mkdir(path.dirname(path.join(root, item.owner)), { recursive: true });
      await mkdir(path.dirname(path.join(root, item.test)), { recursive: true });
      await writeFile(path.join(root, item.owner), `// owner for ${item.task}\n`);
      await writeFile(path.join(root, item.test), `// direct test for ${item.task}\n`);
    }

    for (const item of cases) {
      const context = await buildContext(item.task, root);
      expect.soft(context.likelyOwningSource, item.task).toContain(item.owner);
      expect.soft(context.likelyTests, item.task).toContain(item.test);
      expect
        .soft(
          context.selected.map((selected) => selected.path),
          item.task,
        )
        .toContain(item.owner);
      expect
        .soft(context.budget.selectedBytes, item.task)
        .toBeLessThanOrEqual(context.budget.maximumBytes);
    }
    expect(cases).toHaveLength(30);
  });
});
