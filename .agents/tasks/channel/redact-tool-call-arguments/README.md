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
  - `packages/dreamux-utils/src/redaction.ts` (new) — the whole redaction
    capability: one list of secret key names, the text rules, and `redactJson`.
  - `packages/dreamux/src/channel/conversation-projection.ts` — the `tool.call`
    projection branch; the rules it used to own now live in utils.
  - `packages/dreamux/src/config/config-helpers.ts`,
    `packages/dreamux/src/platform/logger.ts` — call the shared capability
    instead of keeping their own copy of the key-name list.
  - `packages/dreamux-types/src/teammate.ts` — the `tool.call` variant's doc
    comments only; no field shape changes.
  - Tests: the redaction rules' own cases move to
    `packages/dreamux-utils/tests/redaction.test.ts`; the projection keeps every
    projection-level case. Two pinned surface tests gain the new module.
  - `.agents/product/README.md`, `.agents/domains/channel.md`,
    `.agents/domains/current-architecture.md` — the recorded contract.
  - One Rush change file per affected package, ordinary notes.

## Rulings during implementation

Implementation surfaced two questions the operator settled, both 2026-09-11.

- **Where the capability lives.** 「这个事情还是比较复杂的，给整个脱敏能力抽到
  utils 包里去，不要放在 core 包了」
- **How a structured payload is redacted.** Asked as A (keep patching the text
  pattern so it can read secrets through JSON escaping) or B (redact
  `arguments`/`result` by walking the `JsonValue` before it is serialized, and
  text-redact only what is genuinely text). Answer: 「好，按照B 来做」

B settles the question this task's README previously carried as pending: because
every string the walk reaches is ordinary text, the text pattern needed no
change at all, and `INLINE_SECRET_RE` is `next`'s pattern unmodified. The
TeamLeader's earlier extension of it is reverted, so nothing here reaches past
the `tool.call` members into the other redacted members' behavior.

One behavior change does reach further, and is deliberate: the host logger kept
a shorter copy of the secret key-name list and never hid `api_key`,
`private_key`, or `client_secret`. Sharing one list fixes that.

## Delivery

- Pull request / CI / merge: PR open against `next`; awaiting review and CI.
- Knowledge closeout: `.agents/product/README.md` and `.agents/domains/channel.md` updated in the same change; `.agents/scripts/check.sh` clean.
