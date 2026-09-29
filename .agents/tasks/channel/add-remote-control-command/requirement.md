# Requirement

## Initial request

- Let operators enable or disable remote control for Claude Code and Codex through /rc, /rc on, and /rc off in Feishu

## User story

An operator using Feishu wants to enable or disable remote access to an agent
conversation when needed. Remote control is a manual action on the current
process, and Dreamux must no longer offer the shared profile switch in
`config.json`. The same command syntax must work with Claude Code and Codex.

## Confirmed request

- `/rc` and `/rc on` enable remote control.
- `/rc off` disables remote control.
- Support both Claude Code and Codex.
- Remove the global `remote_control` configuration option from Dreamux's
  `config.json` contract and remove its startup auto-enable behavior.
- A manual setting lasts only for the current process. Losing it on restart is
  acceptable; the operator can enable remote control again. Do not add a
  persisted manual preference.
- Begin work on a new branch from the latest `next`.
- On 2026-09-21, the operator approved creating this task and continuing
  requirement and solution work. This was not development approval.

### Operator clarification

The operator clarified the scope on 2026-09-21 (original wording):

> 我是说，把 config.json 里边那个全局开关删干净。进程重启导致的状态丢失，我感觉可以接受，重新开一下就行。

The accepted scope is the Dreamux configuration option and process-local manual
control. It does not authorize removing settings from the upstream providers or
editing unrelated native account configuration.

The operator subsequently narrowed the compatibility discussion (original wording):

> 这是一个很老的功能了，非常老了。不要搞那么复杂。
> cc 在很久很久以前就支持 remote control 了。

Reuse the existing Claude Code remote-control protocol directly. Do not turn its
longstanding support into a new version-gating or compatibility project. The
installed 2.1.277 version is an evidence label, not a new support boundary. This
clarification concerns Claude Code; it does not erase an actual Codex wire-format
difference established in the source.

The operator reinforced the repository's architecture criterion (original wording):

> 你们收着点，不要加无谓的防御。仓库的知识库里不要求你们要熵减嘛

Every proposed mechanism must be paid for by the requested command or a concrete
source-backed failure scenario. Remove speculative defense rather than polishing
it. Review must account for the deleted configuration/startup mechanism and avoid
turning the native action into another state or compatibility subsystem.

The operator selected the result shape explicitly (original wording):

> 也别这样了，搞一个 record 来完事。第三个接进来还不知道最后会返回一个什么东西呢

The neutral action returns a record with provider-owned fields. Do not encode
Claude and Codex's current fields as a shared fixed interface or union. Core
passes the record through, and the channel presents it generically so another
provider need not change the common contract. Use the existing JSON wire value
type for the record's values; return an empty record when no additional
information is supplied.

## Current behavior and evidence

### Dreamux

- The Feishu command table handles deterministic commands before agent delivery.
  `/stop` targets the conversation's direct recipient: its bound TeamLeader or
  Dispatcher Agent. Its implementation is in
  `packages/channel/feishu-channel/src/feishu-slash-commands.ts`.
- The neutral `AgentRuntime` contract currently provides `start`, `submit`,
  `interrupt`, and `stop`; it has no remote-control action
  (`packages/dreamux-types/src/agent-runtime.ts`).
- Each launched Codex agent runtime owns an app-server child and its own Unix
  socket. A TeamMate does not share its live app-server with other TeamMates.
  The process is created in `packages/agent-runtime/codex/src/runtime.ts` and
  launched in `packages/agent-runtime/codex/src/supervisor.ts`.
- Codex children inherit the ambient Codex home unless explicitly overridden
  by existing runtime environment configuration
  (`packages/agent-runtime/codex/src/runtime-support.ts`).
- Claude Code's `remote_control` profile option enables remote control when a
  resident process starts. The provider sends an enable request and logs the
  returned URL; it does not expose a running-session toggle. Owners:
  `packages/agent-runtime/claude-code/src/config.ts`, `runtime.ts`,
  `supervisor.ts`, `control-rpc.ts`, and `stream.ts`.
- The Claude Code configuration reader rejects unknown keys. Removing the
  option from the accepted schema therefore makes configurations that still
  contain it invalid. The option is also documented in `packages/dreamux/README.md`
  and the owning maintenance reference,
  `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-claude-code.md`.

### Native providers

