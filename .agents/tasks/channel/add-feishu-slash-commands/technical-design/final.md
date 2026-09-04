# Technical Solution

Authoritative implementation boundary for this task. The operator waived
solution consultation and the public review Issue — "基本上我都知道。直接开干吧"
("I already know most of it. Just go build it.") — so this file is the
TeamLeader-authored solution and the only design record.

## Shape of the change

Four layers, in dependency order:

1. `@excitedjs/dreamux-types` — `AgentRuntime` gains `interrupt()`.
2. `@excitedjs/agent-runtime-claude-code` and `@excitedjs/agent-runtime-codex` —
   each implements it on its own native protocol.
3. `@excitedjs/dreamux` — one new Core Command, `leader_agent_runtime` on the
   `team.list` row, and a dissolve receipt that awaits the worktree check.
4. `@excitedjs/feishu-transport` and `@excitedjs/feishu-channel` — a chat-name
   lookup, the command table, and the `/teams` card renderer.

## 1. Interrupt the running turn

### Runtime seam

```ts
export interface AgentRuntimeInterruptOutcome {
  readonly status: 'interrupted' | 'idle';
}
```

`AgentRuntime` gains `interrupt(): Promise<AgentRuntimeInterruptOutcome>`.

- `interrupted` — a turn was running and the native interrupt was accepted.
- `idle` — the provider had no turn running. The provider already knows this
  (Claude Code's in-flight command group, Codex's turn manager); Core must not
  re-derive it.

`interrupt()` never starts a runtime and never tears one down. A runtime that
was never started answers `idle`.

Both shipped providers support interruption on the versions this repository
requires, so there is no unsupported-provider path to design. Do not add a
support probe, a capability flag, or a silent degrade.

### Claude Code provider

Verified against the installed 2.1.260 bundle: the control protocol accepts
`{"type":"control_request","request_id":…,"request":{"subtype":"interrupt","reason"?:string,"cancel_queued"?:boolean}}`.
The outbound control-request path already exists — `buildRemoteControlEnable`
writes one and `onControlResponse` reads the answer — so this is the same shape,
not a new mechanism.

- Send `subtype: "interrupt"` with a short `reason`.
- Do **not** send `cancel_queued`. It also cancels queued main-thread commands;
  the requirement is to end the running turn only.
- `rpc.ts` already recognizes the interrupt artifact
  (`error_during_execution` with no result) and ignores it as a completion
  boundary. Keep that behavior; the turn ends through the existing
  `turn.ended` / `interrupted` path.

### Codex provider

Verified protocol shape, read from the codex app-server protocol definition at
the `rust-v0.137.0` tag — the repository's existing minimum — and unchanged in
current codex:

- Request `turn/interrupt`, params `{ threadId: string, turnId: string }`
  (camelCase on the wire).
- Response is an empty object.

`MIN_CODEX_VERSION` stays `'0.137.0'`. No version bump, no CLAUDE.md change, and
no breaking change file for the codex minimum. The operator called this
correctly: the method is already there at the declared minimum.

The request needs the running turn's id, not just the thread's. The provider's
turn manager already tracks turn ids; take the id from there rather than
introducing new bookkeeping. No running turn means `idle`, and no request is
sent.

Add `turn/interrupt` to the protocol surface listed in the `version.ts` doc
comment, since that comment enumerates what the gate is protecting.

### Core Command

Add `team.interrupt` beside `team.submit` in
`service/team-collection/commands.ts`, with the *same* addressing rule
`team.submit` already publishes: `team_name` optional, omitted means the
Dispatcher Agent. This adds no addressing concept.

- Input: `{ team_name?: string }`.
- Output: `{ status: 'interrupted' | 'idle' }`.
- It reaches the TeamLeader's `TeammateService` (or the dispatcher's contained
  agent when the name is omitted) and calls `interrupt()` on the runtime it
  owns. It must not materialize or start a dormant runtime to answer.

Interrupting a TeamLeader ends its process's own work, which includes the
in-process sub-agents that runtime started. Dreamux TeamMates are separate
processes and are untouched. That is exactly the required scope; do not add
anything to protect in-process sub-agents.

## 2. The dissolve receipt awaits the worktree check

`TeamService.dissolve` currently returns `{ accepted: true, status: 'submitted' }`
synchronously and runs the whole dissolve behind that receipt, including the
worktree assessment that can refuse it; a refusal is only logged. `/dissolve`
therefore cannot report the one outcome the requirement needs.

Change: when `force` is not set, run the worktree assessment **first**, before
the receipt returns, for either requester. A blocked assessment rejects the
Command instead of producing a receipt.

Why this is safe and small:

- `WorktreeManager.assessCleanup` is documented as mutating nothing — no Git, no
  filesystem, no Dreamux state — and as the capability dissolve uses "before
  admission". It is already a pre-admission read.
- A worktree that is not `managed`, or not `delete-on-close`, returns `terminal`
  immediately without touching Git, so this costs a non-managed Team nothing.
- It is an early-out, not the authority. `stopForDissolve` still assesses again
  after every runtime has stopped and still blocks there, so nothing that could
  dirty the checkout between the two points is missed.

Keep both existing checks exactly as they are:

- the TeamLeader path's assessment after `stopChildRuntimesForDissolve`, which
  exists so a self-dissolve learns the answer while its leader is still alive;
- the final post-stop assessment, which is the authority.

