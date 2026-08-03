# Feishu trusted `allow_chats` V3 semantics and current config guidance

- **Status:** Draft implementation specification
- **Date:** 2026-07-31
- **Affects:** `@excitedjs/feishu-channel`, `@excitedjs/dreamux`, the existing
  V3 `access.json` semantics, and the Dispatcher-only `dreamux-maintenance`
  skill

## Intent

Remove the ordinary-message chat-plus-user double gate without adding an
access property or changing the persisted access shape. `group.allow_chats`
becomes the list of trusted groups whose human members may use the bot without
also appearing in `allow_users`.

The operator explicitly requires a restrained in-place semantic change:

- `access.json` remains `version: 3`;
- the V3 fields and loader remain unchanged;
- there is no V4 state, state rebuild, migration, or acknowledgement marker;
- release documentation calls out the changed authorization meaning so an
  operator can review existing `allow_chats` entries before deploying.

The same change expands `dreamux-maintenance` with accurate current
configuration guidance for the complete Dreamux host envelope, built-in
providers, and current V3 Feishu access state. The skill describes only the
current accepted formats, meanings, ownership, and safe same-version editing
workflow. It contains no upgrade, migration, historical-shape, or rebuild
logic.

## Inbound Classification Boundary

Trusted-chat authority applies only to an explicitly identified Feishu group
message from an explicitly identified human.

The Channel classifies the inbound event once, before passive bot observation,
`/introduce`, or the ordinary gate:

- `chat_type: 'p2p'` is P2P;
- `chat_type: 'group'` is group;
- a missing or any other chat type fails closed with
  `unsupported_chat_type` and is never coerced to group;
- `sender_type: 'user'` plus a non-empty `sender_id` is human;
- `sender_type: 'bot' | 'app'` plus a non-empty `sender_id` is bot;
- every other sender combination fails closed with `sender_unknown` before
  trusted-chat, allow-user, pairing, passive bot observation, or `/introduce`
  trust mutation.

This is a Channel-session hardening, not a public gate ABI redesign. The public
`dreamuxFeishuGate` input keeps its current `chat_type` and
`is_bot_sender` fields. The session projects into that API only after exact
classification; `is_bot_sender: false` means the caller has already identified
an exact `sender_type: 'user'` with a non-empty id. Existing package-root input
shape and persisted state types do not change, but this precondition becomes a
documented public caller contract: `isBotSenderType(...) === false` alone is
not proof of a human, so an unknown sender must not be passed to the gate as
false.

The Feishu channel README and `major` change note explain that requirement. A
package-root consumer/type test locks the retained `is_bot_sender` field and
proves no `sender_kind` input was introduced; session regression tests own the
unknown-sender fail-closed behavior.

## Group Policy Semantics

After exact group/human classification, human group messages are evaluated in
this order:

1. When `group.require_mention` is true and the bot is not mentioned, drop with
   `group_bot_not_mentioned`.
2. `group.policy: block` drops every human group message.
3. Resolve `chat_trusted = group.allow_chats.includes(chat_id)` once.
4. `group.policy: allowlist`:
   - an untrusted chat drops with `group_not_on_allowlist`;
   - a trusted chat delivers immediately without consulting `dm_policy` or
     `allow_users`.
5. `group.policy: follow-user`:
   - a trusted chat delivers immediately without consulting `dm_policy` or
     `allow_users`;
   - an untrusted chat follows the existing sender path: `disabled` drops,
     `all` delivers, `allowlist` checks `allow_users`, and `pairing` delivers a
     followed user or starts/resends pairing for an explicitly human mentioned
     sender not yet in `allow_users`.

The `follow-user` model is therefore:

```text
trusted chat OR sender accepted by the existing dm_policy path
```

`dm_policy: disabled` disables P2P and the untrusted-chat sender path; it does
not disable a trusted chat. `group.policy: block` is the human group-ingress
kill switch; the earlier trusted-bot branch remains independent.

`group.require_mention` remains the only mention control. Its default `true`
still requires @bot in a trusted chat. If an operator explicitly sets it to
`false`, trusted chats may deliver non-mentioned human messages; no hidden
second mention gate is added. This is the operator's later explicit resolution
of the earlier shorthand "selected groups only when @bot": the selected groups
follow the same global `require_mention` switch as every other human group
path, rather than inventing a trusted-chat-only mention rule.

## Unchanged And Intentional Boundaries

