# Verification

On 2026-10-27:

- `node common/scripts/install-run-rush.js build`: passed.
- `node common/scripts/install-run-rush.js lint`: passed.
- `node common/scripts/install-run-rush.js test`: passed with the suite's
  opt-in live-model cases excluded; no live-model language-compliance claim.
- `node common/scripts/install-run-rush.js typecheck:tests`: passed.
- `git diff --check`: passed.
- `.agents/scripts/check.sh`: passed.
- `node common/scripts/install-run-rush.js change --verify --target-branch
  origin/next --no-fetch`: passed after committing the generated change file.
  Verification before the commit did not discover the uncommitted note.
- Built MCP catalog inspection showed the English sentence in all seven
  caller/tool projections: Dispatcher and TeamLeader TeamMate spawn/send,
  ordinary-member TeamMate send, and Dispatcher Team create/send.
- Independent architect review found no implementation issues and confirmed
  complete caller coverage and unchanged validation/execution semantics.

The first concurrent lint/test launches were refused by Rush's repository lock.
They were rerun sequentially after test typechecking completed. No lock files,
tests, or implementation behavior were changed to resolve that scheduling error.

The sentence is model guidance, not runtime language enforcement. This change
does not establish that a model will always follow the instruction.
