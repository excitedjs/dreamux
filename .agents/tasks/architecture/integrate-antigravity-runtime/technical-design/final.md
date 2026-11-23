# Final technical solution

## Decision

Add one published but optional Rush package,
`@excitedjs/agent-runtime-antigravity`, at
`packages/agent-runtime/antigravity`. Its package-root default export is an
`AgentRuntimeProviderFactory`; operators load it through
`npm:@excitedjs/agent-runtime-antigravity`. It is not an always-loaded plugin,
is not added to `@excitedjs/dreamux` dependencies, and requires no
Antigravity branch in Core.

One provider-owned config selects `transport: "tmux" | "acp"`; omission means
`tmux`. Selection happens in `createRuntime`. There is no runtime switch,
automatic fallback, second provider id, or persisted transport mirror. A later
launch reads current config normally and must exact-resume the same opaque
native id through the selected mode or fail.

The common minimum native baseline is `agy` 1.5.15, subject to live capability
probes. Tmux follows botmux's native TUI input/transcript evidence; ACP is one
resident session using the official stable ACP v1 TypeScript SDK, not botmux's
process-per-turn runner. No one-shot/headless transport is added.

Process ownership stays at the existing-provider level: direct
`SupervisedChild` ownership for ACP and provider-owned private tmux session
lifecycle for tmux. There is no systemd dependency, owner IPC child, profile
lock, cleanup barrier, hook registry, or new crash-containment subsystem.

## Package and ownership

```text
packages/agent-runtime/antigravity/
  src/
    index.ts                 default factory and public config exports
    provider.ts              provider capabilities and the one transport switch
    config.ts                provider-owned config reader/defaults
    diagnostic.ts            selected-mode binary/version/platform checks
    paths.ts                 native home, generated profiles, logs, tmux socket
    native-profile.ts        per-runtime native agent.md and declarative tools
    tool-display.ts          Antigravity native tool projection
    tmux/
      runtime.ts             AgentRuntime, native admission and turn membership
      session.ts             private tmux server/session lifecycle
      input.ts               serial native writes and full-transcript admission
      viewport.ts            ready/busy/interrupted native screen evidence
      terminal.ts            transcript + viewport terminal state machine
    acp/
      runtime.ts             AgentRuntime, prompt membership and lifecycle
      session.ts             direct SupervisedChild + official-SDK ACP v1 client
      events.ts              native updates to neutral live activity
    transcript/
      records.ts             native full-JSONL record decoding
      live.ts                tmux incremental native observation
      reader.ts              bounded cold readRecentActivity
      cursor.ts              opaque cursor/digest/ordinal envelope
  tests/
```

Dependencies are `@excitedjs/dreamux-types`,
`@excitedjs/dreamux-utils`, and `@agentclientprotocol/sdk` using its stable v1
entry point. The package never imports `@excitedjs/dreamux`; package source uses
only asynchronous filesystem/process APIs.

`paths.ts` resolves native roots consistently for launch, diagnostics, and cold
reads from the native environment plus `config.extra_env`:
`~/.gemini/antigravity-cli` owns native history/conversations and
`~/.gemini/config` owns generated custom-agent discovery. Volatile tmux sockets
remain under neutral `runtimeSocketDirs`; no durable rendezvous or provider
ownership document is invented.

The two modes implement `AgentRuntime` separately. Native admission, steering,
and result membership remain in the mode that has the evidence. They reuse
`RuntimeStateFence` and Antigravity-local pure record/display helpers where
those are genuinely shared. There is no generic transport abstraction in Core
or `dreamux-types`, and no cross-provider import from Claude Code or Codex.

## Provider config

The initial config is deliberately limited to:

- `transport`: `tmux` (default) or `acp`;
- `bin`: native `agy` executable, default `agy`;
- `model` and `effort`: optional native selections;
- `extra_args`: raw native arguments, with the same operator-owned escape-hatch
  meaning as existing providers;
- `extra_env`: native process environment additions.

There is no login, account, rotation, web-terminal, fork, ACP-process-per-turn,
or arbitrary timeout configuration. Onboarding collects only `bin` and
`transport`. Diagnostics check `agy`, the 1.5.15 minimum, the selected mode,
`tmux` when selected, socket placement, and platform support. They add no
bespoke authentication check or login prompt.

## Direct process lifecycle

