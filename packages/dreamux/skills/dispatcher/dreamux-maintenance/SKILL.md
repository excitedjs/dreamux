---
name: dreamux-maintenance
description: "Dreamux host operation notes. Load when diagnosing or operating dreamux serve, daemon startup, doctor/status results, Dispatcher health, missing replies, stuck turns, restart behavior, current config/state/run/log paths, bundled-skill injection, Feishu access policy, runtime app-server readiness, a Dreamux upgrade, or post-restart recovery."
---

# Dreamux Maintenance

## Scope And Authorization

- Use Dreamux-owned surfaces first: `dreamux doctor`, `dreamux status`,
  Dispatcher status, admin socket behavior, and logs under `~/.dreamux/logs/`.
- Separate submit, execution, completion delivery, and visible Channel delivery.
  A submitted turn or inbound message does not prove that a final reply reached
  the operator.
- Before changing config, state, a service unit, PATH, environment, runtime
  auth, or the installed package, require explicit operator intent naming the
  target Dispatcher and exact operation. Load the routed owner before planning
  a file or field change.
- Run the self-upgrade procedure only for explicit upgrade intent. Its
  self-resuming branch has additional preconditions and private recovery
  ownership; ordinary restart permission is not upgrade permission.

## Secret Safety

- Never print or relay an unredacted config, `app_secret`, `extra_env`, token,
  captured service environment, private recovery path, or complete provider
  config to a broad Channel.
- Report sanitized field names and outcomes. Keep private paths, ids,
  credentials, environment values, and incident details on an operator-private
  surface.
- Never guess a Dispatcher id, config path, state path, provider schema, or
  managed-service identity.

## Common Diagnostic Sequence

1. Confirm the target Dispatcher, the operator's requested outcome, and the
   available reply surface.
2. Identify the failing boundary: Channel ingress, Dispatcher acceptance,
   runtime execution, TeamMate completion delivery, visible Channel egress, or
   host/service lifecycle.
3. Read the single routed reference whose `Read when` condition matches. Load
   more than one only when the task genuinely crosses those owners.
4. Inspect Dreamux-owned status, doctor output, admin behavior, and narrowly
   relevant logs without exposing secrets. Treat logs as diagnostics, not
   durable state.
5. Before mutation, restate the exact authority, owner, recovery path, and
   verification step. Stop when any required identity or private recovery
   condition is unproven.

## Task Routing

| Task | Read when | Reference |
|---|---|---|
| Service lifecycle, Team dissolve, and reply diagnosis | Diagnosing `dreamux serve`, daemon startup, doctor/status results, Dispatcher health, missing replies, stuck turns, restart behavior, active or cleanup-pending Team dissolve, current state/run/log paths, bundled-skill injection, or runtime app-server readiness. | [Service lifecycle](references/service-lifecycle.md) |
| Managed Dreamux self-upgrade | The operator explicitly requests a Dreamux upgrade, or an injected restart notice requires post-restart recovery and verification. | [Self-upgrade](references/self-upgrade.md) |
| Host config envelope | Inspecting or safely editing the current `config.json` envelope, path authority, Dispatcher/agent/channel wiring, or an opaque external provider config. | [Config envelope](references/config-envelope.md) |
| Built-in Codex config | Inspecting or changing the current `builtin:codex` Agent Runtime provider config. | [Built-in Codex](references/builtin-codex.md) |
| Built-in Claude Code config | Inspecting or changing the current `builtin:claude-code` Agent Runtime provider config. | [Built-in Claude Code](references/builtin-claude-code.md) |
| Built-in Feishu credentials | Inspecting or changing the current `builtin:feishu` Channel credential config. | [Built-in Feishu](references/builtin-feishu.md) |
| Feishu access V3 | Diagnosing Feishu access policy or safely editing current V3 `access.json`, including trusted chats and `/introduce`. | [Feishu access V3](references/feishu-access-v3.md) |

## Reporting

- Report the exact interface, target Dispatcher/service, sanitized error,
  verified state, changes made, and whether retrying is safe.
- Use the provider reply tool when visible Channel delivery is required.
  Assistant text alone is not Channel delivery.
- Preserve logs unless the operator explicitly requests bounded cleanup.
- For an upgrade, follow the outcome-specific original-Channel and recovery
  reporting contract in the self-upgrade reference.
