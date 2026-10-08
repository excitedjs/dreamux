# Current `config.json` Envelope

This reference owns the current host envelope, config path authority, provider
opacity, and safe structural editing workflow.

Use `dreamux config path` as the config path authority.
`DREAMUX_ROOT` may relocate `config.json` (and every other Dreamux-owned
path). Do not use `dreamux config show` to inspect provider config; it is not
a field-targeted secret-safe view.

While `dreamux serve` runs, the Config Service holds `config.json` in memory
as the running process's single authority over it. A hand edit made to the
file after start is not read, and the next `config.agents.replace` commits the
held value to the whole file without re-reading it, so it discards the edit:
stop the daemon before hand-editing `config.json`. `agents[]` is additionally
readable and replaceable live through the `config.agents.get`/
`config.agents.replace` Commands (secrets returned as `''`, a whole-section
replace matched by `id`, a submitted `''` for a secret-named key keeping the
stored value) — a replace takes effect for the next runtime launch, not the
one already running. `dispatchers[]` has no Command and stays hand-edit-with-
the-daemon-stopped only.

The complete current host envelope has independently optional `plugins`,
`agents`, and `dispatchers` arrays. An omitted `agents` or `dispatchers` array
normalizes to an empty collection; an omitted `plugins` array means no opt-in
plugins.

`plugins[]` entries are either a plugin ref string or an object with:

- non-empty plugin ref `ref`: `builtin:<id>` (the built-in opt-in plugin is
  `bootstrap`) or `npm:<package>` with an optional `#<export>`;
- optional plugin-owned `config`, validated by that plugin. A `config` block
  for a plugin that takes no config (no `config.read`) is ignored. Every key at
  the host envelope's own levels — the top level, `plugins[]` entries
  (`ref`/`config`), `dispatchers[]`, `channels[]`, `agents[]`, and
  `dispatchers[].workspace` — tolerates an unrecognized key. Wrong types and
  missing required fields are still rejected at every level. This tolerance is
  about the envelope's own keys only; whether it also extends to a
  provider-owned `config` block (`agents[].config`, `channels[].config`) is
  that provider's own choice — use the provider's reference as the authority
  there, not this one. The `builtin:codex`, `builtin:claude-code`, and
  `builtin:feishu` config readers tolerate an unrecognized key in their own
  `config` block too, under the same R21 policy.

The built-in Feishu plugin is always loaded and must not be listed. A
malformed entry fails `dreamux serve` and shows as a failed `config` line in
`dreamux doctor`. An unknown built-in plugin, a plugin that fails to load, two
plugins with the same name, and two providers with the same name fail `dreamux
serve` and show as a failed `plugin <name>` line in `dreamux doctor`. A
provider a plugin contributes is addressed in `agents[].provider` or
`channels[].provider` as `builtin:<name>`.

`agents[]` entries contain:

- unique non-empty string `id`;
- non-empty provider ref `provider`;
- optional provider-owned object `config`.

`dispatchers[]` entries contain:

- unique path-safe non-empty string `id`;
- required non-empty string `cwd` on every entry, enabled or not: the
  Dispatcher's workspace directory; `~` expands to the home directory, and
  server startup creates a missing directory for an enabled Dispatcher;
- optional boolean `enabled`, default `true`;
- optional `workspace.enabled`, default `false`;
- required non-empty `channels[]`;
- required non-empty `agentRuntime` matching an `agents[].id`.

Each `channels[]` entry recognizes a unique-per-Dispatcher non-empty `id`, a
non-empty Channel provider ref, and optional provider-owned `config`; any
other key is tolerated but unread. One provider ref may appear only once in
one Dispatcher.
Automatic collaboration-space provisioning is Channel-owned policy, not host
config: the Channel that offers the flow owns it, so it is set through that
Channel's own surface rather than in this envelope.

The official `npm:@excitedjs/agent-runtime-codex`,
`npm:@excitedjs/agent-runtime-claude-code`, and `npm:@excitedjs/feishu-channel`
provider refs use the package-root default provider factories. The current
builtin catalog selects named plugin factories for Codex, Claude Code and
Feishu, and the default factory for `builtin:bootstrap`. Explicit official plugin refs still conflict
with the same-name always-loaded plugins; third-party plugin refs use default
or their explicit `#export`.

External `npm:` provider configs are opaque. Use the provider's schema as the
authority; do not infer fields from a built-in provider.

`dreamux onboard` reconstructs the known host wrapper fields when it writes
configuration. Unknown wrapper fields may be discarded even on untouched
entries; untouched provider-owned `config` contents retain their raw-config
round trip. Loading an unknown envelope key remains supported. Use the
structural-editing procedure below when unrelated fields must be preserved.

## Safe Current Config Editing

1. Confirm explicit operator intent for the target Dispatcher, config file, and
   exact fields. When the change is only to `agents[]` and the daemon is
   running, prefer `config.agents.get`/`config.agents.replace` over a hand
   edit: a hand edit made while the daemon runs is not read and is discarded by
   the next replace. Any other hand edit is made with the daemon stopped.
2. Resolve the file with `dreamux config path` without printing its contents.
3. Load the separate provider reference for each affected built-in provider
   or built-in plugin; for an external provider or plugin, including a
   `plugins[].config` block, use that package's own schema.
4. Apply an exact structural transform that changes only the requested fields.
   Preserve unrelated Dispatchers, channels, agents, and provider fields. Write
   a complete sibling temporary file at mode `0600`, then atomically replace
   the target without echoing untouched values.
5. When an `agents[]` entry is shared and the request applies only to the
   current Dispatcher, clone it under a new unique id and repoint only that
   Dispatcher's `agentRuntime`.
6. Run `dreamux doctor`, report sanitized validation results, and load the
   service-lifecycle route before restarting for the config change to take
   effect.
