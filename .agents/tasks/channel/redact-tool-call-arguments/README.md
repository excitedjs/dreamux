# Redact tool call arguments and invocations

## Current state

- Goal: Run every projected tool.call member through the redactor, removing the argument/invocation exemption so a secret in a command or its arguments cannot reach a chat surface
- State: `review`
- Requirement: [Current requirement](/.agents/tasks/channel/redact-tool-call-arguments/requirement.md)
- Final solution: [Final technical design](/.agents/tasks/channel/redact-tool-call-arguments/technical-design/final.md)
- Solution review Issue: Not created — the operator waived the solution stage.
- Blockers: None.
- Next action: External review on the PR, then merge into `next`.
- Related tasks: supersedes the argument-exemption ruling recorded in
  [`refine-cot-tool-details-and-notifications`](/.agents/tasks/channel/refine-cot-tool-details-and-notifications/README.md).

## Development approval

- Status: Granted 2026-09-11 by the operator.
- Approval (verbatim): 「省掉方案阶段，直接改」
- Requirement ruling this implements (verbatim): 「全量脱敏，跟其它成员一视同仁」
- Task placement ruling (verbatim): 「新建任务，supersedes 旧裁定」
- Fast-path override: the workflow bars the minimal-change fast path for a
  security-boundary change. The approval above was given against an option that
  stated that consequence, so it is also the operator's override of that bar.
  The solution stage and its three-reviewer consultation are skipped; the
  independent implementation review still runs.
- Approved implementation boundary:
  - `packages/dreamux/src/channel/conversation-projection.ts` — the `tool.call`
    projection branch only.
    - **Extended by the TeamLeader, operator confirmation pending.**
      `INLINE_SECRET_RE` was also changed. Widening redaction to
      `arguments_json` put that pattern in front of a shape it had never seen —
      a JSON string nested inside another — and it failed on three of them:
      `TOKEN=\"abc\"` leaked its value, every line of a multi-line payload but
      the first went unmatched, and a redacted line swallowed the lines below
      it. Meeting acceptance criterion 2 in its most likely real instance was
      impossible without the fix, so it was made and reported in chat. The
      pattern is shared by every redacted member, so this reaches beyond
      `tool.call`: that is the TeamLeader's inference from 「全量脱敏，跟其它成
      员一视同仁」, not the operator's stated decision. Whether it stays in this
      PR or is split out is his call, and is asked separately.
  - `packages/dreamux-types/src/teammate.ts` — the `tool.call` variant's doc
    comments only; no field shape changes.
  - `packages/dreamux/tests/cot-projection-privacy.test.ts` — the two cases that
    lock the old exemption, plus coverage for the new criteria.
  - `.agents/product/README.md`, `.agents/domains/channel.md` — the recorded
    contract.
  - One Rush change file per affected package, ordinary note.

## Delivery

- Pull request / CI / merge: PR open against `next`; awaiting review and CI.
- Knowledge closeout: `.agents/product/README.md` and `.agents/domains/channel.md` updated in the same change; `.agents/scripts/check.sh` clean.
