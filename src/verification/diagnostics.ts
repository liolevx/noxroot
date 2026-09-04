import { stripVTControlCharacters } from "node:util";
import type { VerificationResult } from "../model.js";

export function failureDetail(result: VerificationResult): string {
  if (result.status === "passed") return "";
  const output = stripVTControlCharacters(result.evidence.stderr || result.evidence.stdout)
    .replace(/\s+/g, " ")
    .trim();
  return [
    ...(result.status === "timed-out" ? [`limit ${result.command.timeoutMs}ms`] : []),
    ...(output
      ? [
          `last output${result.evidence.outputTruncated || output.length > 240 ? " (truncated)" : ""}: ${output.slice(-240)}`,
        ]
      : ["No output captured"]),
  ].join(" · ");
}

export const TIMEOUT_NEXT =
  "Inspect the check and its environment; do not disable sandboxing or remove the check to obtain a pass.";
