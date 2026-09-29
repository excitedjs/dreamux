# Feishu remote-control command: review draft

Historical review draft from 2026-09-21. The [final proposal](final.md) incorporates
the review adjudication and the operator's subsequent record-result decision.

This is the TeamLeader's proposal, not an approved implementation plan. Read the
[requirement](../requirement.md) first. The operator selected independent Seed,
Codex, and Claude reviews of this draft. Each reviewer should reconstruct the
simplest mechanism from the user story and source before evaluating this proposal.

## Outcome and ownership

An operator enables remote access to the agent addressed by the current Feishu
conversation, obtains the native connection information, and can turn remote
access off while local work continues. `/rc` and `/rc on` enable it; `/rc off`
disables it. Dreamux does not restore the manual setting after process restart.
There is no Dreamux configuration switch or saved manual setting. Existing native
Codex preferences remain owned by Codex and are not overridden by this command.

Follow the capability ownership established by the `/stop` task and PR #379:
Feishu parses the operator action and renders the receipt; core resolves the
recipient and retains runtime ownership; the runtime provider acts on its native
process. Subsequent runtime activity work in #442 and #446 keeps native facts
behind the provider boundary. This action adds no pulled runtime-state getter,
new activity stream, or core knowledge of either native control protocol.

```text
Feishu /rc [on|off]
  -> existing conversation route
  -> dispatcher.remote_control or team.remote_control
  -> existing direct recipient's runtime owner
  -> AgentRuntime.setRemoteControl(enabled)
  -> Claude stream control request / Codex app-server RPC
  <- native acknowledgement and connection information
  <- one channel-owned receipt
```

## User-facing behavior proposed for approval

- Use the existing human-message and group-mention command admission. `/rc`
  appears in `/help` through the same command table.
- Resolve the same direct recipient as `/stop`: a bound TeamLeader or the
  Dispatcher Agent. Do not fan out to the Team's other members. A provision route
  without a bound Team receives the existing no-bound-Team explanation.
- No argument means on. Accept one `on` or `off` positional argument; other
  positional forms return `Usage: /rc [on|off]`. Retain the existing parser's
  command-token and argument handling rather than expanding other commands.
- Operate on an existing native process, including while it is busy. Do not start
  a dormant agent merely to expose it remotely. If no process exists, say it is
  not running and ask the operator to start a normal conversation first.
- Repeated on/off requests set the requested state; `/rc` is never a toggle.
  Repeated on may issue a fresh Codex pairing code; no code cache is needed.
- Successful enable means the native enable operation was accepted. It does not
  assert that a remote client has paired or that the relay is already connected.
  Return Claude's session URL or Codex's manual pairing code and expiry when
  supplied. An off receipt says remote control was disabled, not that work stopped.
- Native authentication, policy, and protocol errors are visible through the
  existing command failure receipt. Do not prompt the model to interpret `/rc`.

These routing and receipt details are proposed defaults derived from the existing
command surface, not new quoted operator decisions.

## Neutral action contract

Add one action to `AgentRuntime` in `@excitedjs/dreamux-types`:

```ts
setRemoteControl(enabled: boolean): Promise<AgentRuntimeRemoteControlConnection>;

interface AgentRuntimeRemoteControlConnection {
  readonly url?: string;
  readonly pairingCode?: string;
  readonly expiresAt?: string; // ISO timestamp for a returned pairing code
}
```

Resolution acknowledges the requested action; rejection carries its native
failure. The result contains only connection information. Off resolves to an
empty object; the caller already knows which action it requested. Core forwards
the result; Feishu formats each supplied field.
Do not put provider names, raw RPC envelopes, environment registration IDs, or
native authentication tokens in this neutral result.

Both built-in providers implement the action, as they implement `interrupt`.
Add no capability registry, optional-method guard, or hypothetical unsupported-
provider branch. Update runtime fixtures to the extended provider contract.

Add `dispatcher.remote_control` with `{ enabled: boolean }` and
`team.remote_control` with `{ team_name: string, enabled: boolean }`. Use ordinary
core command registration and schemas, with the same service admission/close
fences as their interrupt peers. No separate permission mechanism or MCP tool is
required. Reach the existing runtime through `TeammateRuntimeOwner`; do not copy
provider IDs or reconstruct native state in core. An owner with no runtime and a
provider whose native child has exited both report a not-running error.

