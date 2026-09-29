# Seed — independent review of the remote-control command draft

Reviewer: independent Seed seat. Inputs: the requirement (including the
operator's 2026-09-21 rulings "这是一个很老的功能了，非常老了。不要搞那么复杂。"
and "你们收着点，不要加无谓的防御。"), the TeamLeader draft, current `next`
source, and upstream Codex evidence from the fetched `origin/main` revision
**`a86631502d49274cb47208925c7d3dcece032029`** (the reference revision named in
the requirement). Tag comparisons were read directly from
`rust-v0.137.0`, `rust-v0.139.0`, and `rust-v0.140.0`. For the remote-control
files this review cites (`app-server-transport/.../remote_control/*`,
`app-server-protocol/.../{common,v2/remote_control}.rs`,
`state/src/runtime/remote_control.rs`, `cli/src/remote_control_cmd.rs`), a diff
of the sibling working tree's older local HEAD against the fetched
`origin/main` shows zero differences — only unrelated `rollout/compress` and
`cli/src/main.rs` edits differ — so the file-level evidence is identical at
both revisions; the named authority used here is the fetched `origin/main`.
Claude Code native evidence from the older unpacked snapshot is labeled
**snapshot** wherever cited; it predates the installed 2.1.277, which per
operator ruling is an evidence label, not a support boundary.

## Verdict

The architecture is right and minimal: one mandatory neutral action, two core
commands mirroring the existing interrupt pair, channel owns only parsing and
the receipt, no persisted state, no polling, no isolation work, no
compatibility layer. Against the **current** draft I find no design-shape
blocker: the two deletions I originally required (mandatory method, status-echo
removal) are already in it, both host-side queues are gone, and the Codex
disabled-start marker is gone. What remains for operator approval is the
operator's own decision on the Codex 0.140.0 floor, plus two contract details
the TeamLeader has said they will adjudicate (partial-operation receipt shape,
expiry conversion). Items my first pass raised but the draft has since resolved
are explicitly marked **Superseded** below and kept for the record.

## What I verified at the source (current draft claims that hold)

- **Routing precedent exists exactly as drafted.** `/stop` fans out nowhere:
  `feishu-channel/src/feishu-slash-commands.ts:118-138` resolves
  `team.interrupt` / `dispatcher.interrupt` from the plan;
  `DispatcherService.interruptAgent`
  (`dreamux/src/service/dispatcher-service/index.ts:517-520`) and
  `interruptTeamLeader` (`:523-526`) both go through admission, and
  `TeammateRuntimeOwner.interrupt`
  (`teammate-service/runtime-owner.ts:101-104`) deliberately never starts a
  dormant runtime. `team-service/index.ts:554-557` is the leader peer. The two
  proposed `*.remote_control` commands are the same shape with one more
  argument.
- **Current Codex ephemeral semantics are as the draft describes.**
  `enable_ephemeral` only flips the in-memory desired state
  (`app-server-transport/.../remote_control/mod.rs:293-297`); an ephemeral
  enable over a durable-enabled preference is preserved by the
  `send_if_modified` upgrade at `mod.rs:317-323`; `disable_ephemeral`
  (`mod.rs:373-380`) flips desired state and publishes `Disabled`, touching no
  daemon, child process, or turn.
- **Pairing fields and secrecy are as drafted.**
  `RemoteControlPairingStartResponse` always carries an opaque `pairing_code`
  and an optional `manual_pairing_code`, plus `expires_at: i64`
  (`v2/remote_control.rs:75-83`); the native conversion is RFC3339 → **Unix
  seconds** (`remote_control/enroll.rs:146-149`). Pairing refuses when desired
  state is not enabled and re-checks after enrollment
  (`mod.rs:437-438,541-544`), so enable-before-pairing is a native requirement
  the current draft's ordering satisfies; pairing concurrently racing a native
  off is also a native-refused outcome, which is why not queuing off behind
  pairing is correct.
- **Codex process-replacement fencing already exists.** A replaced runtime
  closes the previous `CodexWsClient`
  (`agent-runtime/codex/src/runtime.ts:468-491`), and client teardown rejects
  every pending request (`agent-runtime/codex/src/rpc.ts:236-243`). The
  current draft's "send off through the captured existing client; no replay
  onto a replacement" needs no new fence.
- **The experimental gate is already open.** The Dreamux handshake sends
  `experimentalApi: true` today (`agent-runtime/codex/src/handshake.ts:42`);
  every `remoteControl/*` method is `#[experimental(…)]`
  (`app-server-protocol/.../common.rs`, fetched `origin/main`).
