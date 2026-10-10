# Add manual remote control through Feishu

This is the reviewed proposal recorded on 2026-09-21, archived at the operator's
request on 2026-09-29. It is not implemented. See the [task record](../README.md)
for authorization and the checks needed before implementation.

## Outcome

`/rc` and `/rc on` enable remote control for the existing agent process addressed
by the Feishu conversation. `/rc off` disables its remote control while local
work continues. Support Claude Code and Codex through their existing native
protocols. Remove `agents[].config.remote_control` and its startup auto-enable
path entirely from Dreamux.

Dreamux neither saves nor restores the manual setting after process restart.
This does not override preferences independently saved by a native Codex client.
Claude receives no startup enable request. No compatibility subsystem, remote
control manager, execution queue, polling worker, or new persisted state is added.

This solution incorporates the independent Seed, Codex, and Claude reviews and
the operator's explicit instruction to remove unnecessary defensive mechanisms.
Development approval is still required.

## Command and routing

- Add `rc` to the existing Feishu command table; `/help` lists `/rc [on|off]`.
  Keep the current human-message, mention, authorization, and parser behavior.
  No positional argument means on; one `on` or `off` selects the action; other
  positional forms return usage.
- Use the direct recipient already selected for `/stop`: the bound TeamLeader,
  or the Dispatcher Agent. A provision route with no Team returns the existing
  no-bound-Team explanation. Never fan out to other Team members.
- Operate on the existing runtime only. If it is dormant or its native process
  has exited, report that it is not running; do not start it from `/rc`.
- Use `dispatcher.remote_control { enabled }` and
  `team.remote_control { team_name, enabled }` in the existing core command
  namespaces and admission boundaries. Submit no model turn.
- A successful receipt acknowledges the requested switch and displays the
  provider's returned record generically. It does not claim that a remote
  client is connected. A repeated on/off is the same state-setting operation;
  repeated Codex on may return a new pairing code.

## One neutral runtime action

Extend the live runtime contract, following the mandatory `interrupt` precedent:

```ts
setRemoteControl(enabled: boolean): Promise<Record<string, JsonValue>>;
```

Both built-in providers implement it. Resolution acknowledges the action;
rejection explains its failure. The result is a JSON-serializable record whose
fields belong to the provider. There is no dedicated connection-result type or
union of known providers' fields. A later provider can return different fields
without changing the neutral contract. Off returns `{}` when there is no
additional information.

Core passes the record through. Feishu renders its entries generically without
switching on provider identity or requiring particular keys. The caller already
knows the requested action, so there is no status echo, capability flag,
optional-method check, or mirrored enabled state. Providers return information
intended for the operator, rather than raw protocol envelopes or authentication
tokens. `JsonValue` is the existing core command wire value type, not a new
runtime-specific schema.

### Claude Code

Generalize the existing `remote_control` request builder to accept `enabled`.
Replace the startup-only fire-and-forget call with a promise settled by its
`control_response`. Correlate actual pending requests by ID so concurrent Feishu
commands cannot overwrite the old singleton ID. Reject pending calls through the
existing write-failure and session-close paths.

Return the native `session_url` or `connect_url` as the provider's `url` entry on
enable. Disable returns `{}`. Claude already serializes native bridge actions and handles repeated
requests; add no Dreamux execution queue, timeout, version check, or fallback.
The installed 2.1.277 binary is an evidence label, not a new support boundary.

Delete the configuration field, default, accepted-key entry, parser, session-spec
startup boolean, startup enable branch, and log-only URL callback. Retain the
existing transport and process ownership.

### Codex

Use the existing initialized client of the existing app-server:

1. On: `remoteControl/enable { ephemeral: true }`.
2. After that acknowledgement: `remoteControl/pairing/start { manualCode: true }`.
3. Return the human-readable manual code as the provider's `pairingCode` entry
   and expiry as its `expiresAt` entry. Convert native expiry from Unix seconds
   with `new Date(expiresAt * 1000).toISOString()`. These keys belong to this
   provider's result, not to the neutral action contract.
4. Off: `remoteControl/disable { ephemeral: true }`, directly, including while
   a pairing request is outstanding. Return `{}` after acknowledgement.

Capture the current client for the call. Its existing correlation and close
handling settle pending requests; never replay onto a replacement process.
Native Codex orders switching separately from pairing and rechecks enabled state
before returning a pairing result. No host queue or extra generation fence is
needed. Do not stop the daemon, interrupt the turn, revoke clients, change
transport/home, or inject Codex's internal disabled-start environment marker.

