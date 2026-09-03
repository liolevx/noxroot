export interface ReviewAssessment {
  required: boolean;
  kinds: Array<"code" | "security" | "ux">;
  reasons: string[];
}

const USER_FACING =
  /(?:^|\/)(?:components?|pages?|views?|screens?|ui)(?:\/|$)|\.(?:tsx|jsx|vue|svelte|css|scss|html)(?:"?(?:\s|$))/i;
const SENSITIVE =
  /(?:^|\/)(?:auth|authentication|authorization|security|permissions?|credentials?|migrations?)(?:\/|\.|$)|(?:^|\/)\.github\/workflows\//i;
const NON_PRODUCT_EVIDENCE = /(?:^|\/)(?:tests?\/fixtures?|fixtures?|testdata)(?:\/|$)/i;
const UX_CHANGE =
  /\b(?:aria-[\w-]+|role=|tabindex|onclick|onchange|onkeydown|onsubmit|href=|disabled=|loading|error)\b|<(?:button|input|form)\b|(?:^|\s)(?:sm|md|lg|xl|2xl):/i;
const UX_REVIEW_REQUEST =
  /\b(?:accessibility|accessible|a11y|keyboard|responsive|mobile|interaction|user flow|usability|ux review|design review)\b/i;

export function assessReviewNeed(
  changedPaths: string[],
  diff: string,
  task = "",
): ReviewAssessment {
  const diffPaths = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].flatMap((match) => [
    match[1]!,
    match[2]!,
  ]);
  const actualPaths = [...new Set([...changedPaths, ...diffPaths])];
  const diffHeaders = diff.match(/^diff --git .+$/gm) ?? [];
  const pathEvidence = [...actualPaths, ...diffHeaders];
  const semanticEvidence = pathEvidence.filter((value) => !NON_PRODUCT_EVIDENCE.test(value));
  const changedContent = diff
    .split(/\r?\n/)
    .filter((line) => /^[+-](?![+-])/.test(line))
    .join("\n");
  const changedLines = changedContent ? changedContent.split(/\r?\n/).length : 0;
  const kinds = new Set<ReviewAssessment["kinds"][number]>();
  const reasons: string[] = [];
  const userFacingPaths = new Set(
    actualPaths.filter(
      (changedPath) => !NON_PRODUCT_EVIDENCE.test(changedPath) && USER_FACING.test(changedPath),
    ),
  );
  const userFacing = semanticEvidence.some((changedPath) => USER_FACING.test(changedPath));
  const explicitUxReview = UX_REVIEW_REQUEST.test(task);
  const interactionChange = UX_CHANGE.test(changedContent);
  const broadUiChange = userFacingPaths.size >= 2 || changedLines >= 80;
  if (userFacing && (explicitUxReview || interactionChange || broadUiChange)) {
    kinds.add("ux");
    reasons.push(
      explicitUxReview
        ? "The task explicitly requests user-experience or accessibility review."
        : interactionChange
          ? "The actual diff changes user interaction, accessibility, or responsive behavior."
          : "The actual diff changes a broad user-facing surface.",
    );
  }
  if (semanticEvidence.some((changedPath) => SENSITIVE.test(changedPath))) {
    kinds.add("security");
    reasons.push("The actual diff changes a security-sensitive or workflow surface.");
  }
  if (Math.max(actualPaths.length, diffHeaders.length) >= 8 || changedLines >= 400) {
    kinds.add("code");
    reasons.push("The actual diff is broad enough to justify a fresh code review.");
  }
  return { required: kinds.size > 0, kinds: [...kinds], reasons };
}
