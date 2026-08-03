# Current `builtin:codex` Config

Accepted `agents[].config` fields, defaults, and meanings:

- `bin`: non-empty string, default `"codex"`; `CODEX_HOST_CODEX_BIN` is the
  higher-priority host binary override.
- `approval_policy`: `never | auto | auto-approve | on-failure`, default
  `never`; configures the Codex launch.
- `sandbox_mode`: `read-only | workspace-write | danger-full-access`, default
  `workspace-write`; configures the Codex launch.
- `extra_args`: string array, default `[]`; passed to the child process.
- `extra_env`: string-to-string map, default `{}`; merged into the child
  environment.
- `initialize_timeout_ms`: positive integer milliseconds, default `10000`;
  bounds the runtime initialize handshake.
- `turn_timeout_ms`: positive integer milliseconds, default `600000`; the
  current reader accepts and defaults it, but it is not passed into
  `CodexRuntime` and currently has no runtime effect.
