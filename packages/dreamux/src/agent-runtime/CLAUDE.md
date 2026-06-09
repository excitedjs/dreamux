# agent-runtime/

The Agent Runtime seam: one runtime abstraction that serves **every** agent role
(dispatcher, teammate, and future team-leader/member). A "runtime" is a single
agent session; how it talks to its engine is the engine's business.

## What goes where

- **Top level** (`types.ts`, `turn.ts`, `catalog.ts`, `external-provider.ts`,
  `load-config.ts`, `index.ts`) — the **neutral** contract + the catalog (a view
  over the provider registry) + the `npm:` external-provider loader +
  `load-config.ts` (the caller-composed `loadConfigWithBuiltins` that registers
  the builtins then delegates to `config/config.ts`, so the config leaf never
  imports the catalog — see
  [`decisions/agents-config-normalization.md`](../../../../.agents/decisions/agents-config-normalization.md)).
  Nothing runtime-specific here. `load-config.ts` must never be imported by
  `platform/paths.ts` or a `builtin/*` module (that re-forms the #148 cycle).
- **`builtin/<name>/`** — one builtin's entire self-contained stack: transport
  (process supervisor + rpc + wire protocol/types + handshake), the runtime
  impl, the provider, CLI args, and its own `paths.ts`.

## Invariants (why it's shaped this way)

- **One contract, capability-declared differences.** Runtimes differ via
  `getCapabilities()` (resume checkpoint kind, steer, events, last/context,
  completion-delivery shape) — never via forked interfaces or `if (ref === …)`
  branches in callers. codex and claude are completely different mechanisms
  behind the same surface.
- **Config parse and doctor are provider-self-reported, not core-branched.**
  Each provider's optional `readConfig` parses its own `agents[].config` block;
  its optional `diagnostic` declares `binChecks` (doctor dedups + executes) and
  runs `runDiagnostic` for its own non-bin checks (codex: home + version >=
  0.137; claude: none). `config/config.ts` and `cli/doctor.ts` iterate providers
  and never branch on `BUILTIN_CODEX_PROVIDER_REF`. See
  [`decisions/agents-config-normalization.md`](../../../../.agents/decisions/agents-config-normalization.md).
- **No cross-builtin imports.** `builtin/codex/` and `builtin/claude-code/` must
  not import each other. Anything genuinely shared moves up (e.g. the inbound
  turn types live in `turn.ts`, the neutral process helpers in
  `platform/process.ts`).
- **Runtime specifics close over inside the builtin.** A builtin owns its own
  bin/home/thread/socket/stream/paths derivation; none of it appears in the
  shared contract, `server.ts`, `state/`, `platform/`, or the Dispatcher
  Service. `grep codex` outside `builtin/codex/` should trend toward zero.
- **External providers use the same path.** `npm:` providers load through
  `external-provider.ts` into the same `ProviderRegistry` + catalog as builtins
  (no third provider tree); they self-declare capabilities, which core validates
  but never mirrors.
- **cwd is a required launch parameter** on the create context — supplied by the
  launcher (Dispatcher Service), never derived inside the runtime.

## In flight (issue #143)

The runtime input surface is now three source/nature-named entries —
`channelInput` (channel-inbound turn), `systemInput` (system notice, e.g. a
restart notice), and the optional `completionInput` (teammate-completion
delivery). The completion contract is now source-agnostic: `completionInput`
takes a neutral `CompletionEnvelope { source; id; status; result }` (C2), the
`teammateCompletion` capability is an open `CompletionDeliveryShape
{ kind; description }` (each builtin self-declares its own kind —
`codexInboxTurn` / `claudeCodeTaskNotification`), and the runtime-state
checkpoint kind is capability-driven with no `codexThread` fallback. The
channel payload is now neutral too (D): `channelInput` takes
`InboundTurnInput { text; sourceId }` — turn text plus a dedupe/correlation id —
and channel routing attributes (chat id, sender id, message id) stay in the
channel layer and never cross into the runtime.

The reverse-delivery loop is now wired end-to-end (#147), so `completionInput`
is a live caller rather than zero-caller. A runtime fires the neutral
`TurnSettledSignal { turnId; status }` through the optional
`AgentRuntimeCreateContext.onTurnSettled` hook when a delivered turn reaches a
terminal state (completed / failed / stopped) — seam ①. The teammate service
launches teammate runtimes with that hook (and only then), maps each settle to a
`CompletionEnvelope`, and hands it to its `onTeamMateCompletion` sink — seam ②;
the dispatcher's own runtime gets no hook, so it never self-delivers. The facade
bridges that sink to `DispatcherAgentService.deliverCompletion`, which calls the
live dispatcher runtime's `completionInput` with bounded retry-on-`failed` — seam
③. This makes the dispatcher base-prompt promise ("a finished TeamMate is
delivered back to you as a new turn") real.