## Claude Code provider

- Replace the current fire-and-forget enable request with a request/response
  operation accepting `enabled`. The wire request is
  `control_request` with `request: { subtype: 'remote_control', enabled }`.
- Carry the action through the existing runtime, resident session, stream RPC,
  and control RPC owners. Change the existing mechanism rather than introducing
  another native transport or a separate remote-control service.
- Correlate the request ID until `control_response`. An enable success extracts
  `session_url` or `connect_url`; a disable success needs no URL. Surface native
  errors rather than only logging them. Do not synthesize a URL from a session ID.
- A missing URL after an acknowledged enable is reported as enabled without
  connection information, with a clear receipt; it must not be presented as a
  completed remote connection.
- Scope pending control requests to the resident process. Settle them on write
  failure, native response, process exit, or stop. A turn's result is not an RC
  acknowledgement; keep interruption settlement independent.
- Correlate concurrent RC requests by their individual request IDs instead of
  overwriting the startup helper's singleton ID. Claude already serializes its
  native bridge actions; do not add a Dreamux RC execution queue.
- Remove `remote_control` from the configuration interface, defaults, allowed
  fields and parser; remove the startup enable branch, the session-spec boolean,
  and the startup-only URL callback. Replace the existing enable helper with the
  boolean action instead of leaving both paths behind.
- Removing Dreamux's startup request establishes the default for its headless
  process. Validate against the installed native binary; do not silently edit
  upstream Claude settings or reinterpret arbitrary user-supplied `extra_args`.

## Codex provider

Keep one existing app-server per agent and its current Unix socket transport.
The action uses that process's existing initialized `CodexWsClient`.

1. Enable with `remoteControl/enable`, `{ ephemeral: true }`.
2. Obtain connection information with `remoteControl/pairing/start`,
   `{ manualCode: true }`. Native pairing can load/enroll and refresh the server;
   no Dreamux polling loop or copied enrollment state is needed.
3. Return `manualPairingCode` and converted `expiresAt` after acknowledgement.
   Do not claim that a pairing code means a client is connected. Do not expose the
   opaque machine pairing token or construct undocumented connection URLs.
4. Disable with `remoteControl/disable`, `{ ephemeral: true }`. Do not revoke
   registered clients, stop the daemon, kill the process, or interrupt its turn.

Within one enable call, await enable before requesting pairing. Send off directly
through the captured existing client, including while pairing is outstanding.
Codex owns separate native serialization scopes for switching and pairing, and
checks enabled state again before returning a pairing result. Do not add a
Dreamux queue that makes off wait for pairing. The existing client's request
correlation and close settlement own pending work; do not replay it onto a
replacement process or introduce another generation counter.

Pairing failure after enable is a partial native operation: report that the
earlier enable was accepted but pairing information could not be obtained,
including the native error. A concurrent off may already have disabled RC; do
not assert that it is still enabled. A repeated `/rc on` retries the native
operations. Do not automatically undo a previous native action.

### Version boundary

The checked `rust-v0.137.0` has unparameterized enable/disable requests.
`rust-v0.140.0` has the ephemeral request fields. Propose raising
`MIN_CODEX_VERSION` to `0.140.0`, updating
provider diagnostics, owning maintenance documentation and the version contract
together. This avoids maintaining two native protocol variants solely for this
feature. The increase needs operator approval with the final solution; it is
not already authorized by the command request. Verify the complete path at the
new minimum and the installed 0.153.4 before claiming compatibility.

### Shared enrollment evidence boundary

Several app-server processes may reuse one enrollment because the Unix transport
does not scope it by the initialized client name. Their ephemeral switches still
belong to their separate processes. Local source does not prove how simultaneous
relay connections sharing that enrollment are treated by the backend.

Do not add a private Codex home, change transports, patch upstream, or promise
connection isolation based only on the cache key. A live multi-instance check is
an acceptance gate: enable A and B, connect to each, disable A, and establish
whether B remains remotely usable and its local turn continues. Record native
identity reuse separately from observed interference. If the required current-
recipient behavior cannot be delivered, return to the operator with the actual
failure and options; do not broaden the architecture under this draft.

## Lifetime and failure ownership

