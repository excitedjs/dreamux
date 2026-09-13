# Filter list_bindings by target and Team

## Current state

- Goal: Answer a precise Feishu binding question with optional exact-match query parameters instead of returning the whole routing table
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/add-list-bindings-filters/requirement.md)
- Final solution: [Filters on the tool contract](/.agents/tasks/channel/add-list-bindings-filters/technical-design/final.md)
- Verification: [Evidence](/.agents/tasks/channel/add-list-bindings-filters/verification.md)
- Solution review Issue: Not created — the operator chose the minimal-change fast path, which skips it.
- Blockers: None.
- Next action: None.
- Related tasks: None.

## Solution path ruling

The operator answered the path question card on 2026-09-13 with the
minimal-change fast path, after the TeamLeader stated that the change edits an
MCP tool input contract and is therefore not fast-path eligible under the
skill's own criteria. No solution-review seats and no solution-review Issue.

## Development approval

- Status: Granted 2026-09-13 by the operator, on the development-approval
  question card, against the requirement and final solution recorded here.
- Approval (verbatim): 「批准，进开发」
- Requirement ruling this implements (verbatim): 「就把值得加的那几个加上吧」 —
  the four parameters the survey listed as worth adding, and none of the
  dimensions it listed as declined or as a separate scope question.
- Approved implementation boundary:
  - `packages/channel/feishu-channel/src/tools/routing-tools.ts` — the
    `list_bindings` input schema, argument parsing, and row filtering.
  - `packages/channel/feishu-channel/src/tools/schema.ts` — one enum validator
    beside the existing optional-field validators.
  - `packages/channel/feishu-channel/tests/feishu-routing-tools.test.ts`.
  - One Rush change file, an ordinary note.
  - The knowledge pages that state this tool's contract, if any turn out to.
- Writer: TeamLeader, as the minimal-change fast path prescribes.

## Delivery

- Pull request: [#423](https://github.com/excitedjs/dreamux/pull/423).
- Knowledge closeout: No page changed. `.agents/domains/channel.md`,
  `.agents/domains/dispatcher-skill.md`, and `packages/dreamux/README.md` name
  `list_bindings` without stating its input shape, and the dispatcher-skill page
  defers tool schemas to the channel package's live `tools/list`; the
  `dreamux-maintenance` skill documents the routing document, which this change
  does not touch.
