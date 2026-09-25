# Current `builtin:codex` Config

Accepted `agents[].config` fields, defaults, and meanings:

- `bin`: non-empty string, default `"codex"`; `CODEX_HOST_CODEX_BIN` is the
  higher-priority host binary override.
- `sandbox_mode`: `read-only | workspace-write | danger-full-access`, default
  `workspace-write`; configures the Codex launch.
- `extra_args`: string array, default `[]`; passed to the child process.
- `extra_env`: string-to-string map, default `{}`; merged into the child
  environment.
- `initialize_timeout_ms`: positive integer milliseconds, default `10000`;
  bounds the runtime initialize handshake.

Codex approval policy is not configurable: the launch always passes
`approval_policy=never` (issue #2 trust model — the dreamux MVP only ships
with a fail-fast approval handler). An `approval_policy` or `turn_timeout_ms`
key in an existing `config.json` is still accepted and silently ignored, so a
file written before this change does not need editing.
