# Current `builtin:claude-code` Config

Accepted `agents[].config` fields, defaults, and meanings:

- `bin`: non-empty string, default `"claude"`.
- `model`: non-empty string or null, default `null`; null defers to Claude Code,
  otherwise maps to `--model` ahead of `extra_args`.
- `effort`: non-empty string or null, default `null`; null defers to Claude
  Code, otherwise maps to `--effort` ahead of `extra_args`.
- `remote_control`: boolean, default `false`; enables Claude Code's external
  resident-session control surface.
- `extra_args`: string array, default `[]`; passed to the child process after
  generated arguments.
- `extra_env`: string-to-string map, default `{}`; merged into the child
  environment.

Claude Code launches with `--dangerously-skip-permissions` and rejects
unexpected `can_use_tool` callbacks fail-fast. Sandbox behavior follows native
Claude Code configuration or explicit `extra_args`.