There is no new config/state field. Manual actions are provider facts; core does
not retain a boolean and the channel does not cache a toggle.
Stopping or replacing a process drops pending work with an error and never
replays a desired state. `/rc off` itself does not stop or replace the process.
Claude receives no startup enable request. Codex retains its existing native
startup behavior: a separately saved native enabled preference can still apply.
The requirement removes Dreamux's global switch and replay of its manual action;
it does not authorize overriding such native preferences. Do not inject the
internal Codex disabled-start environment marker.

Only add timeout/retry machinery for an observed native control operation that
otherwise leaves the command unanswered while the process is alive. Native
pairing already owns its network timeout/retry policy. Do not use a control
timeout to kill ongoing local work, and do not reuse a turn completion as an RC
acknowledgement. The review should challenge whether request settlement remains
bounded under actual native failure behavior.

## Configuration removal and knowledge

- Old Dreamux configurations containing `agents[].config.remote_control` must
  remove that property from each affected Claude Code agent before upgrading.
  Continue rejecting unknown keys; add no compatibility reader or silent rewrite.
- Remove current usage/examples from `packages/dreamux/README.md` and update the
  owning maintenance reference `references/builtin-claude-code.md`. Keep current
  references current-only; historical migration instructions belong in the Rush
  change note and public upgrade notes.
- Add a Rush change note using the repository's `BREAKING:`/`Rebuild:` convention
  for the config removal. The Codex minimum is checked by doctor/onboard, not
  serve; its change is an ordinary note. Use type `minor` for packages still on
  0.x. Add ordinary notes for command and neutral API additions where required.
- Update the product catalog and channel/provider runtime KB for the new command,
  neutral action and removed startup switch. Update maintenance routing and the
  Codex owning reference to reflect the approved minimum.

## Verification plan

Implementation requires separate operator approval. No product prototype or live
remote enrollment has been run during solution work.

- Channel tests: three valid command forms, invalid arguments, help registration,
  group mention handling, bound/direct/provision routes, deterministic receipt,
  no model submission, no fan-out, and native error reporting.
- Core tests with runtime owners: route to the existing direct recipient, no
  start on a dormant recipient, close/start races, and
  forwarding of typed connection information without native protocol knowledge.
- Claude transport tests: both boolean requests, matched native responses,
  native error, missing URL, distinct concurrent request IDs, child exit/stop settlement,
  and no startup enable. Existing interrupt/turn lifecycle tests must retain
  their original assertions.
- Codex protocol tests: ephemeral parameters, native pairing output,
  enable-then-pairing failure, off sent while pairing is pending, client replacement, and no daemon
  stop/turn interruption. Version gate checks the selected minimum.
- Configuration tests: a valid profile without the field, explicit rejection of
  the removed field, and maintenance/example consistency through normal checks.
- Live gates: real native enable/disable and connection information on both
  providers; local work continues after off; Dreamux restores no manual state; two Codex
  processes can be operated as described above. Missing account eligibility or
  unavailable client access is reported as missing evidence, not a passing gate.
- Run the required Rush build, lint, test, and typecheck:tests stages plus the
  repository knowledge check after implementation and knowledge closeout.

## Complexity account and alternatives

Remove the shared profile setting, startup enable path, and log-only response
callback. Add one runtime action and the two core routes needed by existing
recipient ownership; no new persisted record, provider registry, polling worker,
or global remote-control manager is introduced.

The existing route also requires five forwarding methods: two on
`DispatcherService` (its agent and a TeamLeader), and one each on `TeamService`,
`TeammateService`, and `TeammateRuntimeOwner`. This extends the existing forwarding
family criticized and recorded in
[add-dispatcher-submit-command](/.agents/tasks/architecture/add-dispatcher-submit-command/requirement.md).
The extension is proposed because these services presently own recipient access
and admission; collapsing the whole family would widen this command task. This
is acknowledged boundary debt, not an entropy reduction claim about those methods.
The current TeamService file is close to its line gate. If implementation exceeds
that gate, identify a coherent responsibility boundary or report the required
refactor; do not trim comments or move arbitrary helpers to evade the check.

Sending `/rc` as model text cannot reliably switch a native transport. Modifying
the shared profile cannot meet per-process manual control. Launching another
Codex remote-control daemon would control another process. A per-runtime private
Codex home or transport replacement is unproven scope expansion. Two protocol
variants for older Codex are possible but increase maintenance; reviewers should
evaluate that trade-off against the proposed minimum increase rather than assume
the increase is already decided.
