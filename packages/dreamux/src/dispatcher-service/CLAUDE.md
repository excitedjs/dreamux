# dispatcher-service/

The Dispatcher Service: the real entity (issue #135) that the server launches per
dispatcher. It holds the dispatcher agent and orchestrates teammates. `server.ts`
is wiring only — all per-dispatcher orchestration lives here.

## What goes where

- **`service.ts`** — the facade that assembles the dispatcher-agent service and
  the teammate service.
- **`dispatcher/`** — `DispatcherAgentService`: owns live dispatcher slots,
  start / resume / stop, restart-notice injection, the Feishu channel session,
  and the **role-based MCP descriptor builder**. The dispatcher agent's lifecycle
  is tied to the server (started at boot, resumed on restart). Also holds the
  dispatcher base prompt.
- **`teammate/`** — `TeamMateAgentService` + identity-store + runtime-state +
  types + the teammate MCP descriptor. Agent-centric teammates: **no `task`** —
  a teammate is a named, resumable agent.

## Invariants (why it's shaped this way)

- **Drive every runtime through the neutral AgentRuntime interface.** The service
  resolves a provider from the registry-backed catalog and calls the same
  contract for codex/claude/external; it knows no runtime specifics.
- **Same creation path for dispatcher and teammate agents.** Both go through
  `AgentRuntimeProviderCatalog.resolve(ref).createRuntime(...)`. No parallel
  worker/runtime tree.
- **cwd is supplied by the launcher.** The dispatcher agent's cwd is computed
  here (`config.cwd ?? defaultDispatcherCwd(id)`); a teammate's cwd is its
  resolved target (`identity.cwd`). Passed as the required `cwd` create-context
  field — never derived inside the runtime.
- **Nested dispatch is prevented by MCP injection, not a runtime check.** A
  teammate/team-leader agent is simply not injected the "spawn teammate" tool;
  role differentiation is done by the MCP tool set + system prompt this service
  injects at launch.
- **Teammate identity + history are server-owned and forward-only.** History is
  an append-only JSONL index that stitches the resume chain; a history write
  must never fail a lifecycle verb.