### Connection-information failures

If enable was acknowledged but Claude supplies no URL, or Codex pairing fails or
supplies no manual code, the provider rejects with text stating both facts:
the earlier enable was accepted and connection information could not be obtained.
Include the native error where present. The existing command failure receipt
renders that message. Do not claim the current switch is still on: a concurrent
off may already have completed. Add no partial-result state or automatic rollback.

## Codex protocol boundary

Use the single `{ ephemeral: true }` protocol shape and update the existing
`MIN_CODEX_VERSION` constant from `0.137.0` to `0.140.0`, where those fields are
present. Keep enforcement in the existing doctor/onboard diagnostic path; add no
launch gate, version probe, legacy retry, or second protocol variant. Update the
handshake comment to acknowledge consumption of experimental RC methods; the
existing `experimentalApi: true` value already permits them.

At the checked `rust-v0.137.0` and `rust-v0.139.0` tags, these methods take
`Option<()>`, and enabling changes an in-memory boolean without persisting it.
They do not have the later `ResolvePersisted` startup path. The proposed object
params conflict with their unit-parameter schema, so `/rc` on those unsupported
versions is expected to fail with a native parameter error. Ordinary runtime
startup gains no new restriction. The claim that these old versions would write
a durable preference is rejected by the tagged source.

The minimum change is an ordinary release note because it does not block serve
startup. It remains an explicit part of this solution's approval scope.

## Scope and complexity account

The implementation touches the Feishu command table and tests; neutral runtime
types; core commands and existing recipient owners; the two runtime providers;
and the affected current docs, maintenance references, tests and change notes.

Remove the global config/startup mechanism and replace its log-only control path
with the operator-requested action. Add only the command, neutral action, native
request/response plumbing and connection receipt. Native ordering, enrollment,
network timeout/retry, and process teardown remain with their existing owners.

The existing core route requires five forwarding methods: two on
`DispatcherService` (its agent and a TeamLeader), and one each on `TeamService`,
`TeammateService`, and `TeammateRuntimeOwner`. This extends the forwarding family
whose cleanup was recorded during [PR #444](https://github.com/excitedjs/dreamux/pull/444).
These services presently own recipient access and admission. This bounded task
does not collapse the whole family; the extension is acknowledged boundary debt,
not a claimed reduction. If the TeamService line gate is exceeded, identify the
coherent responsibility change needed and report it; do not trim comments or move
arbitrary helpers to evade the gate.

## Configuration removal and documentation

Old configurations must remove `agents[].config.remote_control` from each
affected Claude Code agent. Preserve unknown-key rejection; add no compatibility
reader or silent config rewrite. This deletion blocks startup when the old key
remains, so its Rush change note uses `BREAKING:` and `Rebuild:` with that exact
removal action. Use ordinary notes for the new command/API and Codex diagnostic
minimum; use type `minor` for affected 0.x packages.

Update the public README, configuration-owning maintenance references and routing,
channel/provider KB, product command catalog, and the Claude protocol research
note's now-confirmed URL response fields. Current-state maintenance references
contain the final fields only; migration instructions belong in release notes.

## Verification and remaining evidence

- Channel/core: command forms and help, existing route/mention rules, no model
  submission or fan-out, dormant-runtime receipt, and forwarding/rendering a
  record without requiring keys from either built-in provider.
- Claude: both boolean requests, distinct request-ID settlement, native errors,
  missing connection information, pending-call cleanup, and removal of the
  startup enable request. Preserve existing interrupt/turn lifecycle assertions.
- Codex: ephemeral params, enable-before-pairing, manual code and expiry units,
  partial-operation errors, off dispatched while pairing is pending, and existing
  client-close settlement. Check the declared minimum against its tagged
  protocol and exercise the installed native binary during live validation.
- Config: reject the removed field and accept the remaining schema. Verify the
  documented manual upgrade action. No speculative timeout/capability tests.
- Live validation after approval: enable/disable both providers, obtain usable
  connection information, preserve local work after off, and confirm Dreamux
  does not replay manual state on process restart.
- Check two Codex processes against the real relay: each remote action must
  reach the intended live thread, and disabling A must leave B usable. Shared
  enrollment is source-confirmed; backend interference is not. A real failure
  returns to the operator with evidence rather than authorizing an isolation
  redesign. Account/client availability limits must be reported honestly.
- Run the required Rush build, lint, test and typecheck:tests gates, followed by
  the repository knowledge check after implementation and closeout.

No live enrollment or product prototype was performed during design review.
