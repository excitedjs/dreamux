# Providerized config and state compatibility

- **Status:** Accepted, refined by
  [provider-architecture-realignment](provider-architecture-realignment.md);
  the inline `dispatchers[].runtime` envelope is superseded by named top-level
  `agents[]` in [agents-config-normalization](agents-config-normalization.md)
- **Date:** 2026-06-06
- **Affects:** `~/.dreamux/config.json`, dispatcher state files, provider config,
  TeamMate ledger, compatibility errors
- **PR / Issue:** [issue #110](https://github.com/excitedjs/dreamux/issues/110),
  following [issue #98](https://github.com/excitedjs/dreamux/issues/98)

## Context

The current config shape is Feishu and Codex specific. It has dispatcher-local
Feishu credentials and dispatcher-local Codex settings. Issue #110 replaces
those special cases with providerized channels and runtime declarations.

Issue #98 settled the 0.x compatibility stance: Dreamux does not silently infer
or rewrite incompatible config/state. Sensitive state fails loudly; rebuildable
server state may warn and rebuild/drop only when that loss is explicit and safe.

## Decision

Introduce a providerized config v2 shape. The durable envelope is:

```json
{
  "dispatchers": [
    {
      "id": "dispatcher-a",
      "cwd": "/path/to/workspace",
      "enabled": true,
      "channels": [
        {
          "id": "primary",
          "provider": "builtin:feishu",
          "config": {}
        }
      ],
      "runtime": {
        "provider": "builtin:codex",
        "config": {}
      }
    }
  ]
}
```

Common fields are owned by Dreamux core. Agent-runtime provider `config`
objects are owned and validated by provider descriptors. The Feishu
`channels[]` entry keeps the `builtin:feishu` ref string for config stability,
but it is validated as a built-in bidirectional channel, not through the
provider registry.

Confirmed Phase 1 loading rules after issue #135:

- `builtin:codex` and `builtin:claude-code` are known builtin Agent Runtime
  provider refs.
- `builtin:feishu` is a known built-in channel ref, not a provider-registry
  implementation.
- Npm package and package export refs are reserved schema/manifest syntax.
- Npm runtime refs are not loaded, imported, installed, or executed in Phase 1.
- Subscription channel plugin refs are interface-only reservations in this
  phase.
- A config value only becomes runnable after the matching provider runtime is
  wired. Until then, validation must fail loudly for a known but non-wired
  builtin instead of silently falling back to another provider.

Incompatible old config shapes must fail loudly with rebuild guidance. Dreamux
must not silently rewrite an operator's config into v2.

State compatibility follows issue #98:

- authorization or access-control state fails loudly when incompatible;
- rebuildable runtime state may warn and rebuild/drop;
- TeamMate ledger state is server-owned, versioned, and must not silently lose
  completed final outputs. The persisted identity record references its runtime
  by `agent_runtime` (an `agents[].id`), aligned with the named-agents schema; a
  legacy `provider_ref` identity (pre-#148) fails loud on the next lifecycle verb
  with rebuild guidance rather than silently defaulting a runtime;
- failed push delivery does not delete a result that can be retrieved later.

## Consequences

- `dispatchers[].feishu` and `dispatchers[].codex` stop being the target
  architecture, even if transitional implementation code reads them before the
  config v2 PR lands.
- Provider config validation needs two layers: core envelope validation and
  provider-local validation.
- Error messages must be explicit about rebuild/migration expectations.
- Config display, status, doctor, and logs must continue to redact provider
  secrets.

## Alternatives considered

- **Silently migrate the current config shape:** rejected by issue #98.
- **Keep Feishu/Codex config keys and add providers beside them:** rejected
  because it preserves the special-case architecture.
- **Allow npm provider execution as soon as refs parse:** rejected for Phase 1.
  External provider loading requires a separate package trust and dependency
  resolution decision.
