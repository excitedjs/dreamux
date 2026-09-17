# Technical Solution

Input: [requirement.md](/.agents/tasks/architecture/add-dispatcher-submit-command/requirement.md)
as converged on 2026-09-17.

## Summary

The Dispatcher Agent gets its own two Commands in the Dispatcher namespace, the
Team Commands stop addressing it, and the Feishu Channel follows: every
Dispatcher-addressed submission goes through `dispatcher.submit`, `/stop` in an
unbound conversation goes through `dispatcher.interrupt`, and a Collaboration
Space provisioning run that does not reach its Team answers the triggering
message with a failure notice instead of falling back to the Dispatcher.

What is removed: the optional-addressing branch in `team.submit` and
`team.interrupt`, the `teamId === null` branch in `DispatcherService.interrupt`,
the provisioning fallback in `FeishuChannel.deliver`, and the production-dead
`service/channel-submission.ts` adapter. What is added: two Command
definitions, one shared submission-payload reader both submit Commands use, one
notice send in the Feishu inbound path.

## Core

### `dispatcher.submit` and `dispatcher.interrupt`

Owner: `packages/dreamux/src/service/dispatchers/commands.ts`, beside
`dispatcher.list` / `status` / `start`. The module header changes from
"lifecycle Commands" to "the Dispatcher namespace's Commands": lifecycle plus the
Dispatcher Agent's own turn intake and interrupt. Both are dispatcher-scoped
through `mustDispatcher(host, context)`, so addressing stays caller context and
neither schema declares `dispatcher_id`.

- `dispatcher.submit`
  - input: closed object `{ attrs: OBJECT, text: NON_EMPTY_STRING, reminder:
    STRING, source_id: boundedString(512) }`, required `['text']`. No
    `team_name`, and no `intent`: no caller produces an intent for the
    Dispatcher Agent (interface-convergence question "who produces it?").
  - execute: `dispatcher.submitToAgent({ ...submission, source: CHANNEL_SOURCE })`.
  - output: the existing submit receipt schema and `teamSubmitResult`
    projection, unchanged.
- `dispatcher.interrupt`
  - input: `NO_INPUT`; output `{ status: 'interrupted' | 'idle' }`, the same
    schema `team.interrupt` declares.
  - execute: `dispatcher.interruptAgent()`.

### Team Commands address only Teams

`packages/dreamux/src/service/team-collection/commands.ts`:

- `team.submit`: `team_name` joins `required`; `parse` reads it with
  `teamNameParam`; `execute` always calls `submitToTeamLeader` with
  `deliverCompletionToDispatcher: false`. The `submitToAgent` branch and its
  comment are deleted.
- `team.interrupt`: input `{ team_name }` required, parsed with
  `teamNameParam`; `execute` calls `interruptTeamLeader(teamName)`.
- A missing `team_name` is rejected by schema validation as `BAD_REQUEST`
  before any Agent is reached.

`packages/dreamux-types/src/team.ts`: `TeamSubmitCommand.team_name` becomes
required. A `DispatcherSubmitCommand` type (`attrs`, `text`, `reminder`,
`source_id`) is exported beside it, because the Command's parsed input is that
shape and `@excitedjs/dreamux-types` is where a Channel provider reads Command
input shapes from.

### DispatcherService

`packages/dreamux/src/service/dispatcher-service/index.ts`:
`interrupt(teamId: string | null)` splits into `interruptAgent()` and
`interruptTeamLeader(teamId)`, mirroring `submitToAgent` /
`submitToTeamLeader`. The comment that justified one method by "the same
optional addressing `team.submit` and `team.interrupt` already publish" is
deleted with the addressing.

### One reader for the Channel-facing submission payload

`team.submit` and `dispatcher.submit` read the same four fields with the same
rules (safe attribute names, string values, the 512-character `source_id`
bound, empty `reminder` / `source_id` meaning omitted). Today those rules live
privately in `team-collection/commands.ts` (`submissionAttrs`,
`MAX_SOURCE_ID_LENGTH`).