P2P behavior for explicitly classified human and bot senders is unchanged.
Bot senders retain the existing known/trusted-bot branches and trusted-bot
mention requirement.

Passive known-bot observation remains coupled to `group.allow_chats`: an
explicit bot with a non-empty id is observed as known only in a listed group.
Known-bot observation remains distinct from trusted-bot authorization.

`/introduce` remains a sender-scoped trust mutation:

- `block` denies it;
- `allowlist` requires both a listed chat and a sender in `allow_users`;
- `follow-user` requires the sender in `allow_users` but does not require a
  listed chat;
- unknown chat/sender classifications are rejected before `/introduce` can
  write trust.

This intentionally differs from ordinary delivery. A human outside
`allow_users` may speak in a trusted chat but may not mutate peer-bot trust.
Source comments and load-bearing parity tests must encode this deliberate
split instead of claiming exact parity.

Pairing cards, Channel/Team routing, target binding, and provider-neutral core
seams remain unchanged.

## V3 In-Place Compatibility Contract

The current file shape remains:

```json
{
  "version": 3,
  "dm_policy": "pairing",
  "group": {
    "policy": "follow-user",
    "allow_chats": [],
    "require_mention": true
  },
  "allow_users": [],
  "pending": {},
  "observed_chats": [],
  "warnings": [],
  "last_gate": {
    "at": 0
  }
}
```

No field, version constant, reader, saver, validator, fixture version, or
public state type changes.

This is nevertheless an authorization semantic change for both non-block
group policies:

- under previous `follow-user`, `allow_chats` was ignored for ordinary human
  delivery while the same list could still enable passive known-bot
  observation; a retained entry now also trusts all explicit human members;
- under previous `allowlist`, a listed chat passed only the outer chat shell and
  then still faced `dm_policy`/`allow_users`/pairing; a retained entry now
  delivers every explicit human directly.

The published README, Feishu access domain, and Rush change notes must state:

- `access.json` remains V3 and needs no rebuild;
- before deploying, review every non-empty `allow_chats` entry under both
  `group.policy: follow-user` and `group.policy: allowlist`;
- keep only groups whose human membership should be trusted and whose passive
  known-bot observation should remain enabled;
- the new meaning takes effect in place when the new server starts.

The operator accepts this documented in-place semantic transition in exchange
for avoiding a state-version bump or new marker.

## Current Ownership Of `access.json`

The current path is fixed at
`~/.dreamux/state/<dispatcher-id>/access.json`. `DREAMUX_CONFIG_DIR` relocates
`config.json` only; the skill must not derive a state path from the result of
`dreamux config path` or from a relocated config directory.

The skill and public/architecture documentation describe four current
ownership classes:

- `version` is Channel/schema-owned;
- `dm_policy` plus `group.policy`, `group.allow_chats`, and
  `group.require_mention` are operator policy;
- `allow_users` is shared authority: live Channel pairing/Owner approval may
  append it, while an independent quiesced operator may also maintain it;
- `pending`, `observed_chats`, `warnings`, and `last_gate` are Channel-owned
  runtime ledger fields.

External/manual access-file edits require the target Channel owner to be fully
quiesced for the entire read-modify-write window. A target Dispatcher only
prepares and reports the requested policy/shared-authority patch. An
independent operator performs:

```text
dispatcher stop -> confirmed stop -> post-stop re-read -> exact atomic patch
-> current-shape validation -> dispatcher start
```

The patch preserves `version` and all Channel-owned ledger fields exactly. It
uses an owner-only sibling temporary file and final mode `0600`. The stopped
Dispatcher cannot continue and apply its own patch. This is current-version
maintenance, not upgrade logic, and no live CAS/lock/admin API is added.

A missing file after confirmed stop is a valid current state, not a rebuild
case. Use the complete current V3 secure default shown above as the in-memory
baseline, apply only the requested policy/shared-authority fields, create a
missing state directory at mode `0700` when needed, and atomically create the
first `access.json` through a sibling mode-`0600` temporary file. Never require
an existing ledger in order to initialize current-version policy.

## Dispatcher Maintenance Skill Contract

Expand
`packages/dreamux/skills/dispatcher/dreamux-maintenance/SKILL.md` with a clearly
labeled built-in configuration section. It remains Dispatcher-only and gains
no tool or schema surface.

### Repository synchronization rule

