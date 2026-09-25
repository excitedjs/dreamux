# Current Built-In Feishu Access V3

This reference owns the current V3 shape, field ownership, trusted-chat and
`/introduce` meanings, and quiesced edit/`ENOENT` workflow.

The path is fixed at `~/.dreamux/state/<dispatcher-id>/access.json`.
`DREAMUX_CONFIG_DIR` affects `config.json` only. Never derive this state path
from `dreamux config path` or a relocated config directory.

The Channel session holds this file in memory once its first gate decision
loads it, for the rest of the session — a hand edit made while the channel is
running is not read until the next restart, the same as the routing document
and `chat-bots.json`. This is exactly why the quiesced edit procedure below
requires a confirmed process exit before patching the file.

The complete secure default is:

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
  "pending": {}
}
```

Current field ownership has four classes:

- Channel/schema-owned: `version`.
- Operator policy: `dm_policy`, `group.policy`, `group.allow_chats`, and
  `group.require_mention`.
- Shared authority: `allow_users`; live pairing/App Owner approval may append
  it, while an independent quiesced operator may also maintain it.
- Channel runtime ledger: `pending`; do not edit it directly.

Current meanings and types:

- `version` is exactly `3`.
- `dm_policy` is `all | allowlist | pairing | disabled`.
- `group.policy` is `block | allowlist | follow-user`;
  `group.allow_chats` is a string array; `group.require_mention` is boolean.
- `allow_users` is a string array.
- `pending` is keyed by pairing token. Each entry has string `sender_id` and
  `chat_id`, numeric `created_at` (write-only — no code reads it back, kept
  for a human reading the file by hand) and `expires_at`, and optional string
  `prompt_message_id`.

For exactly classified human group messages, `group.require_mention` runs
first, and `group.policy: block` drops all human messages. A chat in
`group.allow_chats` is trusted under either `allowlist` or `follow-user`: after
the mention/block checks, its human members deliver without consulting
`dm_policy`, `allow_users`, or pairing. An unlisted `allowlist` chat drops. An
unlisted `follow-user` chat uses the existing `dm_policy` / `allow_users` /
pairing path. Passive known-bot observation remains scoped to
`group.allow_chats`. `/introduce` remains sender-scoped and requires exact
sender ID membership in `allow_users`; this check is not human-only, so a
manually listed bot/app sender ID may pass authorization.

## Safe Current Access Editing

A target Dispatcher only prepares and reports the requested policy or
shared-authority patch. It must not stop its own host process and then continue
to apply its own patch. Hand the operation to an independent operator for the
full ownership window:

```text
daemon stop -> confirmed process exit -> post-stop re-read -> exact atomic patch
-> current-shape validation -> daemon start
```

Keep the Channel owner fully quiesced for the entire read-modify-write window.
After the post-stop re-read, change only requested operator-policy or
`allow_users` fields. Preserve `version` and the `pending` ledger exactly. Use
an owner-only sibling temporary file, atomic replacement, and final mode
`0600`. Validate locally that the patched JSON still parses and every field is
present with the right type — an unrecognized field is tolerated and left as
found, but a missing or wrong-type field is rejected, same as the daemon's own
loader. Do not claim that `dreamux doctor` validates access state.

If the file is absent after confirmed process exit, treat that explicit `ENOENT` as
valid current state. Use the complete secure V3 default above as the in-memory
baseline and apply only requested policy/shared-authority fields. Create a
missing state directory at mode `0700`, then atomically create the first
`access.json` through a sibling mode-`0600` temporary file. Start the daemon only
after validation.
