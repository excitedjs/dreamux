# @excitedjs/dreamux-utils

Pure shared utilities for the Dreamux host and its provider packages
(issue [#209](https://github.com/excitedjs/dreamux/issues/209)). These are the
byte-identical helpers that were previously vendored separately into the codex,
claude-code, and feishu-channel packages and the host core; consolidating them
removes the duplication while keeping the provider packages free of any
dependency on `@excitedjs/dreamux` core.

This package depends on `@excitedjs/dreamux-types` only — never on
`@excitedjs/dreamux`.

## Exports

- **config-validate** — neutral JSON-shape validation primitives that produce
  `dreamux config error in <file>: ...` messages (`isPlainObject`,
  `rejectUnknownKeys`, `requireNonEmptyString`, `requireStringArray`, …).
- **os** — platform/filesystem primitives (`isProcessAlive`, `killProcessGroup`,
  `ensureOwnerOnlyDir`, `removeEmptyLogFile`, `pathExists`). These are generic OS
  helpers, not Dreamux layout/path contracts.
- **completion-body** — bounded teammate-completion resolution: inline a short
  result, spill an over-budget result to an owner-only file under a
  host-supplied spill directory (`resolveCompletionBody`,
  `completionInlineBudget`, `teamMateCompletionOutputPath`,
  `COMPLETION_INLINE_BUDGET_DEFAULT`, `COMPLETION_INLINE_BUDGET_MAX`).
- **turn-render** — inbound-turn render helpers that wrap a neutral
  `InboundTurnInput` into the native `<channel source="…" …>` envelope
  (`renderChannelInput`, `renderChannelBlock`,
  `DEFAULT_MESSAGE_ID_DEDUPE_WINDOW`).
