# Claude review of the remote-control draft

This is an independent challenge of the TeamLeader
[draft](/.agents/tasks/channel/add-remote-control-command/technical-design/draft.md),
checked against the
[requirement](/.agents/tasks/channel/add-remote-control-command/requirement.md).
The requirement now records three later operator rulings: "这是一个很老的功能了，非常老了。不要搞那么复杂。",
"cc 在很久很久以前就支持 remote control 了。", and "你们收着点，不要加无谓的防御。仓库的知识库里不要求你们要熵减嘛".
The draft changed on disk while I was reviewing it. This review covers the
current revision, in which both Dreamux RC queues have already been removed. I
did not read the other reviews first.

## Evidence labels

- Dreamux: this worktree, branched from `next` after [#451](https://github.com/excitedjs/dreamux/pull/451).
- Codex: the upstream Codex checkout at `origin/main` = `a86631502d`, and
  the tags `rust-v0.137.0`, `rust-v0.139.0`, and `rust-v0.140.0`. The
  checkout's `HEAD` differs from `origin/main`. Every Codex citation below was
  read from the ref it names.
- Claude Code: the installed 2.1.277 binary, read by byte offset. Under the
  operator's ruling this version is an evidence label, not a support boundary.
  I did not use the older source snapshot.
- Lark SDK: `@larksuiteoapi/node-sdk@1.73.0`, read from the main checkout's
  `common/temp`, because this worktree has no `node_modules`.
- I ran no live enrollment, pairing, or prototype.

## Reconstructed story and owner

An operator types `/rc`, `/rc on`, or `/rc off` in a conversation. They expect
the agent that the conversation addresses directly to expose, or stop
exposing, its live native session. The behavior itself already exists
natively: Claude's `remote_control` control request and Codex's
`remoteControl/*` RPCs. Dreamux supplies three pieces around it:

1. Feishu parses the command and renders the receipt.
2. Core routes to the existing runtime of the direct recipient.
3. The provider sends the native request.

The draft assigns these responsibilities the same way, uses the same
direct-recipient rule, and declines to start a dormant agent. I agree with all
three. The findings below cover only mechanisms the draft adds on top of what
the native protocols already do.

## Confirmed native facts

These facts answer questions the draft left open. None of them calls for new
Dreamux code.

1. **A headless Claude process starts with remote control off, and resuming
   it does not reconnect.**
   - In 2.1.277, `initReplBridge` has two call sites. The first is the headless
     `remote_control` control-request handler at offset `213852439`.
   - The second is at offset `219023007`. I infer that it is the interactive
     REPL hook from its `[bridge:repl] Hook:` log prefix and its hook-ref
     shape. I did not confirm that this code is unreachable in `--print` mode.
   - The `remoteControlAtStartup` setting reaches headless mode only as the
     `remote_control_auto_enable` field of the `initialize` response (offset
     `213881393`). The host decides what to do with it, and Dreamux never sends
     `initialize` (no match under `packages/agent-runtime/claude-code/src`).
   - The documented reconnect on `--resume` runs inside bridge
     initialization.
   - Conclusion: deleting the startup request (`supervisor.ts:122`) is enough.
     Claude needs no startup mechanism, version probe, or settings edit. The
     draft's existing live gate, "fresh process starts off", settles the
     inferred part. No Dreamux disable-on-start should be added as insurance.
2. **Claude's enable response carries both URL fields.** `fr()` at offset
   `213741352` returns
   `{session_url, connect_url, environment_id, bridge_epoch, bridge_session_id}`.
   This resolves the deferred row 3 in
   `.agents/research/claude-code-stream-json-protocol.md:138`, and knowledge
   closeout should record the answer there.
3. **Claude already orders and deduplicates the action.**
   - The handler runs inside `gn=QT((h)=>h())`, and `QT` is a serial promise
     queue (offset `192747609`).
   - A repeated enable returns the live bridge's information
     (`if(gt)tt(k,fr(gt,Ee))`).
   - A disable with nothing running answers success (`tt(k)`).
   - A disable releases the reconnection record unless the host owns the
     session (`keepRecord:he.neverArchive===!0`).
4. **Codex already orders the action.**
   - `remoteControl/enable` and `remoteControl/disable` share the serialization
     key `global("remote-control")` (`app-server-protocol/src/protocol/common.rs`).
   - `start_pairing` checks `desired_state_tx.is_enabled()` on entry and again
     after its network awaits (`transport/remote_control/mod.rs:439`, `:551`).
5. **A slow `/rc` does not hold up other inbound messages.** The Lark WSClient
   handles each frame in its own async `message` listener, and nothing awaits
   that listener (`node-sdk/lib/index.js:102466-102477`, `handleEventData`). So
   two `/rc` commands can be in flight at once, and a stalled native reply
   delays only its own event. I agree with the draft: add no control timeout.

Facts 3 and 4 confirm the current draft's removal of both Dreamux RC queues.
Fact 5 is the source-backed reason why Claude must correlate RC requests by
request id: the existing single `remoteControlRequestId` slot
(`control-rpc.ts:20`, `:76`, `:118`) would strand a first request that a
concurrent second one overwrote. The draft already says to correlate by id.
Pending RC requests should settle through the existing `close()` path, which
already settles a pending interrupt (`rpc.ts:158-183`). This needs no new
lifecycle mechanism.

## Findings

### F1 — High: delete the Codex disabled-start environment variable

Step 1 of the draft's Codex provider section injects
`CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED=1`.

- **It is not a client contract.** Upstream documents it as an "Internal
  marker used by the daemon to disable remote control without requiring a new
  CLI flag" (`transport/remote_control/mod.rs:86`). If upstream renames it,
  Dreamux silently stops disabling anything.
- **No known writer produces the row it guards against.** It prevents a durable
  enabled preference from being read at startup. On Codex `≥0.140`, only a
  non-ephemeral `remoteControl/enable` writes that preference
  (`message_processor.rs:1164`: `params.is_some_and(|p| p.ephemeral)`). In open
  source, the only caller is the upstream daemon, and it sends
  `ephemeral: true` (`app-server-daemon/src/remote_control_client.rs:109`).
  Dreamux will send `ephemeral: true` as well. The only plausible durable
  writers are closed-source desktop or IDE clients, and a preference written by
  one of them is the operator's own native Codex configuration.
- **The requirement does not ask for this override.** The "Start each managed
  runtime with remote control off" bullet appears under "Proposed alignment",
  which the requirement labels "not additional operator rulings". The
  acceptance criterion is narrower: restart "does not restore the manual
  remote-control setting". That criterion holds without the variable, because
  `/rc` never writes a preference and Dreamux replays nothing. The requirement
  also does not authorize overriding unrelated native configuration.
- **It would change today's behavior.** Dreamux Codex children currently start
  in `ResolvePersisted` mode, so the variable would add a behavior rather than
  preserve one.

User-visible consequence of deleting it: the draft's "A new process starts with
remote control off" becomes "…unless the operator's own Codex client has stored
a durable enabled preference for the shared enrollment". The TeamLeader should
present that sentence to the operator as the consequence. Delete step 1, and
delete the Codex "startup off" protocol test that exists only to cover it.

### F2 — Medium: the neutral contract carries an echo, an optional-capability branch, and a partial result it cannot express

- **`status` is an echo.** `AgentRuntimeRemoteControlOutcome.status` always
  equals the `enabled` argument, because every failure rejects. The four-question
  test fails: the value is derivable from the caller's own input. Delete it.
- **The optional method should be mandatory.** `setRemoteControl?` is optional,
  and core adds an "unsupported runtime" branch plus a "missing capability"
  test for it. The contract file keeps optional members only where absence
  "changes only presentation" (`agent-runtime.ts:14-17`). The precedent is
  `interrupt`: it is mandatory in the type, core calls it directly, and
  external providers are validated only for `start`, `submit`, and `stop`
  (`external-provider.ts:158`). `dreamux-types` is at `0.10.0`, and both
  built-in providers implement the method. Make it mandatory, and delete the
  core branch and its test.
- **The partial result has no representation.** "Enable accepted, pairing
  failed" cannot be expressed as a resolved `Promise<Outcome>`. The simplest
  fix needs no new field: the Codex provider rejects with a message that states
  both facts, and the existing `Command /rc failed: …` receipt displays it. The
  current draft already requires not claiming RC is still enabled, and this
  shape satisfies that.

### F3 — Medium: the new core route extends a pass-through family the operator already criticized

The draft's complexity account says it adds "the two core routes". Following
the `/stop` chain, the new commands actually add methods at these layers:

- `DispatcherService`, following the pattern at `index.ts:518-526`: two
  methods, one for the Dispatcher Agent route and one for the Team route
- `TeamService` (`index.ts:555`)
- `TeammateService` (`index.ts:307`)
- `TeammateRuntimeOwner` (`runtime-owner.ts:101`)

The operator reviewed exactly this family. Of
`DispatcherService.interruptTeamLeader` they said: "这个玩意太蠢了。为什么一定要在
dispatcherServices 里透传到 teamleader 的 teammate？". That remark was recorded
as a cleanup finding with no follow-up
(`.agents/tasks/architecture/add-dispatcher-submit-command/requirement.md:144-160`).
`team-service/index.ts` is at 690 lines, against a 700-line gate.

This finding does not ask the task to collapse the whole family; doing so would
contradict "不要搞那么复杂". The final solution must still:

1. list every added pass-through method in its complexity account,
2. cite the recorded cleanup finding,
3. state whether it extends the family, and why, and
4. say that if the line gate trips, trimming lines is not an acceptable fix.

### F4 — Medium: raising the Codex minimum does not block an upgrade; classify its change note that way

- **The Codex version gate never runs in `serve`.**
  `codexVersionSatisfies` is used only in `diagnostic.ts:47`, which runs
  through `runDispatcherProviderDiagnostics`. The callers found are `doctor`
  and `onboard` (`onboard/run.ts:293`). Raising `MIN_CODEX_VERSION` therefore
  cannot stop an upgraded daemon from starting. The draft's "any
  upgrade-blocking runtime minimum change" therefore takes an ordinary change
  note, not `BREAKING:` or `Rebuild:`.
- **The configuration-key removal is different and stays `BREAKING:`.**
  `rejectUnknownKeys` (`claude-code/src/config.ts:93`) makes `serve` fail on a
  config that still contains the key.
- **After F1, only the `ephemeral` field requires `0.140`.** In
  `0.137`–`0.139`, the params type is `Option<()>`, and those versions persist
  no preference (`rust-v0.139.0` `app-server/src/lib.rs:407-415`; startup
  defaults to disabled). A single-constant bump is the lowest-entropy choice.
- **A fallback is possible but should be rejected.** The upstream daemon's
  `request_remote_control_with_legacy_fallback` shows how one could work, but
  it is exactly the compatibility branch the operator ruled out.
- **Claude gets no gate or probe, per the ruling.** The draft's "Validate
  against the installed native binary" should read as live evidence gathered
  during implementation validation, not as a compatibility boundary.

## Deletion and addition account

Remove:

- `DispatcherClaudeCodeConfig.remote_control`, together with its default,
  accepted-key entry, and parsing (`config.ts:49`, `:81`, `:99`, `:127`)
- `ClaudeCodeSessionSpec.remoteControl` and `onRemoteControlUrl`
  (`types.ts:172-174`)
- the startup branch (`supervisor.ts:122`)
- the log-only URL callback (`runtime.ts:354-360`) and
  `ClaudeCodeStreamRpcOptions.onRemoteControlUrl`
- the fire-and-forget `enableRemoteControl` on both RPC classes, and its
  single-slot request id
- the README and maintenance-reference documentation of the key

Add, each tied to the requested command:

- one mandatory `AgentRuntime.setRemoteControl(enabled)` that returns
  `{url?, pairingCode?, expiresAt?}`
- `dispatcher.remote_control` and `team.remote_control`, plus the pass-through
  methods listed under F3
- for Claude: the boolean `remote_control` request builder, which generalizes
  the existing one, and id-keyed settlement of pending RC requests on the
  existing `close()` path
- for Codex: `remoteControl/enable {ephemeral:true}`,
  `remoteControl/pairing/start {manualCode:true}`, and
  `remoteControl/disable {ephemeral:true}` on the existing client, plus the
  `MIN_CODEX_VERSION` constant
- the Feishu `rc` row and its receipt text

Strike from the current draft:

- the Codex startup environment variable and its "startup off" protocol test
- the `status` echo
- the optional method, its unsupported-runtime branch, and its "missing
  capability" test

The draft revision I reviewed had already struck both RC queues. After these
changes, nothing persists a desired state and no layer mirrors a native state.

## Unverified assumptions

These are not findings. They are for later, approved implementation
validation.

- **Pairing-code exposure.** Can another account claim a Codex manual pairing
  code posted in a multi-member group? The claim happens on the backend, which
  local source does not include. Claude's URL is scoped to the operator's
  account, according to the official documentation.
- **What a paired Codex remote client can reach.** The app-server serves
  `thread/list`, which lists stored threads, separately from
  `thread/loaded/list`. All Dreamux Codex children share one `CODEX_HOME`, so
  they also share `installation_id` and the Unix-socket enrollment key. "Remote
  access to this agent" is therefore likely broader than one conversation. I did
  not trace the remote UI.
- **Relay behavior when several app-servers share one enrollment.** The draft
  already treats this as native evidence to gather, not as a trigger for
  redesign. I agree.
- **The Codex `ResolvePersisted` reconcile loop for Unix-socket transports.** I
  traced it only partially. F1 does not depend on it.

## Readiness

The native path contains nothing that blocks the design. The draft is ready for
operator approval once the TeamLeader:

1. applies the F1 and F2 deletions,
2. adds the F3 statement on the pass-through family, and
3. adopts the F4 change-note classification.

With those changes, no new investigation is required. Live native connection
evidence belongs to implementation validation after approval.
