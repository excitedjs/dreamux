# Feishu trusted allow-chats semantics

- **Status:** Accepted
- **Date:** 2026-07-31
- **Affects:** `@excitedjs/feishu-channel`, V3 `access.json`,
  `@excitedjs/dreamux` public/current maintenance guidance
- **Specification:**
  [Feishu allow-chats trust semantics](../archive/proposals/feishu-allow-chats-trust-semantics.md)

## Context

The production V3 pairing decision kept `group.allow_chats` as a flat manual
list, but ordinary human delivery interpreted it inconsistently. `allowlist`
used it only as an outer shell before applying `dm_policy` and `allow_users`;
`follow-user` ignored it for human delivery even though the same list enabled
passive known-bot observation. Operators wanted listed groups to be the actual
human trust unit without adding another access field or state version.

The public gate already accepts normalized `chat_type` and `is_bot_sender`.
Unknown Feishu sender types could previously be projected as
`is_bot_sender: false`, so changing chat trust also required an exact raw-event
classification boundary without changing that public input.

## Decision

Keep `access.json` at version 3 with its current fields, defaults, loader,
saver, and public state types. Refine only ordinary human group delivery:

- Classify inbound once in the Feishu Channel session. Only `p2p | group` chat
  types proceed. Only `sender_type: user` with a non-empty id is human, and only
  `sender_type: bot | app` with a non-empty id is bot. Other chat types fail as
  `unsupported_chat_type`; other sender shapes fail as `sender_unknown` before
  observation, `/introduce`, pairing, or delivery.
- Keep the public `dreamuxFeishuGate` input unchanged. Its
  `is_bot_sender: false` value is a caller assertion that exact-human
  classification already succeeded, not the negation of a bot helper.
- For human group traffic, apply `group.require_mention` first and
  `group.policy: block` second.
- Because the unchanged V3 reader validates `group.policy` only as a string,
  fail closed as `internal` for any value other than `allowlist` or
  `follow-user` before consulting `allow_chats`.
- For either recognized non-block policy, resolve
  `group.allow_chats.includes(chat_id)` once after those gates.
- Under `allowlist`, drop an unlisted chat and deliver any exact human in a
  listed chat without consulting `dm_policy`, `allow_users`, or pairing.
- Under `follow-user`, deliver any exact human in a listed chat without those
  sender checks; an unlisted chat follows the existing `dm_policy`,
  `allow_users`, and dm-kind pairing path.

The resulting model is:

```text
trusted chat OR sender accepted by the existing dm_policy path
```

Bot/P2P behavior remains unchanged. Passive known-bot observation still needs
an exact bot/app id and a listed group. `/introduce` deliberately stays
sender-scoped: `block` denies; `allowlist` requires listed chat plus
`allow_users`; `follow-user` requires `allow_users` without requiring a listed
chat. Ordinary trusted-chat delivery never grants peer-trust mutation.

## In-Place Compatibility Decision

This is an explicitly approved same-shape authorization change. A V3 file needs
no rebuild, migration, marker, or acknowledgement field. When the new server
starts, every retained non-empty `allow_chats` entry under `allowlist` or
`follow-user` trusts all exact human members in place. Release/public guidance
must tell operators to review those entries before deployment and keep only
groups whose human membership and passive known-bot observation should remain
trusted.

The repository release rule continues to require fail-loud plus `Rebuild:` for
incompatible shape, version, or path changes. An explicitly approved same-shape
semantic exception instead requires a `BREAKING:` note followed immediately by
`Review:`, an explicit no-rebuild statement, and no `Rebuild:` instruction.

## Maintenance Consequences

`access.json` is mixed ownership at the fixed path
`~/.dreamux/state/<dispatcher-id>/access.json`; `DREAMUX_CONFIG_DIR` relocates
only `config.json`. `version` is Channel/schema-owned, policy fields are
operator-owned, `allow_users` is shared authority, and the remaining ledger
fields are Channel-owned.

Manual access editing uses an independent quiesced handoff: stop and confirm the
owner, re-read after stop, apply an exact atomic owner-only patch while
preserving schema/ledger fields, validate current V3, and start. A missing file
after stop begins from the full secure current default and is initialized
atomically; it is not an upgrade action.

Every config/state contract change updates the Dispatcher-only
`dreamux-maintenance` skill's single owning reference and its root route when
needed. The [maintenance progressive-disclosure design](../archive/proposals/dreamux-maintenance-progressive-disclosure.md)
keeps the root and Feishu access owner current-state-only. Its separate generic
self-upgrade SOP may read this release's concrete transition from the validated
staged changelog and target owner references; it does not duplicate this
decision's schema or release instructions.

## Consequences And Guards

- Gate truth-table tests cover both non-block policies, every `dm_policy`, the
  global mention switch, block, and the untrusted `follow-user` sender path.
- Raw session tests cover unknown classifications, bot observation,
  `/introduce`, pairing, and delivery side effects.
- The gate/introduce table locks the intentional trusted-chat divergence.
- State/version and package-root consumer tests lock V3 and the unchanged gate
  input ABI.
- Public docs, model-facing skill tests, KB checks, and Rush change-file tests
  lock the in-place warning and maintenance boundary.

## Alternatives Considered

- A new state version, access field, migration, marker, or rebuild was rejected
  by the approved compatibility tradeoff.
- A trusted-chat-only mention setting was rejected; the one global
  `group.require_mention` switch remains authoritative.
- Passing raw sender kinds through the public gate was rejected; exact
  classification belongs at the raw Channel session boundary.
- Wiring Codex `turn_timeout_ms` was rejected as unrelated behavior; only its
  stale comments and current guidance are corrected.
