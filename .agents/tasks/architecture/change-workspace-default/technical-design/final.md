# Default-value substitution

Change the three default values in `packages/dreamux/src/config/config.ts` and
the new-dispatcher workspace seed in `src/onboard/config-files.ts` from true to
false. Keep existing parsing, serialization, onboarding preservation, and workspace
selection owners. No new helper, state, mechanism, or refactor is needed.

Use the real configuration loader to cover omitted/empty workspace policy and
explicit true/false. Cover the onboarding default and preservation of existing
policy in its current test suite. Keep explicit-isolation fixtures unchanged.
Update only statements that describe this default in package and current knowledge
documentation, including the maintenance reference. Add the required ordinary
Rush change note for the host package.

Run build, lint, test, and test type checking through Rush, plus knowledge and diff
checks. External review checks the bounded diff and preservation of explicit policy.