`dissolve` becomes `async` and returns `Promise<TeamDissolveReceipt>`. Its
callers already await. Two tests in
`packages/dreamux/tests/team-dissolve-contract.test.ts` read the receipt
synchronously and must await it; both pass `force: true`, so the new front check
does not run in them and their assertions are unchanged. Do not weaken those
assertions. One of them is named "a dispatcher-triggered dissolve also returns
before the worktree is ever assessed" — after this change that name only holds
for a forced dissolve, so rename it to say what it actually locks, and add a test
that locks the new behavior: a non-forced dissolve of a Team with a blocked
worktree rejects instead of returning a receipt, and the Team stays open.

Update the `dissolve` doc comment: the receipt is still the submission rather
than the outcome, but it is now given only after the one bounded read that can
refuse the whole operation.

## 3. `team.list` carries the leader runtime

`TeamRecord.leader_agent_runtime` already exists and is already projected into
`TeamView` and `TeamHistoryRow`. Add it to `TeamListRow` and copy it in
`read-model.ts` `listRow`. Additive; no persisted format changes.

## 4. Feishu transport chat-name lookup

Add `resolveChatName(chatId)` to the transport contract and implementation,
shaped exactly like the existing `resolveUserName`: optional on the contract,
implemented over the same SDK client, same caching and failure posture. Expose
it through `bot.ts` the way `resolveUserName` is exposed.

## 5. Feishu command table

### Recognition

One module owning recognition and the table, sibling to `introduce.ts`.
Recognition rules, all already decided:

- Text messages only.
- Strip leading Feishu mention placeholder tokens, longest key first. Reuse the
  logic `detectIntroduce` already has rather than writing a second copy —
  extract it if that is cleaner, but do not duplicate it.
- After stripping, the message must start with the command token, followed by
  whitespace or end of message. Case-insensitive.
- Everything after the token is ignored. No command takes an argument.
- In a group or topic the command is recognized only when this bot is
  @-mentioned, regardless of that chat's `require_mention`. A direct message has
  no mention to require.

### Dispatch point

Recognize in `onMessage` (`feishu-session-inbound.ts`), where the classification
and the computed `botMentioned` are already in hand, after the access gate has
answered `deliver`. Carry the recognized command into the delivery step and
dispatch it after `targetRouter.projectInbound` resolves the route and
`routing.plan` reads the binding, and **before** any submission is built.

Three constraints that are easy to get wrong:

- A command must not go through `FeishuChannelSession.submit`. That method calls
  `cot.beginInboundSubmission`, which would anchor a phantom inbound row on the
  COT card. Commands reach Core through `invoke` directly.
- A command must not reach `provisionForInbound`. A `/teams` typed in a fresh
  collaboration-space topic must not create a Team. A `provision` plan means
  "no bound Team" for `/stop` and `/dissolve`.
- An unmentioned command in a group is not a command. It falls through to
  ordinary delivery unchanged.

### The three commands

| Command | Object | Action |
| --- | --- | --- |
| `/stop` | the agent this conversation talks to | `team.interrupt` with the bound Team name, or without one when the plan is `dispatcher` or `provision` |
| `/teams` | none | `team.list`, filtered to `status === 'running'`, rendered as a card |
| `/dissolve` | the bound Team | `team.dissolve` with a generated note, never `force` |

Replies:

- `/stop` — one line for `interrupted`, one line for `idle`.
- `/dissolve` — one line for each of dissolved, no bound Team, and refused. A
  refusal reports the reason Core gave, which is now a rejected Command rather
  than a silent background failure.
- `/teams` — the card. Everything else is text.

### `/teams` card

Rendered in TypeScript in the channel. Structure follows the operator's existing
Running Team locator card: repository `collapsible_panel` groups, one compact
bordered item per Team carrying the agent-runtime tag, the Team name, a short
intent, and that Team's bindings.

- Group by repository basename; Teams without one go to a single "no repository"
  group.
- Panels are always collapsed.
- Colors: a fixed palette indexed by a stable hash of the name. One palette for
  repositories, one for agent runtimes. No name-to-color table anywhere.
- Bindings come from this channel's own routing rows. Group and topic entries
  only; there is no cross-channel view.
- A group entry renders the chat's current name from `resolveChatName`, linked
  to the chat. `display` is not a chat name and auto-provisioned bindings never
  have one — do not fall back to it.
- Intent text is truncated deterministically.

## Tests

- Recognition: mention-prefixed, mid-message, trailing text, case, non-text
  message, group without mention, direct message.
- Dispatch: a command in a collaboration-space topic provisions nothing; a
  command never opens a COT inbound anchor.
- `/stop`: bound group interrupts the named Team; unbound conversation omits the
  name; `idle` answer renders its own line.
- Provider: the Claude Code interrupt writes the expected control request and
  does not set `cancel_queued`.
- `/teams`: running-only filter; stable color for a repeated name; a binding
  created by automatic provisioning still renders a chat name.
- `/dissolve`: dissolved, no bound Team, and refused all render distinctly.
- Dissolve receipt: a non-forced dissolve of a Team with a blocked worktree
  rejects and leaves the Team open; a forced one still returns its receipt ahead
  of any assessment.

## Repository obligations

- Rush change files for every package whose behavior changes. Everything here is
  additive and non-breaking, so type `minor` on the 0.x packages; no `BREAKING:`
  note and no `Rebuild:` anywhere in this task.
- Knowledge delta: `AgentRuntime` gaining a method is a provider contract change
  and the Feishu command surface is new user-visible behavior. Update the owning
  `.agents/domains/` pages and run `.agents/scripts/check.sh`.
- `rush build`, `rush lint`, `rush test`, and `rush typecheck:tests` must all
  pass.
