# Verification

## Scope

The authorized change is only the workspace default from true to false.
Implementation uses the existing config loader and onboarding seed. Explicit
policy remains authoritative; workspace selection algorithms require no change.
TeamLeader pre-review confirmed exactly four runtime Boolean substitutions in
the two default owners. Other source edits correct comments describing isolation.

## Checks

- The implementation writer completed all four required Rush gates successfully:
  `build`, `lint`, `test`, and `typecheck:tests`. The full test run left
  `DREAMUX_SKIP_LIVE_CODEX` unset and included real Codex 0.153.4.
- The two focused test files passed 41 tests. Loader cases cover omitted/empty
  policy and explicit true/false; onboarding covers the new default and preservation
  of explicit true on re-onboarding. Explicit-isolation fixtures are unchanged.
- The omitted/empty loader cases distinguish the new default from the previous
  true default. Existing explicit values remain regression guards.
- Task-record, knowledge, and diff checks passed.
- Independent review and PR delivery are pending.

## Documentation ownership

The maintenance configuration reference owns the operational default description.
The state/config and dispatcher-workspace knowledge pages and product catalog
record the same default. No package boundary, new persisted shape, glossary term,
or root routing change is involved.
