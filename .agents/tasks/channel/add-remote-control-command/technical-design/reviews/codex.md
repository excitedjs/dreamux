# Independent Codex solution review

Reviewed on 2026-09-21. This review covers the TeamLeader's `draft.md`, not an
implementation. No other reviewers' files were read. No product implementation,
diagnostic files, native configuration, or enrollment was written or run.

## Independent reconstruction

The operator wants a deterministic Feishu command to enable or disable remote
access to the conversation's directly addressed agent, without restarting its
local work or saving a Dreamux preference. The recorded global configuration
removal is mandatory. Direct-recipient routing, inactive-process behavior and
receipts remain proposed details for approval, not additional operator rulings.

The smallest coherent mechanism is one action on the runtime already owned by
that agent. Feishu owns command syntax and presentation; the existing core
services own recipient selection and admission; the provider owns native
request correlation, process lifetime and connection information. No remote
control manager, stored desired state, model prompt, or second native process
is necessary.

This ownership follows source and history, rather than the draft alone:

- `packages/channel/feishu-channel/src/feishu-slash-commands.ts:118-136` routes
  `/stop` to either `team.interrupt` or `dispatcher.interrupt`.
- `packages/dreamux/src/service/dispatcher-service/index.ts:517-525` and
  `packages/dreamux/src/service/team-service/index.ts:554-557` preserve the
  service admission boundaries. `TeammateRuntimeOwner` retains the runtime
  handle and can join an existing start without initiating one
  (`packages/dreamux/src/service/teammate-service/runtime-owner.ts:88-104`).
- PR #379 introduced the neutral interrupt capability. PR #444 deliberately
  separated Dispatcher commands from Team
  commands so an omitted Team name cannot silently target the Dispatcher.
  The proposed two command routes preserve that distinction.

## Findings

One blocking architecture finding remains: the proposed Dreamux RC queues
duplicate native ordering and unnecessarily couple disable to pairing.

**F1 is withdrawn.** The operator's clarification recorded in
`requirement.md:38-47` requires direct reuse of Dreamux's existing Claude
remote-control protocol. The prior request for a new Claude support boundary
was unnecessary: no concrete protocol incompatibility was established.
Dreamux already sends this request and reads its URL response
(`packages/agent-runtime/claude-code/src/control-rpc.ts:74-78,104-135`). Extend
that existing action to accept the boolean and await its native response.
Preserve native errors, including unsupported-operation errors; add no Claude
version gate, version probe, compatibility layer or support-range test matrix.
Version 2.1.277 identifies the inspected binary only.

This correction is scoped to Claude. The established Codex difference in
ephemeral parameters and disabled-start support remains relevant to its
proposed protocol path and minimum-version decision.

### F2 — P2: Remove the additional Dreamux RC serialization queues

**Affected draft:** `draft.md:109-112` and `draft.md:141-145`.

When `/rc on` is waiting for Codex's pairing HTTP response, the proposed
whole-operation queue makes a subsequent `/rc off` wait for that request too.
The native protocol already permits disable while pairing is outstanding and
rejects a pairing result when remote control has been disabled. Making the
two-request enable-and-pair operation indivisible adds an ordering contract
the requirement does not ask for. Claude's proposed queue also duplicates an
ordering mechanism already present in the native process.

Evidence:

- In the inspected Claude 2.1.277 binary, the RC handler enters
  `gn(async () => ...)` at byte offset 213851701. `gn` is constructed with
  `QT((h) => h())` at 213741933; the imported native `QT` implementation at
  192747609 chains operations through a promise tail. Its rejection handler
  releases that tail for the next operation. The older snapshot instead awaits
  bridge initialization and teardown inside its sequential input loop
  (`cli/print.ts:2816,3892-4019`). Both are native ownership evidence; the
  installed binary is the current observation, not a minimum-version claim.
