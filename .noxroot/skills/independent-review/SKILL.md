---
name: independent-review
description:
  Independently review a verified repository diff; use for fresh-context approval, change requests,
  or a blocked decision.
---

# Independent review

Inspect the diff independently of worker rationale. Check acceptance criteria, correctness,
security, regression risk, architecture boundaries, and test adequacy. Cite specific evidence and
severity; block when evidence is insufficient. Propose learning candidates only for reusable
lessons.

For automated mode, emit exactly one JSON object and no prose:

```json
{
  "schemaVersion": 2,
  "taskId": "copy from task package",
  "changeId": "copy from task package",
  "decision": "approved|changes-requested|blocked",
  "summary": "factual summary",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "path": "optional/path",
      "evidence": "specific evidence",
      "requiredOutcome": "required result"
    }
  ],
  "learningCandidates": []
}
```
