import type { TaskIntent } from "../model.js";

const EXCLUSION =
  /\b(?:do not|don't|must not|never|without|except(?:ing)?|exclude|avoid(?:ing)?)\b/i;
const ACCEPTANCE = /\b(?:acceptance|must|should|when|so that|ensure|verify)\b/i;
const AUTHORITY = /\b(push|merge|deploy|publish|release)\b/gi;
const POSITIVE_ACTION =
  /^(?:add|build|change|create|document|ensure|fix|implement|improve|preserve|refactor|remove|run|support|test|update|write)\b/i;

function splitConjunctions(value: string): string[] {
  const parts = value.split(/\s+and\s+/i);
  if (parts.length === 1) return parts;
  const result: string[] = [];
  for (const part of parts) {
    const previous = result.at(-1);
    const boundary =
      EXCLUSION.test(part) ||
      (previous !== undefined && EXCLUSION.test(previous) && POSITIVE_ACTION.test(part));
    if (boundary || previous === undefined) result.push(part);
    else result[result.length - 1] = `${previous} and ${part}`;
  }
  return result;
}

function clauses(task: string): string[] {
  return task
    .split(/(?:\r?\n|[.;](?:\s|$))/)
    .flatMap((value) => value.split(/\s+(?:but|while)\s+/i))
    .flatMap(splitConjunctions)
    .flatMap((value) => {
      const trimmed = value.trim();
      const without = /\bwithout\b/i.exec(trimmed);
      if (!without || without.index === 0) return [trimmed];
      return [trimmed.slice(0, without.index).trim(), trimmed.slice(without.index).trim()];
    })
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
