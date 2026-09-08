# Requirement

## Initial request and user story

An operator reading a Codex command on a Feishu COT card wants to see the
command's script, not the runtime's shell launcher. The reported row starts
with `/usr/bin/zsh -lc` rather than the useful command.

Operator wording, 2026-09-09: "抄一下他的解析逻辑。" (Port Codex's parsing
logic.) The operator subsequently selected a new dedicated task.

## Current alignment

- Status: The operator explicitly approved this requirement and the final
  solution for development on 2026-09-09.
- Verified upstream baseline: `openai/codex` commit
  `49db349ffdd888f5e3c91abf9b7519d8631e6e9a` (2026-08-16), the source checkout
  supplied for this investigation. This is a pinned source baseline, not a
  claim about the latest release.
- Codex serializes argv into `CommandExecution.command` with `shlex_join` in
  `codex-rs/app-server-protocol/src/protocol/item_builders.rs:56`.
- Its TUI decodes that string with `split_command_string` and unwraps a
  recognized shell with `strip_bash_lc_and_escape` in
  `codex-rs/tui/src/exec_command.rs:12-32`. The latter delegates to
  `extract_shell_command`, which recognizes Bash-compatible and PowerShell
  invocations. The existing test at `exec_command.rs:76-79` explicitly covers
  `/usr/bin/zsh -lc`.
- At the investigation baseline (`305e3fc8`), Dreamux used the raw command for
  the run summary and invocation in
  `/packages/agent-runtime/codex/src/tool-display.ts:49-63`. Core only redacted
  these display values; Feishu composed its title and code segment from them.
  The wrapper was not introduced by Feishu.
- Display ownership follows commit `0c86deab` (#376): provider-specific labels
  belong to the runtime provider, not the Channel.

## Desired behavior and boundary

- Recognized shell wrappers display their inner script. Ordinary run titles
  use the script's first line; expanded invocation content uses its full text.
- Preserve inner quotes, escapes, operators, Unicode, and line breaks. Parsing
  is display-only: never execute, expand, or recursively interpret the script.
- Retain existing `commandActions` classification and read/list/search labels
  and items. Do not replace the full script with parsed action fragments.
- Unrecognized wrappers and undecodable command strings keep their original
  display text. Ordinary commands are not reformatted merely to match TUI
  quoting preferences.
- Raw tool arguments, execution, output, approval behavior, activity contracts,
  redaction, and Feishu layout remain unchanged. Other runtimes are unaffected.
- The affected product catalog entry is **A tool row says what the call was,
  not how the runtime spelled it** under [Observing agents](../../../product/README.md#observing-agents).
  This repairs the Codex label/invocation gap; it removes no tool row or
  execution capability.

## Acceptance criteria

1. `/usr/bin/zsh -lc 'node --check script.mjs'` produces summary and invocation
   `node --check script.mjs`, without the wrapper or its outer quotes.
2. Bash, Zsh, and Sh wrappers follow the upstream three-argument `-lc`/`-c`
   rule, including executable paths. PowerShell follows the upstream
   `-Command`/`-c` extraction and supported preceding flags.
3. Quoted shell scripts with embedded quotes, backslashes, operators, and
   multiple lines survive decoding; summary selection happens after decoding.
4. Unknown shells, unsupported flags, extra Bash positional arguments,
   malformed quoting, and Windows command text rejected by the upstream
   round-trip check are not partially stripped or rewritten.
5. Read/list/search action labels and items remain unchanged, but their
   invocation uses the same unwrapped script when it is displayed.
6. Started and completed tool activity retain the original raw arguments and
   carry matching decoded display facts. Existing output/error handling stays
   unchanged.
7. Build, lint, test, and test typechecking pass; an independent read-only
   implementation review is resolved. Report visual verification separately
   from automated projection checks, without claiming an unperformed live test.

## Decisions and unknowns

- Confirmed: port the upstream parsing logic; create a dedicated task.
- Approved implementation detail: cover the complete upstream wrapper
  extractor, including PowerShell, without importing its unrelated command
  classification or TUI layout machinery.
- Development approval: "批准，开始开发 (Recommended)" on 2026-09-09, in direct
  response to the recorded requirement and final solution. No commit, push,
  release, service restart, or merge is authorized by this approval.
