# agent-runtime/

The Agent Runtime seam: one runtime abstraction that serves **every** agent role
(dispatcher, teammate, and future team-leader/member). A "runtime" is a single
agent session; how it talks to its engine is the engine's business.

## What goes where

- **Top level** (`types.ts`, `turn.ts`, `catalog.ts`, `external-provider.ts`,
  `index.ts`) — the **neutral** contract + the catalog (a view over the provider
  registry) + the `npm:` external-provider loader. Nothing runtime-specific here.
- **`builtin/<name>/`** — one builtin's entire self-contained stack: transport
  (process supervisor + rpc + wire protocol/types + handshake), the runtime
  impl, the provider, CLI args, and its own `paths.ts`.

## Invariants (why it's shaped this way)

- **One contract, capability-declared differences.** Runtimes differ via
  `getCapabilities()` (resume checkpoint kind, steer, events, last/context,
  completion-delivery shape) — never via forked interfaces or `if (ref === …)`
  branches in callers. codex and claude are completely different mechanisms
  behind the same surface.
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

The runtime input surface is being unified into source/nature-named entries
(`channelInput` / `completionInput` / `systemInput`) with a generic
`CompletionEnvelope`; the completion delivery-kind names and the `codexThread`
default are being lifted out of the shared contract. Until that lands, the
current entries are `submitTurn` (channel + system) and
`deliverTeamMateCompletion`.