ACP follows Claude Code's resident-process shape: one `SupervisedChild` directly
owns `agy acp --stdio`, and the official SDK uses its stdin/stdout without an IPC
relay. `SupervisedChild.stop()` supplies bounded native process-tree termination
and Windows Job behavior. Registration and native protocol handling live in the
ACP session, not in a process intermediary.

Tmux mode owns one private tmux server/session through `-S`, never the user's
default server. Ordinary asynchronous tmux commands create, inspect, and stop
that owned session. A clean stop kills only the owned server/session and
verifies it is gone. Failed partial start rolls back resources already created.
A later normal restart starts a new native process and exact-resumes through
`--conversation <id>`; v1 does not adopt an old live TUI across Core generations.

These are the same lifecycle boundaries as the existing providers, not a new
strong containment guarantee. A hard daemon crash can orphan a private tmux
server or detached native task after Core has swept its volatile socket. This
slice does not pretend to recover resources whose ownership endpoint is gone,
and does not add an Antigravity-only watchdog/service manager to solve it.
Normal `AgentRuntime.stop()`, managed graceful restart, and failed-start rollback
are required and tested. Strong hard-crash containment for all providers would
be a separate generic platform capability and operator-approved task.

## Native role profile

`native-profile.ts` renders one stable native main-agent profile per host/runtime
from the immutable create context. Both modes explicitly select it with `--agent`.
The profile carries:

- the selected `systemPrompt` representation, preserving append-fragment order;
- direct absolute skill paths enumerated from Core's `skillSources`;
- explicit native `skills` and `mcpServers` lists, including empty lists, so
  role capabilities do not come from mutable ambient configuration;
- declarative native disabling of `ask_question` for `userInterrupt` and the
  whole native `schedule` tool group for `cron`, including one-shot reminders.
  The profile capability probe must establish this native configuration before
  implementation; no hook fallback is pre-planned;
- for tmux only, exact Core-selected stdio `mcpServers`, including args and lease
  environment. ACP instead passes its MCP list in session setup.

`excludeDefaultComponents` is not used to simulate prompt replacement because
it also removes built-in tools. Where Core supplies replace and append as
alternatives, the adapter applies at most one. A required instruction that
native configuration cannot apply fails start.

Profiles use one stable server-owned name per host cache identity and
`runtimeId`:
`~/.gemini/config/agents/dreamux-<host-id>-<runtime-id>/agent.md`.
Each launch rewrites that exact file with owner-only permissions. It persists on
normal stop because agy exact-resume reloads the original named role: a native
probe proved that removing the file restores the same conversation id but falls
back to the default agent, while restoring the file brings the role back. Start
must reject native missing-role fallback rather than claiming ready. No
later-launch sweep, generation cleanup, or cleanup of another role is introduced.
Shared `settings.json`, `mcp_config.json`, `hooks.json`, and discovery manifests
are never edited. HOME/XDG redirection and credential copying are not used.

Live probes with two concurrent roles in each mode must prove explicit `--agent`
selection (older agy could warn and fall back), role prompt/skills, empty MCP
inheritance, exact MCP lease env, no ambient role inheritance, and disabled
features. If the native profile cannot provide capability isolation,
implementation stops rather than writing shared global config.

## Common runtime semantics

- Registration precedes every native write. `submitted` requires positive native
  transport or protocol evidence; proven pre-write failure is `failed`, while a
  write that may have crossed the native boundary is `ambiguous` and is never
  replayed. Late native work remains observable.
- Neither mode represents a provider-memory FIFO as native admission. Each mode
  owns native-turn membership. One normal/failed native terminal creates one
  immutable completion, publishes `turn.result` once, and settles all native
  members with that same object. Pending or unrelated input cannot consume a
  background result.
- Confirmed interruption emits `turn.interrupted` and
  `turn.ended(interrupted)`, settles interrupted submissions `stopped`, and
  publishes no synthetic result. `turn.interrupted` uses a real stable native
  interrupted-record/result id, as Claude Code does; a host submission id,
  transcript offset, or invented turn number is not accepted. A normal result
  racing cancellation remains normal. Transport loss creates no result.
- Every native terminal publishes its matching `turn.ended`; live-session
  teardown publishes one final interrupted end even if no display is open.
