import type { TaskIntent } from "../model.js";

const EXCLUSION = /\b(?:do not|don't|must not|never|without|except(?:ing)?|exclude|avoid)\b/i;
const ACCEPTANCE = /\b(?:acceptance|must|should|when|so that|ensure|verify)\b/i;
const AUTHORITY = /\b(push|merge|deploy|publish|release)\b/gi;

function clauses(task: string): string[] {
  return task
    .split(/(?:\r?\n|[.;](?:\s|$))/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseTaskIntent(task: string): TaskIntent {
  const parts = clauses(task);
  const explicitExclusions = parts.filter((part) => EXCLUSION.test(part));
  const positive = parts.filter((part) => !EXCLUSION.test(part));
  const requestedAuthority = [
    ...new Set(positive.flatMap((part) => [...part.matchAll(AUTHORITY)].map((match) => match[1]!))),
  ].map((value) => value.toLowerCase());
  const acceptanceCriteria = positive.filter((part) => ACCEPTANCE.test(part));
  const requiredOutcomes = positive.filter((part) => !acceptanceCriteria.includes(part));

  return {
    requiredOutcomes: requiredOutcomes.length > 0 ? requiredOutcomes : positive,
    explicitExclusions,
    requestedAuthority,
    acceptanceCriteria,
  };
}

export function relevantIntentText(intent: TaskIntent): string {
  return [...intent.requiredOutcomes, ...intent.acceptanceCriteria].join(" ");
}
