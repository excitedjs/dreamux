# Final technical solution

## Scope and workflow

Implement the [requirement](/.agents/tasks/channel/align-codex-command-display/requirement.md)
through the minimal-change fast path: one existing display owner, a small pure
parsing change, no new dependency, public contract, state, process, security
boundary, or Channel mechanism. The TeamLeader implements after approval; one
separate read-only TeamMate reviews the whole change. No solution-review Issue
is needed. Reclassify if implementation requires a wider boundary.

## Upstream semantics

Follow `openai/codex` revision
`49db349ffdd888f5e3c91abf9b7519d8631e6e9a`:

- `codex-rs/tui/src/exec_command.rs:19-32`: decode the serialized command using
  POSIX shell-word quoting rules, with the same round-trip rule for Windows
  drive-path text. Reject malformed quoting instead of guessing.
- `codex-rs/shell-command/src/parse_command.rs:40-42`: try Bash-compatible
  extraction, then PowerShell extraction.
- `codex-rs/shell-command/src/bash.rs:103-115`: recognize exactly
  `[shell, flag, script]`, where the detected shell is Bash, Zsh, or Sh and the
  flag is exactly `-lc` or `-c`.
- `codex-rs/shell-command/src/shell_detect.rs:39-59`: detect known executable
  names through the host path/file-stem semantics, including executable
  suffixes. Do not invent a broader shell registry.
- `codex-rs/shell-command/src/powershell.rs:43-70`: recognize PowerShell and
  pwsh; accept case-insensitive `-NoLogo` and `-NoProfile` before
  `-Command`/`-c`, return the argument following that flag, and reject
  unsupported flags before it.
- `codex-rs/tui/src/exec_command.rs:12-17`: a recognized wrapper returns the
  decoded script as-is, not another escaped or evaluated command.

This ports wrapper extraction, not the entire TUI formatter: when no wrapper
is recognized, retain Dreamux's existing original string rather than adopting
Codex's argv reformatting. Do not strip inner wrappers or PowerShell script
preambles. The extractor is a presentation operation, never an approval or
execution-safety parser.

## Implementation

1. Add the small pure command-display decoder beside the existing Codex
   `commandDisplay` logic in `/packages/agent-runtime/codex/src/tool-display.ts`.
   Reproduce shell-word quoting and escaping needed to decode the upstream
   serialized argv without evaluating variables, substitutions, or commands.
   No subprocess, shell library dependency, exported API, or shared-core parser.
2. Decode the raw `command` once inside `commandDisplay`. Reuse the resulting
   script for both invocation and any first-line summary fallback. Keep
   `commandActions`, action labels, and items unchanged: parsed actions can be
   lossy and cannot reconstruct a whole pipeline or multiline script.
3. Leave `/packages/agent-runtime/codex/src/turn-manager.ts` raw-argument
   production unchanged. Leave Core projection, privacy handling, and Feishu
   rendering unchanged. The existing neutral fields already carry the answer.
4. Extend existing display and activity tests with upstream-shaped wrapped
   commands; verify the final presentation through existing projection tests
   or a focused test at that seam if the current fixture does not cover it.
   Do not rewrite existing assertions to hide a behavior regression.

## Verification

- Cover Zsh/Bash/Sh and PowerShell extraction, absolute executable paths,
  suffix handling, single/double quotes and adjacent quote fragments,
  escaped quotes/backslashes, multiline and Unicode scripts, and the upstream
  Python-with-nested-quotes snapshot example.
- Cover ordinary commands, unsupported wrappers/flags, Bash extra arguments,
  undecodable strings, and the upstream Windows non-round-trippable example.
- Check both display fields, unchanged structured action labels/items, and
  original arguments on started/completed activity.
- Run the repository build, lint, test, and `typecheck:tests` through
  `node common/scripts/install-run-rush.js`, plus `.agents/scripts/check.sh`
  and the task-record validator. Resolve independent review findings.
- Check the actual Feishu title and expanded code segment when a permitted
  local-built display probe is available; otherwise explicitly report that
  automated payload verification does not establish the live client result.
  Do not restart or replace the running Dreamux service to obtain that test.

## Knowledge and delivery

Keep this task and its parent index current. At closeout, document only the
narrow Codex display exception in the existing product/domain owners if needed
for accuracy; do not create another architecture guide. Follow Rush change-file
requirements for the changed package, without hand-editing generated changelogs.
Commit, push, release, restart, and merge require their own operator authority.
