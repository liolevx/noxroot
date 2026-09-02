export interface ReviewAssessment {
  required: boolean;
  kinds: Array<"code" | "security" | "ux">;
  reasons: string[];
}

const USER_FACING =
  /(?:^|\/)(?:components?|pages?|views?|screens?|ui)(?:\/|$)|\.(?:tsx|jsx|vue|svelte|css|scss|html)$/i;
const SENSITIVE =
  /(?:^|\/)(?:auth|authentication|authorization|security|permissions?|credentials?|migrations?)(?:\/|\.|$)|(?:^|\/)\.github\/workflows\//i;

export function assessReviewNeed(changedPaths: string[], diff: string): ReviewAssessment {
  const diffPaths = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].flatMap((match) => [
    match[1]!,
    match[2]!,
  ]);
  const actualPaths = [...new Set([...changedPaths, ...diffPaths])];
  const kinds = new Set<ReviewAssessment["kinds"][number]>();
  const reasons: string[] = [];
  if (actualPaths.some((changedPath) => USER_FACING.test(changedPath))) {
    kinds.add("ux");
    reasons.push("The actual diff changes a user-facing surface.");
  }
  if (actualPaths.some((changedPath) => SENSITIVE.test(changedPath))) {
    kinds.add("security");
    reasons.push("The actual diff changes a security-sensitive or workflow surface.");
  }
  const changedLines = diff.split(/\r?\n/).filter((line) => /^[+-](?![+-])/.test(line)).length;
  if (actualPaths.length >= 8 || changedLines >= 400) {
    kinds.add("code");
    reasons.push("The actual diff is broad enough to justify a fresh code review.");
  }
  return { required: kinds.size > 0, kinds: [...kinds], reasons };
}