- `trigger` is behavior. A busy `user` input may steer. A non-user input uses the
  same prompt path only if agy preserves the in-flight answer and tool work;
  otherwise a native append/inject capability must return `appended`. If agy has
  neither non-interrupting steering nor append, the affected mode returns through
  the operator gate rather than hiding news in a provider queue.
- `stop` synchronously fences new input, converges all started admissions, stops
  owned native resources without waiting indefinitely for protocol close, and
  emits the required teardown end. Deliberate stop settles outstanding work
  stopped; transport loss fails it without manufacturing a result.
- Both runtimes use `RuntimeStateFence`; durable state-write failure or lease
  revocation tears down the live runtime rather than accepting new work.

## Tmux mode

### Native session

A runtime owns one private tmux server addressed with `-S`. Its socket is a fresh
neutral volatile allocation. Ordinary tmux commands create/control one constant
private session; there is no custom control client, pipe-pane relay, web
terminal, or fleet manager. Native agy logs live under the neutral logs
directory. Unattended launch uses agy's `--dangerously-skip-permissions` and
process-local `--log-file`, matching botmux's native adapter; the live probe
verifies that fresh-cwd trust and ordinary tool calls do not block. Shared user
trust settings are not edited.

A resumed runtime launches `agy --conversation <opaque-id>` and verifies that
exact id. It never uses most-recent discovery. botmux's current adapter records
that agy ignores a caller-supplied fresh id and that `--conversation` is only an
existing-conversation lookup, so the provider does not generate its own session
UUID or probe that path as a proposed creation mechanism.

Fresh start may be lazy: botmux observed no native conversation/transcript until
the first prompt, while agy's `--log-file` later reports the authoritative
`Streaming conversation <uuid>` line. Entry probing must find a prompt-free
native action that publishes a real id before ready. The provider never invents
an id, guesses the latest conversation, calls ACP as a hidden allocator, or
sends a synthetic model prompt. If no such action exists, implementation returns
for the explicitly approved neutral-contract amendment required by the
requirement; it does not silently delay the id on its own.

### Literal input and admission

The ordinary input encoder uses one tmux buffer and one bracketed paste; Enter
is a separate write. There is no legacy-version or alternate-transport fallback.
Literal paste-terminator/ESC/control sequences must appear as exact native
`USER_INPUT`. Core's ordinary XML provenance envelope already ensures that a
user-authored leading slash is not the first character agy receives. The provider
therefore has no slash-command handling: no escaping, passthrough, trailing
newline, or per-command branch. If raw paste cannot preserve one ordinary input
class, only a documented native literal/quoted-input action may be used; it must
not reject content or change model text.

One writer owns the composer. It releases a subsequent write after the previous
input has positive native `USER_INPUT` evidence; viewport evidence for composer
clearance is added only if a native probe proves the record can precede actual
consumption. This serializes native writes, not turns: B can enter while A's
tools still run. Any uncertain native write follows the existing `ambiguous`
plus transport-failure/stop path. The stopped runtime fences later submissions;
only a later explicit restart exact-resumes the native conversation. No
Antigravity-specific blocked state or recovery mechanism is added.

A tmux success exit is not submission. Before writing, the provider records the
bound conversation's full-transcript identity/end offset, or an explicit
`missing` baseline. Missing-before-first-input is valid: native creation starts
reading at byte zero. One complete later `USER_INPUT` with exact full content is
admission evidence for the one outstanding composer write. `history.jsonl` is
not evidence because previews truncate and global same-text entries can belong
to another role. Transcript identity gaps or uncertain native membership are
ambiguous; no paste or Enter is repeated.

### Viewport and terminals

Only native trust/permission readiness states demonstrated by the live probe are
recognized when they affect unattended startup or tool execution. Otherwise the
ordinary start/turn failure and native diagnostic path applies. There is no
Antigravity-specific authentication page classifier or general interactive-page
recovery framework, and the adapter never blindly approves a dialog.

The terminal state machine preserves the native distinctions its live probe
establishes:

- content-only `PLANNER_RESPONSE` is provisional;
- conversation-waking background work and subagents hold final settlement until
  native task/terminal evidence proves they can no longer wake the turn;
- native non-blocking daemons do not hold a completed turn forever;
- foreground activity alone does not release a still-running waking task;
  callback-less completion requires native DONE plus ready/quiet evidence;
- a native `ERROR` is a failure candidate because agy may retry and succeed;
  later native final evidence wins, while unrecovered terminal failure settles
  failed;