Root `AGENTS.md` gains an always-binding rule: every change to the shape,
validation, default, ownership, or meaning of any Dreamux config or persisted
state file must update `dreamux-maintenance` in the same change. For fully
server-owned state the skill names the owner and prohibits direct editing. For
mixed state it states the field boundary exactly.

The existing changelog guardrail is narrowed without weakening shape safety:
incompatible shape, version, or path changes still require fail-loud plus a
manual rebuild. A same-shape semantic change may retain its state version only
when the operator explicitly approves that tradeoff and the release note uses
`BREAKING:` plus an immediate `Review:` warning and explicitly says no rebuild.
This V3 `allow_chats` reinterpretation is that approved exception.

The rule also states that `dreamux-maintenance` is current-state-only. It may
name the one currently valid schema/version but must not contain upgrade
detection, historical versions, migrations, `Rebuild:` recipes, or instructions
to delete/recreate config/state for an upgrade. Those belong to changelogs,
public docs, loader errors, and decision trails.

The existing skill's `dreamux changelog`/upgrade-rebuild coaching and generic
deletion/rebuild tutorial are removed. Model-facing tests replace the current
positive `dreamux changelog` assertion with focused current-only negative
assertions.

### Current `config.json` format

The skill uses `dreamux config path` as the path authority because
`DREAMUX_CONFIG_DIR` may relocate the normal `~/.dreamux/config.json` path. It
describes the complete current envelope:

- `agents` and `dispatchers` are independently optional and normalize to empty
  collections when omitted;
- `agents[]`: unique non-empty `id`, `provider`, and optional provider-owned
  `config`;
- `dispatchers[]`: unique path-safe `id`, schema-optional/null `cwd`, optional
  `enabled` (default true), optional `workspace.enabled` (default true),
  required non-empty `channels[]`, and required `agentRuntime` reference to an
  `agents[].id`;
- every enabled Dispatcher must have an explicit non-empty usable `cwd` before
  server startup even though the JSON reader permits it to be absent/null;
- `channels[]`: unique-per-Dispatcher `id`, `provider`, optional provider
  `config`, and optional `collaborationSpace.defaultBinding`; one provider ref
  may appear only once per Dispatcher;
- `defaultBinding`: optional `enabled` (default false), optional/null `repo`,
  and optional/null `identity` (non-empty when a string); when `repo` exists,
  its `cwd` is required/non-empty and `baseRef` accepts omission, null, or any
  string, including empty/whitespace.

Only built-in provider blocks receive field-level guidance:

- `builtin:codex` `agents[].config`: `bin`, `approval_policy`
  (`never | auto | auto-approve | on-failure`), `sandbox_mode` (`read-only |
  workspace-write | danger-full-access`), `extra_args`, `extra_env`,
  `initialize_timeout_ms`, and `turn_timeout_ms`;
- `builtin:claude-code` `agents[].config`: `bin`, nullable `model`, nullable
  `permission_mode` (`default | acceptEdits | plan | bypassPermissions`),
  `remote_control`, `extra_args`, `extra_env`, and `turn_timeout_ms`;
- `builtin:feishu` `dispatchers[].channels[].config`: non-empty `app_id` and
  `app_secret` only.

The skill records the owner-defined types, defaults, and runtime meanings, not
only field names:

- Codex defaults: `bin: 'codex'`, `approval_policy: 'never'`,
  `sandbox_mode: 'workspace-write'`, empty `extra_args`/`extra_env`,
  `initialize_timeout_ms: 10000`, and `turn_timeout_ms: 600000`;
  `CODEX_HOST_CODEX_BIN` is the higher-priority host binary override;
  approval/sandbox configure the Codex launch and extra args/env are passed to
  the child process;
  initialize timeout is consumed as the runtime handshake bound;
  `turn_timeout_ms` is accepted/defaulted by the current config reader but is
  not passed into `CodexRuntime` and therefore currently has no runtime effect;
  the skill must say so rather than repeat the stale source comment that claims
  it bounds a TeamMate worker turn;
- Claude Code defaults: `bin: 'claude'`, `model: null`,
  `permission_mode: null`, `remote_control: false`, empty
  `extra_args`/`extra_env`, and `turn_timeout_ms: 600000`; null model/mode defer
  to Claude Code, model/mode map to their CLI options, `remote_control` enables
  Claude Code's external resident-session control surface, extra args/env are
  passed to the child process, and turn timeout is an inactivity window reset
  by stream activity rather than a total-duration cap;
