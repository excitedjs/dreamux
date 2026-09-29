# Add the Feishu remote-control command

## Current state

- Goal: Let operators enable or disable remote control for Claude Code and Codex through /rc, /rc on, and /rc off in Feishu
- State: `intake`
- Requirement: [Current requirement](/.agents/tasks/channel/add-remote-control-command/requirement.md)
- Final solution: [Reviewed solution](/.agents/tasks/channel/add-remote-control-command/technical-design/final.md).
- Solution review Issue: https://github.com/excitedjs/dreamux/issues/452
- Blockers: Development approval is pending. Native live validation, including shared-enrollment behavior, belongs to implementation acceptance rather than another design mechanism.
- Next action: Before implementation, revalidate the archived proposal against current `next` and repository policies, then obtain development approval.
- Related tasks: Builds on [Feishu slash commands](/.agents/tasks/channel/add-feishu-slash-commands/README.md) and [Feishu /bind and /help](/.agents/tasks/channel/add-bind-and-help-slash-commands/README.md).

## Task authorization

- On 2026-09-21, the operator approved creating a new task and continuing requirements and solution work for both runtimes through the task-creation question card.
- On the same date, the operator clarified that the global switch in `config.json` must be removed and that losing a manual setting when the process restarts is acceptable.
- The operator selected a TeamLeader-authored solution with independent Seed, Codex, and Claude review: "你直接写方案，拉 seed\\codex\\claude 三位去 review。"
- During solution approval review, the operator selected a generic record result
  with provider-owned fields instead of a fixed connection interface or union.
- Solution input: The linked requirement incorporating the 2026-09-21 configuration-removal and process-lifetime rulings.
- On 2026-09-29, the operator requested an archive PR for the local changes:
  "先给本地的变更存档一下，开一个 pr 上去。" This authorizes committing and
  publishing the design record, not implementing the feature.

## Solution review

- On 2026-09-21, the TeamLeader submitted the same draft to independent Seed,
  Codex, and Claude reviewers, each assigned one separate review file.
- Review outputs belong under `technical-design/reviews/`; the TeamLeader owns
  the draft, final solution, and finding adjudication.
- [Historical review draft](technical-design/draft.md).
- Codex review: [Independent review](technical-design/reviews/codex.md).
  Its Claude compatibility-boundary finding was narrowed by the operator's
  subsequent instruction to keep the longstanding Claude capability simple.
  The final solution will reuse the existing native protocol without a new
  Claude version gate, probe, or compatibility layer. The actual test version
  remains evidence rather than a feature-support boundary.
- Codex F2 accepted and corrected in the draft: remove the proposed Dreamux RC
  queues. Current Claude code already serializes native bridge actions; Codex
  separately orders switching and pairing and rejects a pairing result after
  disable. Native response correlation and existing teardown are sufficient;
  off must not wait behind a Dreamux enable-and-pair queue.
- Claude review: [Independent review](technical-design/reviews/claude.md).
  Accepted deletions: internal Codex startup override, echoed result status,
  optional capability guard and its test. The draft now records the five existing-
  owner forwarding methods and the prior cleanup finding. Source tracing confirms
  the Codex minimum change is diagnostic-only and needs an ordinary change note;
  removing the configuration key remains upgrade-blocking.
- Seed review: [Independent review](technical-design/reviews/seed.md).
- Final adjudication: [Accepted deletions and factual corrections](technical-design/reviews/adjudication.md). The final solution resolves the design findings; no product code or live remote enrollment was performed during review.

## Development approval

- Status: Not granted.
- The operator answered the development-authorization card by asking whether the
  result type aligned between providers, then selected a generic record result.
  Those solution corrections were not approval to begin implementation.
- Approved implementation boundary: None.

## Delivery

- Pull request: https://github.com/excitedjs/dreamux/pull/456
- Scope: Archive the requirement, design, three independent reviews, and
  adjudication. No product code or configuration changes are included.
- Coverage limit: Source and version evidence is the 2026-09-21 snapshot.
  Implementation must recheck the current code and configuration-compatibility
  policy; the archived config-key removal plan is not an approved migration.
- Knowledge closeout: The proposal remains in this task; current product and
  architecture documentation remain unchanged because the feature is unimplemented.