- interrupted native evidence can release a dangling tool transcript, while a
  normal final racing interrupt remains normal.

The interrupt key is selected by live probe, not tmux convention. Interrupt
preserves the conversation and must supply a real native interrupted-record id,
including after multiple inputs join one turn. If agy has no such identity, the
mode returns for a neutral-contract decision rather than synthesizing one.

## ACP mode

One `SupervisedChild` directly runs resident
`agy acp --stdio --agent <generated-profile>`. The official SDK's stable v1
client owns NDJSON/JSON-RPC framing and request types over child stdio. There is
no owner child, byte relay, custom acknowledgement protocol, or process-per-turn.

Start performs `initialize`, checks protocol/capabilities, then exact
`session/new` or `session/load` with `cwd` and Core-selected stdio `mcpServers`.
Replay from load is not re-emitted as new live activity. Native id mismatch or
unsupported exact load fails start. Model/effort use negotiated native options
and observed current values.

Every prompt-path submission gets its own `session/prompt` immediately,
including while another prompt is active; a verified append path returns
`appended`. Registration precedes writing. The direct child stdin write callback
resolves early admission, and a valid native terminal with the matching
JSON-RPC request id is independent positive acceptance evidence if it arrives
first. Either admits once; a late callback/result never admits or settles twice.
The request id binds response membership independently of final text, so B's
receipt does not wait for A's long tool turn.

Live tests must establish actual busy-prompt behavior: queued native turns get
their own terminals, while a steered/merged turn must identify all consumed
inputs and their result membership unambiguously. If agy cannot accept busy
input, identify merged membership, or deliver news without truncation, ACP stops
for an explicit capability/contract decision rather than guessing.

ACP stop reasons map explicitly:

- `end_turn` publishes a completed result and completion settlements;
- `max_tokens`, `max_turn_requests`, and `refusal` publish one failed native
  completion with the native reason;
- native `cancelled` publishes interrupt/end activities and stops its member
  requests without a business result; `interrupt()` is answered from the actual
  native terminal rather than from the local request alone.

Every terminal emits `turn.ended`; teardown and transport loss emit an
interrupted end without a result. Retryable native error activity yields to a
later real terminal. Native permission requests receive the same immediate
unattended allow response as Claude Code; the official SDK handles the ordinary
ACP exchange without a provider-side pending-request tracker. Unsupported
elicitation/fs/terminal client capabilities are not advertised. `session/close`
is optional on stop and never delays bounded `SupervisedChild` teardown.

`session/update` projects message/tool/reasoning/compaction/title facts only
when native objects provide required stable identity. Missing message ids are
not synthesized; optional live activities may be omitted while result text is
still aggregated from that prompt's own updates. ACP context-window usage is
not cumulative input/output `token.usage` and is omitted unless agy supplies the
actual counters. Interruption uses a real native terminal/result id, including
merged prompts; a session or JSON-RPC request id is not automatically a turn id.

## Transcript and cold activity

Both modes leave native recovery data in the existing authenticated agy home.
The only cold-read source is:

`<agy-home>/brain/<session-id>/.system_generated/logs/transcript_full.jsonl`.

The 1.5.15 baseline writes the full log, so no compact-log compatibility or
compact-to-full cursor translation is added. Live first-input missing-file
handling is defined above; a cold missing/unreadable session uses the neutral
activity error contract. Compact truncated text is never presented as complete.

`records.ts` owns actual native record decoding. Live `RuntimeActivity` and cold
`AgentActivityRecord` remain separate contracts. The bounded cold reader reuses
`dreamux-utils` file opening, containment, digest, positional-read, and scan
primitives without importing botmux bridge types.

A cursor contains native record position/digest, projection ordinal within that
record, and the `includeTools` query fingerprint. One native record containing
text and several tools projects in stable order, and `limit=1` continuations
resume at the next ordinal without duplication or loss as the file grows. Reads
have total decoded-byte and single-record bounds. The named scenario is a single
JSONL line holding a huge tool argument/result: oversized input raises
`ActivityError('scan_unsupported', ...)`, which Core exposes as
`provider_failure`, rather than allocating without bound or silently truncating.
Ordinary records return complete text. Cold reads never launch or mutate agy.

## Structured output, platforms, and authentication