- Claude Code's native stream control request accepts the `remote_control`
  subtype with an `enabled` boolean. Disabling tears down the remote bridge
  while preserving the local session. The installed version inspected was
  2.1.277; native source and the installed control-handler code were inspected.
  [Official remote-control documentation](https://code.claude.com/docs/en/remote-control)
  also describes session-level remote control.
- Codex exposes `remoteControl/enable` and `remoteControl/disable`, both with
  an `ephemeral` parameter. The switch acts on the receiving app-server's
  in-memory desired state. Ephemeral calls do not introduce a saved preference;
  an ephemeral enable preserves an already active durable enabled preference.
  Durable calls also update the enrollment preference, which another process
  can read when resolving its startup state. Neither path broadcasts a state
  change to other live app-server processes.
- In Unix socket mode, Codex does not use the initializing client's name to
  scope the enrollment. Processes sharing the state database, account, and
  relay endpoint can load the same server and environment registration.
  This is distinct from the scope of the in-memory switch.
- These Codex findings were checked against upstream revision
  `a86631502d49274cb47208925c7d3dcece032029` on 2026-09-21. Relevant owners are
  `codex-rs/app-server/src/lib.rs`,
  `codex-rs/app-server-transport/src/transport/remote_control/{mod,desired_state,websocket}.rs`,
  and `codex-rs/state/src/runtime/remote_control.rs`.

### Evidence limits

- No real remote pairing or concurrent remote connections were exercised.
- Shared enrollment does not by itself prove that one live process disconnects
  another. Such interference is an unverified hypothesis, not an established
  defect or an approved reason to redesign runtime isolation.
- The installed Codex version inspected was 0.153.4. The existing minimum,
  0.137.0, has enable/disable RPCs but lacks their `ephemeral` parameters and the
  disabled-start environment mechanism. Both are present at upstream tag
  `rust-v0.140.0`; the solution must state how it handles that version boundary.

## Proposed alignment

These are bounded interpretations for review, not additional operator rulings:

- Resolve the target from the existing conversation route, as `/stop` does;
  do not infer a command to switch every TeamMate in a Team.
- Do not restore a previous process's manual setting. Remove Dreamux's Claude
  startup enable request; preserve Codex's own handling of separately saved
  native preferences rather than injecting an internal startup override.
- Keep native provider actions behind the neutral runtime boundary. Feishu
  owns parsing and presentation, and core owns recipient routing.
- A receipt should distinguish an actual completed operation from an error or
  an intermediate connection state, and expose the provider's usable connection
  information after enabling.

## Product catalog impact

- Extend "A message that starts with a known slash command is executed, not
  delivered" with the requested `/rc` behavior.
- Extend "`/help` lists the commands" through the same command table.
- Preserve existing binding, mention, and inbound authorization behavior.
- Remove the documented shared Claude Code profile switch and its automatic
  startup behavior. Manual settings do not survive process restart.

## Configuration removal boundary

- Remove the field's type, default, accepted-key entry, parsing, startup wiring,
  and documentation. Retain the native protocol action needed by `/rc`.
- Existing configurations containing `agents[].config.remote_control` need that
  key removed before the upgraded configuration reader will accept them. Follow
  the repository's fail-loud configuration policy rather than silently accepting
  an obsolete setting.
- Update the configuration-owning maintenance reference and routing as needed.
  The upgrade-blocking removal requires a Rush change note with the exact manual
  removal action, following the repository's `BREAKING:` and `Rebuild:` rules.

## Acceptance criteria

- Both requested enable forms and the disable form are handled by the channel.
- Both built-in providers can execute the requested action and report its result.
- The shared configuration option and automatic enable path are removed from
  implementation and current documentation; no replacement global switch is added.
- Process restart does not restore the manual remote-control setting. No new
  persistent setting is introduced.
- Disabling remote control leaves the agent's local process and work running.
- The technical solution must specify direct-recipient routing, inactive-runtime
  behavior, native failure reporting, supported versions, and the evidence needed
  to establish multi-instance behavior. These details are subject to final
  solution approval; they are not additional operator rulings.

## Decisions and unknowns

- Confirmed lifecycle: Manual state may be lost on process restart. The shared
  Dreamux configuration option must be removed.
- Technical unknown: How do simultaneous Codex remote connections behave when
  independent app-server processes reuse an enrollment? Verify before choosing
  an isolation change.
- The final solution proposes Codex 0.140.0 for the ephemeral wire shape, through
  the existing diagnostic-only minimum. Claude uses its existing protocol without
  a new version boundary. Native account eligibility and usable connection
  information remain live acceptance evidence.
- No implementation, transport replacement, private Codex home, or multi-instance
  isolation redesign has been approved. The configuration field removal is an
  accepted requirement; implementation remains subject to solution approval.