- Feishu has no credential defaults: `app_id` and `app_secret` are required
  non-empty strings; the app id identifies the Channel config and the secret
  authenticates it.

Every numeric timeout is a positive integer in milliseconds, `extra_args` is a
string array, and `extra_env` is a string-to-string map. `npm:` provider configs
remain opaque and defer to their provider schema.

### Safe same-version editing

The skill requires explicit operator intent naming the target Dispatcher,
file, and field-level change. It never prints or relays an unredacted config,
`app_secret`, `extra_env`, token, or full provider config to a broad channel.
It does not recommend `dreamux config show` as a provider-config inspection
surface.

For `config.json`, use an exact structural transform that changes only the
requested fields without printing untouched values. Preserve unrelated
Dispatchers/channels/provider fields, use a sibling mode-`0600` temporary file
and atomic replacement, then run `dreamux doctor`. If an `agents[]` entry is
shared and the request targets only the current Dispatcher, clone the agent
entry under a new id and repoint only that Dispatcher's `agentRuntime`.

Config changes require restart. A managed service may use
`dreamux daemon restart --notify-resumed --dispatcher <current-id>`; foreground
`dreamux serve` requires an operator-coordinated restart. Renaming/disabling the
current Dispatcher, removing its channel, changing its `agentRuntime`, or
changing Feishu credentials may break the active recovery path and requires an
explicit consequence warning.

For `access.json`, use the quiesced independent handoff in the ownership
section. Validate JSON and the documented current V3 shape locally without
printing values; `dreamux doctor` is not claimed to validate access state in
this change.

## Acceptance

Focused tests must prove:

1. Trusted-chat truth table:
   - `block` always drops human group messages;
   - `allowlist` drops an unlisted chat and delivers any explicit human in a
     listed chat;
   - `follow-user` delivers any explicit human in a listed chat and preserves
     the existing `dm_policy`/allow-user/pairing behavior in an unlisted chat;
   - a trusted chat still delivers when `dm_policy` is `disabled`;
   - mention-required and mention-disabled ordering matches the operator's
     explicit single-global-switch contract; no trusted-chat-only mention gate
     is introduced.
2. P2P and bot/trusted-bot behavior are unchanged.
3. Raw/session tests prove only exact `group` + `user` + non-empty id can reach
   trusted-chat authority. Unknown chat type returns/logs
   `unsupported_chat_type`; unknown/empty sender returns/logs `sender_unknown`;
   neither can observe a bot, run `/introduce`, create pairing, or deliver.
4. Passive known-bot observation remains allow-chat-scoped and requires an
   explicit bot/app with a non-empty id.
5. A trusted-chat human outside `allow_users` can deliver ordinary messages but
   `/introduce` still returns `sender_not_followed` and writes no trust. Rewrite
   the load-bearing gate/introduce parity table to encode this intentional
   split, not to weaken it.
6. `ACCESS_STATE_VERSION`, current defaults, all positive fixtures, reader/saver
   behavior, and public state types remain V3. No V4 or migration/rebuild
   implementation is added.
7. Change-note/README/domain tests lock both old-to-new expansions and operator
   review of every non-empty `allow_chats` under `allowlist` or `follow-user`.
   Rush tests require Feishu `major`, Dreamux pre-1.0 `minor`, a leading
   `BREAKING:` and immediate `Review:` warning, and an explicit statement that
   V3 needs no rebuild and no `Rebuild:` instruction. The independently
   published `@excitedjs/agent-runtime-codex` project receives a Rush
   `type: "none"` declaration for its comment-only correction, with no package
   version or behavior change.
8. Skill tests lock the complete current host/built-in/access formats, four-way
   access ownership, fixed state path independent of `DREAMUX_CONFIG_DIR`,
   provider-owner field types/defaults/runtime meanings, secret-safe
   exact-patch workflow, shared-agent cloning, restart consequences, and
   independent quiesced access edit. They explicitly state that Codex
   `turn_timeout_ms` is parsed/defaulted but currently unused. Public README
   assertions lock the same field, `600000` default, and no-runtime-effect
   statement in its complete built-in Codex config list.
9. Skill tests reject upgrade/migration/history/rebuild/delete-recreate
   guidance and remove the old `dreamux changelog` positive assertion. Other
   provider-neutral skills keep their current Feishu-negative assertions; only
   `dreamux-maintenance` gains a clearly labeled built-in Feishu section.