`packages/dreamux/src/service/channel-submission.ts` already claims this role
("Channel ingress and `team.submit` reach the runtime through exactly the same
seam") but has no production caller: `channelSubmission` takes the retired
ordered-pair attribute shape and is imported only by two test files. It is
rewritten, not added beside: it becomes the one owner of the Channel-facing
submission payload — the schema properties, the parse into
`DispatcherSubmitCommand`, and the projection to `TeammateSubmitInput` with
`CHANNEL_SOURCE`. `team.submit` composes it with `team_name` and `intent`;
`dispatcher.submit` uses it as is. `submission-envelope.test.ts` and
`channel-input-format.test.ts` retarget from the dead ordered-pair adapter to
this reader, keeping their behavioral assertions (provenance is `channel`,
attributes reach the envelope, an empty source id disables deduplication).

`submission-sources.ts` `CHANNEL_SOURCE` comment names both Commands.

## Feishu Channel

### Dispatcher-addressed submissions

`FeishuChannel.submit(teamName: string | null, submission)` keeps its shape and
its four callers. It invokes `team.submit` with `team_name` when a Team is
named and `dispatcher.submit` without one. Call sites 1 (dispatcher plan),
2 (bound Team rejected), and 4 (document-comment cold open) therefore move with
no edits of their own. The `TEAM_NOT_FOUND` / `TEAM_CLOSED` → `rejected`
mapping stays; `dispatcher.submit` cannot raise either code.

### Provisioning failure answers in place

`FeishuChannel.deliver` becomes:

- `dispatcher` plan → `submit(null, …)`;
- `bound` plan → `submit(teamName, …)`; on `rejected`, `forgetTeamRoutes` and
  `submit(null, …)` exactly as today;
- `provision` plan → return `provisionForInbound(…)`'s outcome unchanged. No
  Dispatcher fallback.

After this change a `deliver` outcome of `unsubmitted` or `rejected` can only
come from the provision branch: `unsubmitted` is produced only by provisioning,
the bound branch consumes its own `rejected`, and `dispatcher.submit` cannot be
rejected. `deliver`'s comment states this.

`feishu-session-inbound.ts` `deliverAcceptedMessage`, which already sends slash
command receipts under the accepted message with `sendReply`, sends the notice
the same way when the outcome is `unsubmitted` or `rejected`:

```
Could not start a Team for this conversation: <outcome message>
```

English, matching the other Channel-authored receipts; the reason is the
outcome's own message, the same way `/bind` failures carry Core's message. The
delivery log line is unchanged.

Every exit listed in the requirement reaches this notice: a throwing
`team.create` (including the idempotency conflict), a replayed closed Team, an
empty Team name, a failed route bind, a concurrent waiter that finds no route,
and a `rejected` submission to the just-provisioned Team.

The `unsubmitted` variant's comment in `feishu-submit.ts` and the provisioning
module header drop "delivered to the Dispatcher Agent" and state the notice.

### `/stop`

`feishu-slash-commands.ts`: a `bound` plan invokes `team.interrupt` with
`team_name`; a `dispatcher` plan invokes `dispatcher.interrupt` with `{}`. The
`provision` answer and the receipt text are unchanged.

## Unchanged

- Normal Collaboration Space provisioning, route reconciliation on a bound
  Team's rejection, document-comment subscription delivery.
- The submit receipt type and its error codes (`TeamSubmitResult`,
  `TEAM_SUBMIT_FAILED`, `TEAM_SUBMIT_AMBIGUOUS`): the Team MCP delegate reads
  the same projection, so renaming them is an MCP tool contract change no one
  asked for. `dispatcher.submit` returns the same receipt.
- `team.submit` `intent`.
- No CLI verb, no exposure mechanism; both new Commands are reachable over
  `admin.sock` like every other Command.

## Rejected alternatives

- Keep `team.submit` optional and only add `dispatcher.submit` — two Commands
  for one action; the operator ruled `team_name` required.
- A new shared submission module beside `channel-submission.ts` — dedup by
  indirection while a dead adapter claiming the same role survives.
- A separate Feishu result shape or callback to flag provisioning failure — the
  outcome union already proves it after the Dispatcher fallback is removed.
- Sending the notice from `FeishuProvisioning` — the inbound path already owns
  replying under the accepted message.

## Compatibility and change notes

No config or persisted state changes. Ordinary change notes (no `BREAKING:`):

- `@excitedjs/dreamux` (minor): adds `dispatcher.submit` and
  `dispatcher.interrupt`; `team.submit` and `team.interrupt` now require
  `team_name`. An `admin.sock` script that omitted it gets `BAD_REQUEST` and
  should call the Dispatcher Command instead.
- `@excitedjs/dreamux-types` (minor): `TeamSubmitCommand.team_name` is
  required; adds `DispatcherSubmitCommand`.
- `@excitedjs/feishu-channel` (minor): Dispatcher-addressed deliveries and
  `/stop` use the Dispatcher Commands; a Collaboration Space message whose Team
  could not be provisioned gets a failure notice under it instead of going to
  the Dispatcher Agent.

## Knowledge updates

- `.agents/domains/channel.md`: the `team.submit` addressing text, `/stop`,
  and the provisioning failure paragraphs (every "falls back to the Dispatcher
  Agent" in the provisioning section).
- `.agents/domains/current-architecture.md` line on `team.submit` addressing.
- `.agents/product/README.md`: the collaboration space entry gains the
  failure notice.
- `packages/channel/feishu-channel/CLAUDE.md` and
  `packages/dreamux/src/service/CLAUDE.md` where they name the changed
  seams.

## Verification

- Core: registry names include both Commands; `dispatcher.submit` and
  `dispatcher.interrupt` reach the addressed Dispatcher Agent over a Channel
  port and `admin.sock`; `team.submit` / `team.interrupt` without `team_name`
  answer `BAD_REQUEST` and reach no Agent; the retargeted submission-envelope
  assertions hold.
- Feishu: an unbound conversation, a bound conversation whose Team is rejected,
  and a document-comment cold open invoke `dispatcher.submit`; `/stop` invokes
  `dispatcher.interrupt` unbound and `team.interrupt` bound; each provisioning
  failure exit posts the notice under the triggering message and invokes no
  `dispatcher.submit`.
- Gates: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`,
  `.agents/scripts/check.sh`.
