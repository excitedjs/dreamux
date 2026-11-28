# Current `builtin:codex` Config

Accepted `agents[].config` fields, defaults, and meanings:

- `bin`: non-empty string, default `"codex"`; `CODEX_HOST_CODEX_BIN` is the
  higher-priority host binary override.
- `model`: non-empty string or null, default `null`; null defers to Codex's own
  configuration, otherwise maps to `-c model=<toml-string>` ahead of
  `extra_args`.
- `effort`: non-empty string or null, default `null`; null defers to Codex's own
  configuration, otherwise maps to `-c model_reasoning_effort=<toml-string>`
  ahead of `extra_args`.
- `extra_args`: string array, default `[]`; passed to the child process after
  generated arguments.
- `extra_env`: string-to-string map, default `{}`; merged into the child
  environment.

Codex approval policy is not configurable: the launch always passes
`-c approval_policy=never` and rejects unexpected approval callbacks fail-fast.
Sandbox policy is not passed by Dreamux and follows native Codex configuration
or explicit `extra_args`.