- At Codex `origin/main`, enable and disable use
  `serialization: global("remote-control")`, while pairing uses the separate
  `global("remote-control-pairing")` scope
  (`codex-rs/app-server-protocol/src/protocol/common.rs:1136-1158`). The request
  processor enqueues those scopes itself
  (`codex-rs/app-server/src/message_processor.rs:1042-1050`). This distinction
  also exists at `rust-v0.140.0`, `common.rs:876-898`.
- Native pairing checks enabled state both before work and before returning
  (`remote_control/mod.rs:433-440,545-554`; at `rust-v0.140.0`, lines 386-394
  and 492-501). Pairing does not turn desired state back on. A concurrent off
  therefore has a defined native outcome, not a missing Dreamux recovery case.

**Required correction:** Delete both proposed host RC queues. Send Claude
control requests directly and correlate each response by its request ID.
Replace the startup-only singleton ID at
`packages/agent-runtime/claude-code/src/control-rpc.ts:20,74-77,118-119` with
pending response entries for the actual requests; remove entries on settlement
and reject the outstanding entries through existing session teardown. The
singleton overwrite is a real limitation of the old startup helper, but
response correlation solves it without another execution scheduler.

For Codex, retain the local `await enable; await pairing` dependency within one
enable call and send off directly through the captured existing client.
`CodexWsClient` already correlates concurrent requests and rejects them on
close (`packages/agent-runtime/codex/src/rpc.ts:129-146,236-243`). Preserve a
native pairing-disabled error and the fact that the earlier enable was
accepted; do not add a busy flag, cancellation manager, replay queue, mirrored
desired state, or automatic retry to hide that outcome.

**Verification:** During implementation, verify distinct Claude request IDs
settle their own callers and session exit rejects outstanding calls. For Codex,
hold pairing outstanding and verify off is sent without awaiting it, while a
native pairing error is preserved. These checks exercise the actual protocol
boundary; no new live experiment or compatibility project is needed to resolve
this design finding.

## Source-backed assessment of the mechanism

Apart from F2, no blocking ownership or native-protocol defect was established.

- **Codex's proposed startup and action mechanism is supported by source.**
  At `rust-v0.140.0`, `codex-rs/cli/src/main.rs:955-965,1123-1135` consumes the
  disabled-start environment input and selects `DisabledEphemeral` when no
  explicit native enable argument is present. The same tag's
  `codex-rs/app-server-protocol/src/protocol/v2/remote_control.rs:6-24,67-83`
  contains the ephemeral flags, manual-code request and pairing response.
  Dreamux already opts into experimental RPCs
  (`packages/agent-runtime/codex/src/handshake.ts:36-44`). This supports the
  proposed single protocol path, without proving live compatibility at that
  minimum.
- **Acknowledgement and connection are distinct facts.** At the researched
  Codex revision, `remote_control/mod.rs:293-352` updates desired state and can
  return `Connecting`; it does not wait for a remote client. The draft correctly
  avoids calling that a completed connection. Ephemeral disable changes native
  desired state (`mod.rs:373-398`); it does not invoke a turn interrupt or stop
  the local process. The provider should report the partial enable/pairing
  failure already described in the draft without inventing rollback state.
- **Native enrollment persistence is separate from a manual preference.**
  `codex-rs/state/src/runtime/remote_control.rs:67-102` updates enrollment
  identity without overwriting an existing enabled preference; explicit
  preference writes have a separate method at lines 105-129. The proposal adds
  no Dreamux persistence and correctly leaves native enrollment ownership
  upstream. It must not be described as making no native disk writes at all.
- **Claude can reuse its existing transport.** Dreamux already writes the
  enable request and correlates its URL response
  (`packages/agent-runtime/claude-code/src/control-rpc.ts:74-78,104-135`).
  Startup invokes that path at `supervisor.ts:122`. Replacing this log-only
  action and deleting its configuration/startup wiring is a real removal of
  an obsolete mechanism, rather than adding another service beside it.