- **Claude disable preserves the local session.** The snapshot's
  `remote_control` handler awaits `bridgeHandle.teardown()` on `enabled:false`
  and replies success without touching the turn
  (snapshot `cli/print.ts:4009-4018`). A headless stream-json process has no
  bridge until an enable request arrives. The existing fire-and-forget request
  and `session_url`/`connect_url` extraction are at
  `agent-runtime/claude-code/src/control-rpc.ts:74-78,118-136` and
  `stream.ts:318-325`.
- **Old-tag behavior (0.137/0.139) is as corrected below**, not as my first
  pass described: no persisted-preference resolution, default off.

## Version boundary (corrected evidence)

Direct tag inspection:

- At **both `rust-v0.137.0` and `rust-v0.139.0`**, the enable/disable methods
  take unit parameters:
  `params: #[ts(type = "undefined")] … Option<()>` (`common.rs:829-839` at
  0.137, `:844-854` at 0.139). Sending the current draft's `{ "ephemeral":
  true }` object against that unit param is a native parameter/deserialization
  error. That is the source-backed expected failure on old builds — not a
  durable write.
- The old transport has no desired-state persistence layer: `enable` flips a
  boolean `enabled_tx` watch channel behind a `state_db_available` gate
  (`mod.rs:90-98` at 0.137; zero matches for `persist_preference` /
  `desired_state` at 0.139). There is no `RemoteControlStartupMode` /
  `ResolvePersisted` mode and no disabled-start marker on either tag
  (zero matches for `REMOTE_CONTROL_DISABLED` in `codex-rs` at 0.139).
- App-server startup defaults `remote_control_enabled: false`
  (`app-server/src/lib.rs:413` at 0.137, `:415` at 0.139). An old build
  Dreamux manages therefore **starts remote control off by default and reads
  no saved preference** — my first-pass claim that an old build could start
  enabled from a native saved preference was wrong for 0.137–0.139; that
  preference machinery only arrives with the 0.140 desired-state/persistence
  redesign.
- At `rust-v0.140.0` the `ephemeral` params exist on enable/disable and the
  startup marker exists; `remoteControl/pairing/start` with `manualCode`
  already exists at 0.137, so the boundary is specifically the switch
  semantics, not pairing.

Consequence, consistent with the current draft (lines 150-159, 204-207): on
0.137–0.139 the daemon runs normally; a `/rc` action fails with the native
parameter error visible through the existing command failure receipt. The floor
stays **diagnostic-only** (doctor/onboard — `codexVersionSatisfies` has no
runtime consumer today, `agent-runtime/codex/src/diagnostic.ts:45-50`; adding a
launch gate would be new machinery with no named scenario), and the bump gets
an **ordinary** change note; the removed config key is the sole `BREAKING:` /
`Rebuild:` item. The live gate at exactly 0.140.0 should capture the actual
native JSON-RPC error string the 0.137/0.139 parameter mismatch produces so
the receipt is actionable, but no code branches on versions.

**Remaining approval item (not a design defect):** the 0.140.0 floor itself is
the operator's decision, which the draft already asks for explicitly. Once
approved with the ordinary note, this item closes.

## Open contract details for the TeamLeader's adjudication

These two are stated here for completeness; the TeamLeader has indicated both
will be settled in the final solution, so I do not block on them.

1. **Codex missing-manual-code receipt.** `manual_pairing_code` is
   `Option<String>` and the native CLI's own human output treats its absence as
   an error context
   ("remote-control pairing response did not include a manual pairing code",
   `cli/src/remote_control_cmd.rs:478-484`). The draft defines enable-accepted
   but pairing-RPC-failed as a partial operation (lines 144-148) and defines
   the analogous Claude missing-URL receipt (lines 104-106), but leaves a
   *successful* pairing response lacking the manual code covered only by
   "when supplied" (line 53). Symmetric wording would close the gap without a
   new branch — the optionality exists in the protocol regardless.
2. **`expiresAt` conversion unit.** The neutral contract says ISO string; the
   wire gives Unix seconds (`enroll.rs:146-149`). Pin the conversion in the
   Codex provider section so it cannot be read as milliseconds.

## Minor finding still open

- **Stale handshake comment.** `agent-runtime/codex/src/handshake.ts:37-42`
  says "We don't currently consume any experimental method"; once
  `remoteControl/*` ships that statement is false. Update it in the same
  change so the experimental gate's documented rationale does not mislead the
  next reader.

## Observations needing no action

- **Native Codex durable preference is deliberately out of scope.** The
  current draft removes the disabled-start marker from the v1 proposal
  (lines 182-186) and keeps native startup behavior: on 0.140+, a separately
  saved native enabled preference can make a Dreamux-managed process start
  with RC enabled. This does not violate the requirement — the acceptance
  criterion is that Dreamux restores no *manual Dreamux* setting, and the
  requirement does not authorize overriding native provider preferences. The
  draft states the consequence plainly; the operator approval summary should
  keep that sentence visible.
- **Multi-instance live check stays a gate, not code.** Enrollment rows key
  by `(websocket_url, account_id, client_name)` with `None` client name in
  Unix mode (`state/src/runtime/remote_control.rs:1-4,30-44`); what the relay
  does with two processes sharing one `environment_id` is unverified. No
  private home, no transport change, no defensive branch.

## Superseded first-pass findings (kept for the record)

- **[Superseded] Optional `setRemoteControl?` plus unsupported-runtime path.**
  Originally required deletion of the optional method. The current draft makes
  the action mandatory, parallels `interrupt`, and explicitly forbids the
  capability registry/guard (lines 65, 81-83). Resolved.
- **[Superseded] Outcome `status: 'enabled' | 'disabled'` echo.** Originally
  asked to delete the field as a pure echo of the argument. The current
  contract (`AgentRuntimeRemoteControlConnection`, lines 67-77) carries only
  optional connection info, with "the caller already knows which action it
  requested". Resolved.
- **[Superseded] Per-runtime serialization/queue framing.** My first pass
  proposed, as the minimum host mechanism, one promise chain per resident
  session. The current draft is tighter and correct: the native Claude print
  loop serializes bridge actions itself (snapshot evidence), so the host needs
  **no execution chain** — only response correlation keyed by the individual
  request ID in a map, replacing the startup helper's singleton
  `remoteControlRequestId` slot (`control-rpc.ts:20,74-78,118-119`) so distinct
  concurrent requests can be settled independently (draft lines 110-112). For
  Codex the native desired-state and pairing locks own ordering; the host must
  only await enable before pairing within one call and must not queue off
  behind an outstanding pairing (draft lines 136-142). Both host queues are
  deleted; my chain proposal is withdrawn in favor of the ID-keyed map.
- **[Superseded] Codex disabled-start environment marker.** I verified the
  marker's path (`take_remote_control_disabled_env`, `DisabledEphemeral`,
  honored on the `codex app-server --listen unix://…` entry Dreamux spawns) for
  the v1 draft that proposed injecting it. The current draft removes the
  injection to avoid overriding native owned preferences (lines 182-186); the
  verification stands as background but no mechanism follows from it.
- **[Superseded] Preemptive timeout branch/test discipline.** The current
  draft keeps the conditional rule ("only add … for an observed native control
  operation that otherwise leaves the command unanswered", lines 188-193) and
  its verification plan invents no timeout branch or fabricated-producer test.
  Resolved.
- **[Superseded] B1 old-build failure shapes (first version).** My original
  B1 claimed old builds could start RC enabled from a saved preference and
  risked unrequested durable writes. Corrected in the section above from tag
  evidence: 0.137–0.139 default off, read no preference, persist nothing, and
  fail the `{ephemeral:true}` object at parameter deserialization.

## Deletion / addition account

**Paid removals** (requirement-stated): the `remote_control` config field and
its parser/default/allowed-key entries
(`agent-runtime/claude-code/src/config.ts:49,81,99,127-130`), the startup spec
boolean and auto-enable wiring (`runtime.ts:354-359`, `types.ts:172`,
`supervisor.ts:122`), the log-only URL callback, current README/maintenance
documentation, and the one `BREAKING:`/`Rebuild:` note for the removed key.

**Paid additions**: one mandatory `AgentRuntime` action with one flat
connection-info result; `dispatcher.remote_control` / `team.remote_control`
and their forwarding peers of the interrupt pair; one command-table row plus
help; Claude request/response correlation via an ID-keyed map replacing
fire-and-forget; Codex ephemeral enable + pairing/start (+ ephemeral disable)
reusing the existing client, native locks, handshake flag, and teardown
rejection; the diagnostic-only 0.140.0 floor.

**Not added (and verified unnecessary)**: capability registry, host RC queues,
generation counter, env-marker injection, persisted/manual mirror, timeout
machinery, version negotiation for Claude, isolation redesign.

## Approval readiness

Ready for the operator decision once the TeamLeader adjudicates the two
contract details (partial-operation wording, expiry conversion) and updates
the stale handshake-comment item in the draft. The only operator-owned
approval input my review identifies is the **Codex minimum floor raising to
0.140.0**, presented as diagnostic-only with an ordinary change note and with
the 0.137–0.139 failure stated as a native parameter error. Live native
enable/disable, post-off local-work continuity, the exactly-0.140.0 protocol
path, and the two-Codex-process relay check remain implementation-stage gates;
their absence is not a design blocker.
