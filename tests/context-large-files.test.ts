import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildContext } from "../src/core/context.js";
import { renderContext } from "../src/output.js";
import { previewRepository } from "../src/core/preview.js";
import { applyProposals } from "../src/core/init.js";
import { temporaryDirectory } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

async function repository(files: Record<string, string>): Promise<string> {
  const root = await temporaryDirectory("noxroot-large-context-");
  roots.push(root);
  for (const [file, content] of Object.entries({
    ".noxroot/verification.yml":
      "version: 1\ncommands:\n  - id: syntax\n    executable: node\n    args: ['--check', 'core.js']\n    cwd: .\n    appliesTo: ['**/*']\n",
    ...files,
  })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

it("selects a C parser implementation rather than JSON documentation tooling", async () => {
  const root = await repository({
    "src/jv_parse.c":
      "// Report invalid JSON input with line and column information\nint parse_json(void) { return 0; }\n",
    "docs/json.js": "// JSON search index for documentation\n",
    "tests/json.test.c": "// invalid JSON line and column regression\n",
  });
  const context = await buildContext(
    "report invalid JSON input with line and column information",
    root,
  );
  expect(context.likelyOwningSource[0]).toBe("src/jv_parse.c");
  expect(context.selected.map((item) => item.path)).toContain("src/jv_parse.c");
});

it("recognizes native version implementations and keeps declarations distinct", async () => {
  const root = await repository({
    "src/sodium/version.c": "const char *sodium_version_string(void) { return VERSION; }\n",
    "include/sodium/version.h": "const char *sodium_version_string(void);\n",
  });
  const context = await buildContext(
    "report the library version through the public version API",
    root,
  );
  expect(context.likelyOwningSource).toContain("src/sodium/version.c");
  expect(context.selected.map((item) => item.path)).toContain("src/sodium/version.c");
  expect(context.budget.selectedBytes).toBeLessThanOrEqual(16000);
});

it("does not let declarations and docs exhaust inspection before a generic implementation", async () => {
  const files: Record<string, string> = {
    "types/scroll-position.d.ts": "export declare function restoreScrollPosition(): void;\n",
    "packages/kit/src/runtime/client/client.js": `${"// unrelated\n".repeat(1200)}function restoreScrollPosition() { /* navigating back */ }\n`,
  };
  for (let i = 0; i < 12; i++)
    files[`docs/scroll-position-${i}.md`] = "scroll position documentation\n".repeat(3300);
  const root = await repository(files);
  const context = await buildContext("restore scroll position when navigating back", root);
  expect(context.likelyOwningSource).not.toContain("types/scroll-position.d.ts");
  expect(context.selected.map((item) => item.path)).toContain(
    "packages/kit/src/runtime/client/client.js",
  );
  expect(context.budget.selectedBytes).toBeLessThanOrEqual(16000);
  expect(context.confidence).not.toBe("high");
});

it("finds a large generically named implementation and budgets exact line ranges", async () => {
  const lines = [
    ...Array.from({ length: 700 }, () => "// unrelated padding é\r\n"),
    "function parseIntegerRoute(value) {\r\n",
    "  return Number(value); // preserve leading zero integer route semantics\r\n",
    "}\r\n",
    ...Array.from({ length: 6000 }, () => "// unrelated padding é\r\n"),
  ];
  const root = await repository({
    "core.js": lines.join(""),
    "test/route.test.js": "// leading zero integer route regression\n",
    "plugins/auth/test.py": "# route request authentication\n",
  });
  const context = await buildContext("preserve leading zero integer route behavior", root);
  expect(context).toEqual(await buildContext(context.task, root));
  expect(context.likelyOwningSource[0]).toBe("core.js");
  expect(context.likelyOwningSource).not.toContain("plugins/auth/test.py");
  const selected = context.selected.find((item) => item.path === "core.js");
  expect(selected).toMatchObject({ sourceBytes: Buffer.byteLength(lines.join("")) });
  expect(selected?.lineRanges?.some((range) => range.start <= 702 && range.end >= 702)).toBe(true);
  expect(selected?.lineRanges?.length).toBeLessThanOrEqual(3);
  const bytes = selected?.lineRanges?.reduce(
    (total, range) => total + Buffer.byteLength(lines.slice(range.start - 1, range.end).join("")),
    0,
  );
  expect(selected?.bytes).toBe(bytes);
  expect(context.budget.selectedBytes).toBe(
    context.selected.reduce((sum, item) => sum + item.bytes, 0),
  );
  expect(context.budget.selectedBytes).toBeLessThanOrEqual(16_000);
  expect(context.confidence).toBe("partial");
  expect(context.unknowns.join(" ")).toContain("Partial implementation context");
  for (const verbose of [false, true]) {
    expect(renderContext(context, { verbose })).toMatch(/core\.js.*lines \d+-\d+.*partial/);
  }
});

it("does not award high confidence to tests misclassified as implementation", async () => {
  const root = await repository({
    "plugins/cache/test.py": "# integer route regression\n",
    "plugins/cache/adapter.py": "# route route route route unrelated adapter\n",
    "test/test_route.py": "# integer route regression\n",
  });
  const context = await buildContext("integer route regression", root);
  expect(context.likelyOwningSource).toEqual([]);
  expect(context.confidence).toBe("insufficient");
});

it("reports an omitted owner rather than high confidence when only a path matches", async () => {
  const root = await repository({
    "core.js": "export const unrelated = true;\n",
    "src/integer-route.js": "x".repeat(110_000),
    "test/integer-route.test.js": "// integer route\n",
  });
  const context = await buildContext("integer route", root);
  expect(context.likelyOwningSource).toContain("src/integer-route.js");
  expect(context.confidence).not.toBe("high");
  expect(context.unknowns.join(" ")).toContain("Implementation not selected");
});

it("keeps relevant text beyond the inspection limit unknown instead of pretending it was read", async () => {
  const root = await repository({
    "core.js": `${"// filler\n".repeat(11_000)}function parseIntegerRoute() {}\n`,
    "test/route.test.js": "// integer route regression\n",
  });
  const context = await buildContext("integer route", root);
  expect(context.selected.map((item) => item.path)).not.toContain("core.js");
  expect(context.confidence).toBe("insufficient");
  expect(context.unknowns.join(" ")).toContain("Content inspection was bounded");
});

it("does not excerpt excluded routes or sensitive source files", async () => {
  const root = await repository({
    ".noxroot/config.yml": "version: 1\nsensitivePaths: ['private/**']\n",
    ".noxroot/routes.yml":
      "version: 1\nroutes:\n  - id: route\n    match: ['route']\n    include: ['src/**']\n    exclude: ['src/blocked.js']\n",
    "private/core.js": "function parseIntegerRoute() {}\n".repeat(4000),
    "src/blocked.js": "function parseIntegerRoute() {}\n".repeat(4000),
    "src/route.js": "function route() {}\n",
  });
  const context = await buildContext("integer route", root);
  expect(context.selected.map((item) => item.path)).not.toContain("private/core.js");
  expect(context.selected.map((item) => item.path)).not.toContain("src/blocked.js");
});

it("keeps root-level implementation eligible after fresh initialization", async () => {
  const root = await repository({
    "core.js": `function groupBy() {}\n${"// unused\n".repeat(6000)}`,
    "test/collections.js": "// groupBy order regression\n",
  });
  await applyProposals(await previewRepository(root));
  const context = await buildContext("test groupBy order", root);
  expect(context.likelyOwningSource).toContain("core.js");
  expect(
    context.selected.find((item) => item.path === "core.js")?.lineRanges?.length,
  ).toBeGreaterThan(0);
});

it("preserves custom route boundaries and explains an excluded source pool", async () => {
  const root = await repository({
    ".noxroot/routes.yml":
      "version: 1\nroutes:\n  - id: custom\n    match: ['**/*']\n    include: ['test/**']\n",
    "core.js": "function groupBy() {}\n".repeat(5000),
    "test/collections.js": "// groupBy order\n",
  });
  const context = await buildContext("groupBy order", root);
  expect(context.likelyOwningSource).toEqual([]);
  expect(context.confidence).toBe("insufficient");
  expect(context.unknowns.join(" ")).toContain("Active routes exclude source files");
  expect(
    (await previewRepository(root)).proposedFiles.some(
      (file) => file.path === ".noxroot/routes.yml",
    ),
  ).toBe(false);
});

it("keeps minified duplicates out unless explicitly requested", async () => {
  const root = await repository({
    "core.js": "function groupBy() {}\n",
    "core-min.js": "function groupBy() {}\n",
    "test/collections.js": "// groupBy\n",
  });
  const ordinary = await buildContext("groupBy", root);
  expect(ordinary.likelyOwningSource).toEqual(["core.js"]);
  const explicit = await buildContext("inspect minified groupBy", root);
  expect(explicit.likelyOwningSource).toContain("core-min.js");
  const filename = await buildContext("inspect core-min.js", root);
  expect(filename.likelyOwningSource[0]).toBe("core-min.js");
});

it("respects a smaller configured budget without hiding partial or omitted evidence", async () => {
  const root = await repository({
    ".noxroot/config.yml": "version: 1\ncontext:\n  budgetBytes: 500\n",
    "core.js": `function groupBy() {}\n${"// é padding\n".repeat(10_000)}`,
    "test/collections.js": "// groupBy\n",
  });
  const context = await buildContext("groupBy", root);
  expect(context.budget.maximumBytes).toBe(500);
  expect(context.budget.selectedBytes).toBeLessThanOrEqual(500);
  expect(context.confidence).not.toBe("high");
  expect(context.unknowns.length).toBeGreaterThan(0);
});