- **Lifetime ownership is appropriate.** The command must retain the native
  session/client captured when it was admitted. Pending response promises
  terminate with that process through existing teardown. Core
  should neither mirror an enabled flag nor reconstruct provider readiness.
  Native request failure is not a reason to kill a local turn.

## Concrete deletion and addition account

The requirement's entropy ruling (`requirement.md:49-56`) makes F2 a required
deletion, even if a queued implementation passes its own tests. The account is
about concepts and owners, not a predicted line count.

| Mechanism | Decision and concrete reason |
| --- | --- |
| Claude profile switch | Delete the type field, default, accepted key and parser branch in `claude-code/src/config.ts:49,81,99,127-133`. The operator explicitly removed this configuration capability. |
| Claude startup enable chain | Delete the session-spec boolean and URL callback passed at `claude-code/src/runtime.ts:354-359`, the startup send at `supervisor.ts:122`, and the fire-and-forget helper/log-only result path at `control-rpc.ts:74-78,118-135`. Replace their action with one awaited boolean operation; do not retain two paths. |
| Dreamux RC queues | Delete both proposed queues and their queued-command replacement handling, for F2's native-ordering evidence. Keep no queue-cancellation or queue-generation state. |
| Feishu command and core routes | Add one command-table row and the two direct-recipient commands. Existing `/stop` routing and the requested three `/rc` forms pay for these additions; no permission layer or model submission is needed. |
| Optional runtime action | Retain only the optional method and one missing-method error at the runtime owner. This has an existing source-backed caller scenario: an accepted `npm:<package>` runtime provider implementing the current `AgentRuntime` contract receives the newly added `/rc` command. `config/config.ts:329-339,358-369` accepts external providers, `agent-runtime/external-provider.ts:99-128` loads them, and `dreamux-types/src/agent-runtime.ts:455-474` currently requires no RC method. Both built-ins implement the action. This preserves the existing provider entry point without adding a capability catalog, provider allowlist, version negotiation, or preflight probe. No deployed external provider is claimed to have been observed. |
| Missing-process and close checks | Reuse the existing runtime-owner and resident-session facts. A dormant recipient and a native child that exited while its host handle remains are real distinct cases (`teammate-service/runtime-owner.ts:88-104`; `claude-code/src/supervisor.ts:138-149`). Check them at their owners; add no mirrored liveness state, busy check or native status polling. |
| Claude response correlation and settlement | Add only per-outstanding-request promise correlation inside the existing control RPC owner. Two commands can otherwise overwrite its singleton request ID. A child exit before its response must reject the caller; extend the existing close path (`claude-code/src/rpc.ts:148-182`) rather than adding a recovery owner. Entries are removed when settled, not retained as a process-lifetime ledger. |
| Codex action and process reference | Add the two native calls for on and one for off, using the existing client request map. Capture that client once so the pairing continuation cannot target a replacement process. Its existing closed-client rejection and teardown settle the operation; no RC-specific generation counter or retry is needed. |
| Codex startup input and minimum | Add the native disabled-start input and update the existing version gate as proposed for approval. The real case is a native saved enabled preference otherwise restoring at startup; 0.137 lacks the required ephemeral fields/startup input and 0.140 contains them. This changes one existing gate rather than adding protocol negotiation. |
| Connection information and receipts | Keep the native URL or manual pairing code/expiry as action-result data, forwarded through core and rendered in Feishu. A result's acknowledged status is receipt data, not a retained state mirror. Keep native errors and the existing command failure receipt; add no synthesized URL, fallback token, code cache, rollback or connection monitor. |
| Timeouts, retries and recovery | Add none in this task. Native pairing owns network timeout/retry behavior. Repeating `/rc on` is another operator action, not an automatic retry mechanism. No established failure warrants a new timer, saved manual preference, desired-state replay, private Codex home, enrollment owner or isolation layer. |

After these deletions, the remaining new responsibility is answering one
requested runtime action and returning native connection information. Native
providers continue to own execution ordering, bridge lifecycle and enrollment;
Dreamux retains only the response promises needed to answer its callers.