Neither approved mode has evidence of native session-bound final-output JSON
Schema. `createRuntime` therefore throws
`unsupportedFeatureError("outputSchema", ...)` for both modes when requested.
Schema-driven Dynamic Workflow steps are unavailable on this provider in this
slice; no prompt emulation or headless side channel is introduced.

Tmux mode fails clearly on Windows. ACP uses direct stdio and
`SupervisedChild`'s existing Windows Job support and remains subject to a real
Windows live gate. Neither platform failure selects the other mode
automatically.

The user authenticates agy outside Dreamux. The provider uses that native home
and environment as-is, has no OAuth/login/account pool/rotation feature, and
adds no special login prompt. Native auth errors remain ordinary native errors,
matching Claude Code/Codex capability boundaries.

## Implementation sequence and verification

Only architecture-changing native probes precede the full adapters:

1. Fresh/exact session identity: a prompt-free real fresh native id before ready;
   same-mode exact resume and bad-id failure; then cross-mode exact resume or
   loud capability failure.
2. Native role/protocol capabilities: generated profile selection and isolation,
   disabled tools, MCP/env, model/effort, exact ACP load, busy steering/news,
   literal TUI input, interruption identity, and background terminal evidence.

After those probes, implement the direct ACP supervisor, private tmux session,
and bounded reader, then the two native runtimes behind one shared behavioral
contract suite. A native capability gap returns through the operator gate; it
is not waived by a fixture or patched with hidden Core behavior.

Verification includes:

- pure config/profile/record/cursor/tool-display tests plus deterministic cold-
  reader fixtures for intra-record pages, growing files, and decode bounds;
- shared runtime tests for multi-send, user steering versus news, native
  admission/membership, exact completion identity/order, unbound native turns,
  stop reasons, interruption races, and teardown convergence in both modes;
- private-tmux fake-native tests for literal bytes, missing first transcript,
  long/cross-role identical input, ordinary native write failure and stop,
  trust/permission pages, background overlap, retryable errors, interruption
  identity, unrelated-server preservation, and failed-start rollback;
- official-SDK ACP fake-peer tests for capabilities, exact load/replay,
  write-before-response and response-before-write admission, concurrent prompt
  membership, immediate permission responses, stop reasons, optional activity
  identity/usage, non-blocking close, transport loss, and direct child cleanup;
- real agy 1.5.15 live tests for every probe plus full-log cold reads, two-role
  isolation, normal stop/restart, and cross-mode resume. Tests use a
  pre-authenticated native installation, never automate login or commit
  credentials/private transcripts, and record unrun scenarios as coverage limits;
- `rush build`, `rush lint`, `rush test`, and `rush typecheck:tests` all pass,
  with existing Codex/Claude and non-blocking-inbound gates unchanged and green.

## Repository and knowledge closeout

- Register the new publishable Rush project; do not register a builtin provider
  or add it to host dependencies.
- Extend generic package-boundary/no-sync-IO guards to include the new provider
  without naming it in Core production source.
- Update the product catalog, architecture/package map, provider-runtime
  ownership, state/path documentation, external-provider configuration example,
  and `dreamux-maintenance` routing plus one owning Antigravity reference.
  Generated native profiles are server-owned; native agy authentication remains
  user-owned; no migration/Rebuild recipe is needed.
- Add ordinary Rush `minor` change files for the new package and affected
  published packages. There is no upgrade blocker and no `BREAKING:` note.
- Preserve botmux MIT attribution for substantial adapted algorithms/code and
  sanitize ported fixtures/comments. Port behavior, not botmux worker/daemon/
  SQLite/Lark/global-gateway/session-scope machinery.

## Known limits

- Tmux is not supported on Windows; ACP Windows remains a live-validation item.
- Hard daemon-crash orphan reaping is not stronger than the existing direct
  provider lifecycle in this slice. Normal stop/graceful restart and partial
  start rollback are supported; no custom crash watchdog is claimed.
- Schema-driven Dynamic Workflow steps are unsupported.
- No native adoption/fork UI, web terminal, OAuth/account management, per-turn
  ACP process, compact transcript support, legacy agy input path, systemd
  prerequisite, custom owner IPC, durable tmux rendezvous, or process ledger is
  added.
- Native identity, role, or protocol probes can expose a capability gap. Such a
  gap returns through the operator gate rather than producing hidden Core
  changes, synthetic turns, global config rewriting, or transport fallback.
