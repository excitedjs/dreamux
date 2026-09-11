# Current `config.json` Envelope

This reference owns the current host envelope, config path authority, provider
opacity, and safe structural editing workflow.

Use `dreamux config path` as the config path authority.
`DREAMUX_CONFIG_DIR` may relocate `config.json`. Do not use `dreamux config
show` to inspect provider config; it is not a field-targeted secret-safe view.

The complete current host envelope has independently optional `agents` and
`dispatchers` arrays. An omitted array normalizes to an empty collection.

`agents[]` entries contain:

- unique non-empty string `id`;
- non-empty provider ref `provider`;
- optional provider-owned object `config`.

`dispatchers[]` entries contain:

- unique path-safe non-empty string `id`;
- schema-optional or null `cwd`; every enabled Dispatcher must nevertheless
  have an explicit non-empty usable `cwd` before server startup;
- optional boolean `enabled`, default `true`;
- optional `workspace.enabled`, default `true`;
- required non-empty `channels[]`;
- required non-empty `agentRuntime` matching an `agents[].id`.

Each `channels[]` entry contains a unique-per-Dispatcher non-empty `id`, a
non-empty Channel provider ref, and optional provider-owned `config`, and
nothing else. One provider ref may appear only once in one Dispatcher.
Automatic collaboration-space provisioning is Channel-owned policy, not host
config: the Channel that offers the flow owns it, so it is set through that
Channel's own surface rather than in this envelope.

External `npm:` provider configs are opaque. Use the provider's schema as the
authority; do not infer fields from a built-in provider.

## Safe Current Config Editing

1. Confirm explicit operator intent for the target Dispatcher, config file, and
   exact fields.
2. Resolve the file with `dreamux config path` without printing its contents.
3. Load the separate provider reference for each affected built-in provider;
   for an external provider, use that provider's own schema.
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