## Unverified assumptions and acceptance evidence

These are not confirmed defects or blockers to solution approval. Native live
connection evidence belongs to later approved implementation validation and
does not authorize an isolation redesign.

1. **Two live Codex instances sharing an enrollment.** Unix transport does not
   create the initializing-client-name receiver used by stdio
   (`codex-rs/app-server/src/lib.rs:755-786`); native persistence looks up an
   enrollment by endpoint, account and optional client name
   (`codex-rs/state/src/runtime/remote_control.rs:30-48`). This establishes
   possible identity reuse, not backend interference. The live gate should
   prove that each remote action reaches its intended live thread, as well as
   proving that disabling A leaves B remotely usable and both local workloads
   intact. Merely receiving two pairing codes is insufficient evidence.
2. **Usable pairing information and the partial-failure receipt.**
   `manualPairingCode` is optional in the native response. The native CLI treats
   its absence as an error when rendering human output
   (`codex-rs/cli/src/remote_control_cmd.rs:472-484`). Carry the draft's
   enable-accepted/pairing-unavailable distinction all the way through the
   existing command error receipt, including a successful RPC lacking a usable
   manual code. A token must not be substituted for a manual code. No live
   response missing that field was observed here.
3. **Fresh-process off and provider/account eligibility.** The live gate must
   cover both a fresh conversation and a new process resuming an existing
   conversation. For Codex, include an existing native saved enabled preference
   and verify that it remains unchanged. For Claude, use the actual Dreamux
   headless arguments and record the binary version as evidence. Do not infer these outcomes
   solely from interactive Claude settings or from the older source snapshot.
4. **Settlement bounds.** Codex's native server HTTP request path has a timeout
   (`remote_control/server_api.rs:232-260`). This supports retaining native
   network ownership; it does not establish a measured bound for the entire
   Dreamux command under every account condition. No actual indefinitely
   pending native operation was established, so this review does not request
   an additional timeout/retry mechanism.

The draft's routing, process-exit, response-correlation, no-model-submission and
local-work-continuation checks are appropriate. Do not lock the removed host
queue into test expectations. Keep existing interrupt and
inbound-delivery assertions intact. Build, lint, test and test-typecheck gates
remain implementation gates; none was run for this document-only review.

## Evidence provenance

- Dreamux source: `next` after #451 merged.
- Codex research reference: fetched `origin/main`,
  `a86631502d49274cb47208925c7d3dcece032029`. Upstream references above use
  `git show origin/main:<path>`; paths abbreviated as `remote_control/...`
  are beneath `codex-rs/app-server-transport/src/transport/`. The working
  checkout's HEAD is older (`a8964cb1`), so it was not treated as the current
  research reference. The 0.140.0 tag resolves to
  `3ac9870e21f4ce9a28c3ae3b878b7f8f95eff06d`.
- Claude source snapshot: commit `ddee667`, dated 2026-03-31. Its
  `cli/print.ts:1502-1508,3892-4027` corroborates the earlier control path only.
- Installed Claude package metadata reports 2.1.277. Read-only inspection of
  its `bin/claude.exe` embedded code found the current boolean request handler
  at byte offset 213851701, URL outcome builder at 213741352, and disable
  teardown/acknowledgement at 213859172. Binary SHA-256:
  `722210f05ba494d8f6df69423c4d4f2960900f7a007d0532851c7a36e375cab7`.
  These are static observations, not a successful remote connection test.

## Approval readiness

**The draft needs F2's queue deletions before final operator approval.** This
is the only remaining blocking finding from this review; F1 remains withdrawn.
The correction removes mechanisms and needs no additional review round or
broader compatibility/isolation work. The proposed Codex minimum increase
remains a separate approval item because its parameter difference is
established in source.

Native connection usability, restart behavior and shared-enrollment
multi-instance checks remain part of later approved implementation validation.
They were not exercised here and are not prerequisites for completing this
design review. Implementation still requires the operator's approval.