10. Root/knowledge checks lock the repository rule that every config/state
    contract change updates the current-only maintenance skill, and the
    changelog rule distinguishes rebuild-required shape/version/path changes
    from explicitly approved same-shape `BREAKING:` + `Review:` semantic
    changes. The same carve-out is stated consistently in the repository
    release and state/config upgrade-policy domains.
11. A package-root consumer/type test locks the unchanged gate ABI:
    `is_bot_sender` remains required, no `sender_kind` exists, and public docs
    state that `false` requires prior exact-human classification rather than a
    negated bot helper alone.
12. Access edit tests cover both an existing V3 file and `ENOENT` after
    confirmed stop. The missing-file case starts from the full secure V3
    default, applies only requested fields, creates a missing directory at
    `0700`, and atomically creates a `0600` file without calling it a rebuild.

Run the Feishu channel and Dreamux package tests, `.agents/scripts/check.sh`,
and the repository Rush lint/build/test gates.

## Knowledge And Public Artifacts

The same change updates:

- [Feishu pairing access](../../domains/feishu-pairing-access.md) as the normative
  V3 schema/branch table and in-place semantic warning;
- [Feishu introduce](../../domains/feishu-introduce.md) for the intentional
  ordinary-delivery/trust-mutation split;
- Feishu channel source comments, package guardrail, and public README;
- a new accepted decision that refines/supersedes only the ordinary
  `allow_chats` delivery rows in the existing production-ready V3 pairing
  decision; its V3 schema, pairing, Channel boundary, and all unrelated
  contracts remain current rather than being reclassified as historical;
- active decision/reference trails in `decisions/README.md`,
  `reference/channel-runtime.md`, and
  `domains/channel-routing-and-binding.md`;
- access ownership language in `reference/current-architecture.md`,
  `reference/state-and-paths.md`, `domains/state-config-and-files.md`, and the
  published Dreamux README;
- the upgrade-policy sections in
  `domains/repository-operations-and-release.md` and
  `domains/state-config-and-files.md`, preserving fail-loud plus `Rebuild:` for
  incompatible shape/version/path changes while recording the explicitly
  approved same-shape `BREAKING:` + `Review:` no-rebuild exception;
- root `AGENTS.md`, relevant dispatcher-skill/model-facing writing references,
  `dreamux-maintenance`, and its model-facing tests;
- the stale `packages/agent-runtime/codex/src/config.ts` comments that claim
  `turn_timeout_ms` bounds TeamMate work, replacing them with the current truth
  that the reader accepts/defaults the field but `CodexRuntime` does not consume
  it; this is documentation cleanup only, not a runtime wiring change;
- the stale public Dreamux README access example, replacing V2 with the full
  current V3 template and new trusted-chat meaning, and its supposedly complete
  built-in Codex field list, adding `turn_timeout_ms: 600000` with the accurate
  parsed/defaulted-but-currently-unused meaning;
- the source comment in `packages/dreamux/src/cli/changelog.ts`, removing the
  instruction that a model following `dreamux-maintenance` handles upgrades;
- generated Rush change files: `major` for stable
  `@excitedjs/feishu-channel` and pre-1.0 breaking `minor` for
  `@excitedjs/dreamux`. Both notes start with `BREAKING:`, immediately include
  `Review:` for every existing non-empty `allow_chats` under `allowlist` or
  `follow-user`, explain the old-to-new authorization expansion, and explicitly
  say the V3 file needs no rebuild. Neither contains a `Rebuild:` instruction.
  A third Rush declaration uses `type: "none"` for
  `@excitedjs/agent-runtime-codex` because its source-comment correction is
  documentation-only and must not publish a version bump.

## Out Of Scope

- A V4 access state, state-version bump, loader/validator change, migration,
  rebuild, or acknowledgement marker.
- New access fields, a per-chat policy map, per-chat mention setting, or
  per-chat user allowlist.
- A public `dreamuxFeishuGate` ABI change.
- A new config editor, admin/CLI/MCP surface, live access CAS/lock, or provider
  diagnostic.
- Changes to `dreamux config show`, config redaction, host-envelope loading, or
  doctor validation ownership.
- Generic editing guidance for external provider config.
- Wiring, removing, or otherwise changing the runtime behavior of Codex
  `turn_timeout_ms`; this change only documents its current parsed-but-unused
  status accurately.
- Changes to P2P, trusted-bot authorization, pairing cards, Channel routing, or
  Team behavior.
