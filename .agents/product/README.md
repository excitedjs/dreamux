# Product Behavior Catalog

This catalog names Dreamux's user-visible behavior: what an operator or an
agent actually experiences, stated independently of implementation. It exists
so that a change to product behavior is always made **knowingly** — surfaced as
an explicit requirement decision for the operator — instead of disappearing as
a refactor side effect.

It is not a freeze list. Any entry can change when the operator decides it
should; refactors routinely rewrite everything beneath these behaviors. The
rule this catalog serves is the existing one: a refactor that changes
observable behavior is a requirement change. During any contraction or
refactor, diff the change against this catalog and list every touched entry in
the task record; that list is the seed of the feature-loss ledger.

Entries carry the story ("who does what and sees what") plus a pointer to the
deciding record. When you find user-visible behavior missing here, add it in
the same change that touches it.

## Channels and routing

- **The Channel is the operator's doorway.** There is no Web UI or TUI; all
  user interaction reaches Dreamux through a Channel. The Channel's product
  responsibility grows over time; "minimize the Channel" can only ever mean its
  core-facing interface, never its user-facing capability.
- **A binding is an expected route, not an assertion.** Binding a conversation
  target to a Team stores `(channel instance, opaque provider meta) → team`.
  The target may not exist yet and is never verified against the external
  platform; a wrong meta simply never matches. Bindings are Channel-owned.
  (Decision: [minimize-provider-boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md).)
- **Unbound input reaches the Dispatcher Agent.** A conversation with no
  binding is not an error and not dead air — the Dispatcher Agent is its
  recipient. (Domain: [channel](/.agents/domains/channel.md).)
- **Unbinding leaves the Team alive; teams without bindings are normal.** An
  unbind deletes only the route. A Team with no binding is an everyday state
  needing no orphan governance; a later message on that conversation simply
  creates or selects another Team. Dissolving a Team cancels all bindings that
  point at it.
- **A collaboration space is a Channel product flow.** The Channel provisions a
  Team via ordinary `team.create` for a chat or topic it manages; provisioning
  progress is volatile, and a crash may leave an accepted orphan Team rather
  than a persisted saga.
- **Binding changes are confirmed with a card, and the card names real paths.**
  When a chat, topic, or space binding changes, the built-in Feishu channel
  posts a confirmation card: space-bound shows the space name, TeamLeader
  runtime, and repo policy; route-bound shows the binding kind, Team name,
  TeamLeader name, runtime, and runtime cwd; unbinding is a one-liner. The
  absolute repo cwd and runtime working directory are **deliberately**
  disclosed to the bound conversation's members — an explicit operator ruling
  that narrowed the earlier disclosure allowlist. Delivery is best-effort with
  one retry; a failed card never affects the binding change it reports.

## Team lifecycle

- **The Team record is the only existence fact.** A readable, valid Team record
  means the Team exists and its name is taken; no record (or an invalid one)
  means no Team and a free name. Nothing else — ledgers, claims, identities —
  competes with it.
- **Dissolve means terminate now and reclaim.** The user pressing dissolve
  wants processes dead and tokens no longer burning: all member runtimes stop
  immediately, the receipt says `accepted`/`closed` after the durable logical
  close, and slow physical cleanup (large worktrees) continues in the
  background. `force` is the explicit authorization to discard local changes.
  A TeamLeader dissolving its own Team usually never receives the tool
  response; that connection loss is the expected surface, and delivery failure
  never rolls the dissolve back. Automatic cleanup removes only the worktree
  itself: it **never deletes the managed branch, its commits, a reused
  directory, or the source repository** — a user's committed work survives
  every dissolve.
- **A failed dissolve leaves a Team that still exists.** Whatever committed
  before the failure stays committed (closed members stay closed, deleted cron
  stores stay deleted); the next ordinary use rebuilds from disk, and the next
  dissolve retries the same close operations. No rollback product exists.
- **`identity` shapes only the agent it is given to.** The `identity` passed
  to `team.create` guides the created TeamLeader alone; members do not inherit
  it — each member's identity comes from its own `teammate.spawn`.
- **Closed entities are records.** A closed Team or TeamMate is never
  materialized into a live object by startup, queries, or cleanup; the one door
  back is an explicit `send` that reopens a member.

## Observing agents

- **`last` is the mid-turn progress window.** Its story: a TeamMate has been
  running for forty minutes without returning; the operator asks the
  TeamLeader, who pulls the member's recent activity — while the turn is still
  open. It returns assistant messages and tool names/statuses, not tool
  arguments or outputs.
- **Live conversation display is a best-effort stream.** Runtime activity flows
  through neutral projection to the Channel as it happens; delivery is
  best-effort with no replay, no retransmission, and no delivery guarantee —
  display loss is acceptable, turn failure is not. The current Feishu COT card
  presentation is a deliberately tuned surface; changes to it are their own
  requirement, never a refactor side effect.
  (Decision: [feishu-cot-conversation-display](/.agents/tasks/channel/feishu-cot-conversation-cards/accepted-decision.md).)
- **A displayed input is announced when it is submitted, and always ends.** The
  input appears with the text that was submitted, before any runtime has
  accepted it, so a submission that fails is visible together with what failed.
  Anything no runtime accepted — a stopped, skipped, ambiguous, or failed
  admission, including a completion push-back to an agent whose runtime is
  already gone — ends its own display as a failure, carrying the reason, instead
  of leaving a surface open forever. On a Feishu COT card that is the platform's
  own 任务失败 terminal. A dropped push-back used to be silent.
  (Requirement: operator rulings 4, 8 and 9 in
  [split-streaming-display-from-pushback](/.agents/tasks/architecture/split-streaming-display-from-pushback/README.md).)

## Failures the model sees

- **Every tool failure is model-visible and actionable.** A domain-authored
  failure renders its stable code, reason, and next step; any other thrown
  error keeps its own code (or `INTERNAL`) and carries its native message
  verbatim — the errno, path, or provider text is the only concrete fact at the
  scene. There is no sanitized black-hole error and no "see server logs"
  response. Stacks go to logs; messages go up.
  (Owner: [model-facing-writing](/.agents/domains/model-facing-writing.md).)
- **Business rejections are results, not exceptions.** "This chat cannot be
  bound" reaches the model as an explicit error result it can act on, not as an
  internal fault.

## Scheduled work

- **Cron fires submit immediately.** At the tick, the prompt is submitted to
  the agent; the provider may fold it into an ongoing turn. There is no
  held-fire waiting, no idle gating, and the only job action is prompting the
  owning agent. (Domain: [scheduled-work](/.agents/domains/scheduled-work.md).)

## Long operations

- **Tools return receipts, work runs behind them.** Any MCP operation that can
  outlast a runtime's tool timeout (dissolve, spawns, workflow runs) returns an
  immediate acceptance receipt; completion arrives as a push, and one settled
  turn produces exactly one push.

## Local state and upgrades

- **Local runtime state is disposable; upgrades fail loudly.** Team, Agent, and
  Dispatcher operational state is rebuildable operational data, not a protected
  asset. On the 0.x line an incompatible shape is handled by fail-loud plus
  manual rebuild — no migrations, no lazy backfill, no old-shape fallback
  readers. (Domain: [state-config-and-files](/.agents/domains/state-config-and-files.md).)
