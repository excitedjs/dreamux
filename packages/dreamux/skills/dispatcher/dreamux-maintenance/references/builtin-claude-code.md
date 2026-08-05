# Current `builtin:claude-code` Config

Accepted `agents[].config` fields, defaults, and meanings:

- `bin`: non-empty string, default `"claude"`.
- `model`: string or null, default `null`; null defers to Claude Code, otherwise
  maps to its model option.
- `permission_mode`: `default | acceptEdits | plan | bypassPermissions` or
  null, default `null`; null defers to Claude Code, otherwise maps to its
  permission-mode option.
- `remote_control`: boolean, default `false`; enables Claude Code's external
  resident-session control surface.
- `extra_args`: string array, default `[]`; passed to the child process.
- `extra_env`: string-to-string map, default `{}`; merged into the child
  environment.
- `turn_timeout_ms`: positive integer milliseconds, default `600000`; an
  inactivity window reset by stream activity, not a total-duration cap.
