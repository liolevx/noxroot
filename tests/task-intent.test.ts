import { describe, expect, it } from "vitest";
import { parseTaskIntent } from "../src/core/intent.js";

describe("task intent", () => {
  it.each([
    [
      "Fix the parser but do not change the public API",
      "Fix the parser",
      "do not change the public API",
    ],
    ["Fix the parser and do not publish a release", "Fix the parser", "do not publish a release"],
    ["Improve the CLI while avoiding new commands", "Improve the CLI", "avoiding new commands"],
  ])("separates a required outcome from an inline exclusion: %s", (task, outcome, exclusion) => {
    const intent = parseTaskIntent(task);
    expect(intent.requiredOutcomes).toEqual([outcome]);
    expect(intent.explicitExclusions).toEqual([exclusion]);
  });

  it("does not split an ordinary positive conjunction", () => {
    const intent = parseTaskIntent("Fix parsing and add a regression test");
    expect(intent.requiredOutcomes).toEqual(["Fix parsing and add a regression test"]);
    expect(intent.explicitExclusions).toEqual([]);
  });

  it.each([
    ["Do not deploy and fix the parser", "fix the parser", "Do not deploy", ""],
    ["Fix parser but do not deploy and add tests", "Fix parser", "do not deploy", "add tests"],
  ])("preserves positive work after a negative clause: %s", (task, first, exclusion, second) => {
    const intent = parseTaskIntent(task);
    expect(intent.requiredOutcomes).toEqual(second ? [first, second] : [first]);
    expect(intent.explicitExclusions).toEqual([exclusion]);
  });

  it("keeps a negative object list together", () => {
    const intent = parseTaskIntent("Fix the parser but do not change the API and documentation");
    expect(intent.requiredOutcomes).toEqual(["Fix the parser"]);
    expect(intent.explicitExclusions).toEqual(["do not change the API and documentation"]);
  });
});
