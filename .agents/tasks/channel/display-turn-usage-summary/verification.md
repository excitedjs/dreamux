# Verification

## Target and TeamLeader pre-review

- Baseline: `2b3d697` on `next`; the usage implementation is the working diff.
- Scope: both runtime packages, their regression tests, and task/product/runtime
  knowledge. No Core/Channel source, dependency, state, configuration, or prompt
  changes are part of the feature.
- The TeamLeader checked the whole diff against the requirement and final solution.
  Native cumulative snapshots are replaced, not accumulated. Claude context is
  the last main input and resets on result consumption or cancellation. Usage is
  display-only and precedes native end, including failure and interruption; native
  interruption markers and settlement behavior remain unchanged.
- Upstream #384 moved Claude activity to `runtime-activity.ts`; #379 introduced
  native interruption events. Tests were ported to those owners instead of
  retaining the removed submission-window implementation.
- Initial assertions in the new Codex interruption test incorrectly expected a
  stopped settlement, then an empty string. Current source returns its existing
  completed settlement with null text for a no-message native turn. The test now
  locks that unchanged behavior; no production settlement code or prior assertion
  was changed to satisfy this feature.

## Commands and results

Rush commands clear only the environment-injected Git hook override:

```bash
env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 \
  -u GIT_CONFIG_PARAMETERS node common/scripts/install-run-rush.js <command>
```

Repository and global Git configuration are unchanged. A normal `rush update`
installed the repository pre-commit hook successfully; no policy bypass or
`--no-verify` is used for delivery. The required gitleaks binary reports 8.30.1.

| Command | Result |
| --- | --- |
| `node common/scripts/install-run-rush.js update` | PASS on the updated baseline; repository hook installed |
| `node common/scripts/install-run-rush.js build` | PASS; 7 operations rebuilt, unchanged eslint-config already up to date |
| `node common/scripts/install-run-rush.js lint` | PASS; all 7 applicable operations |
| `node common/scripts/install-run-rush.js typecheck` | PASS; all 7 applicable operations on the updated baseline |
| `node common/scripts/install-run-rush.js typecheck:tests` | PASS; all 6 applicable operations, including the ported tests |
| `node common/scripts/install-run-rush.js test --to @excitedjs/agent-runtime-codex --to @excitedjs/agent-runtime-claude-code` | PASS; both complete runtime suites and their dependency suites; expected error-path stderr warnings |
| `node common/scripts/install-run-rush.js smoke-built-cli` | PASS on the updated baseline |
| `node common/scripts/install-run-rush.js test` | FAIL on both baselines: the same five real-model Codex cases timed out or received no model activity; the updated-baseline run completed with six other package test operations passing |
| `git diff --check` | PASS after upstream integration |

Both full runs used real Codex 0.153.4 without skip flags and failed in the same
five scenarios: continuity/resume, structured output, mid-turn activity, unbound
native end, and mid-turn inbound folding. The last case received only native startup/user-message
notifications, not a model response or command execution. Independent
`codex exec --ephemeral --skip-git-repo-check -C /tmp` probes with a minimal reply
prompt also timed out outside Dreamux. A credential-free HTTPS reachability probe
for the native ChatGPT endpoint timed out at connection establishment. Native
stderr independently reports model-catalog refresh timeouts. This is evidence of
an unavailable native model path, not a passing live gate. No skip flag, test
weakening, production configuration change, or service restart was used.

## Transport integration and coverage

A one-shot `node --input-type=module -e` harness exercised the built native
Codex TurnManager and Claude parser/aggregator/activity handler through the real
Core conversation projection and Feishu COT adapter, with only the native input
and external COT client recorded in memory. Six cases passed: each runtime's
completed, failed, and interrupted terminal.

Assertions checked exact requested summary text, survival through Core redaction,
usage immediately before projected native end, wire `TEXT_MESSAGE_CONTENT` before
`RUN_FINISHED`/`RUN_ERROR`, and preserved native failure reason. Runtime suites
also cover cumulative replacement, cross-result isolation, cache inclusion,
sub-agent exclusion from main context, missing values, unit boundaries,
terminal-before-admission, repeated terminal, and unchanged completion text.

This is deterministic transport integration, not observed browser or live Feishu
UI verification. No browser executable, browser tool, or repository web dev server
is available here; no production card/configuration was changed. Live Claude usage
and live Feishu card rendering remain unverified. Do not describe the change as
fully green while the real-model gate is unavailable.

## Independent review and TeamLeader adjudication

One independent read-only reviewer returned APPROVE with no functional,
correctness, complexity, or boundary findings. It checked the full runtime/test
diff, native Codex usage ordering, Claude aggregation, terminal/teardown paths,
completion builders, and formatting; it did not rerun gates. The TeamLeader
accepted that verdict. No reviewer finding required correction or ratification.

| Closeout observation | Disposition | Reason | Ruling conflict |
| --- | --- | --- | --- |
| Keep provider-local formatters and Codex's cross-turn snapshot | Accept; no change | Both match the approved native-only design | None |
| Update product/runtime knowledge | Accept; complete | These own the approved behavior and accounting facts | None |
| Check whether the display row requires breaking release notes | Patch retained | Additive display behavior; no rebuild, removed capability, or required factory change | None |
| Keep live-model limitations visible in the draft PR | Accept | Five real-model cases remain failed, not skipped or green | None |

The TeamLeader's final compatibility check found that the interrupted callback
outcome was required, contrary to the approved optional-metrics boundary for
custom session factories. It is now optional, usage access handles its absence,
and the original no-outcome interruption test is restored unchanged. The native
RPC still forwards its actual outcome; the new usage test retains marker, usage,
then end ordering. This restores the already-approved boundary, not a new scope.
No second independent review was run.

After this correction, Rush build, lint, typecheck, typecheck:tests, both complete
runtime suites and their dependencies, and built-CLI smoke passed again. The
known full-suite failure remains recorded rather than retrying the same live
network failure again.

## Knowledge and delivery

Rush generated patch change files for both runtime packages with
`change --bulk --message <release-note> --bump-type patch --target-branch origin/next --no-fetch`.
The product catalog records the new display row, provider-runtime records native
accounting and optional interrupted outcomes, and repository operations records
the environment-injected hook override trap. Config/state/maintenance, neutral
contracts, CLI, glossary, and root routing are unchanged and need no update.
Knowledge validation passed with
`python3 .agents/skills/dev-workflow/scripts/init_task.py check --domain channel --slug display-turn-usage-summary`,
`.agents/scripts/check.sh` (206 reachable files), and `git diff --check HEAD`.
The final `rush smoke-built-cli` also passed. Implementation and knowledge closeout
are complete; the task's done state does not assert green live verification or
merge readiness. Delivery is draft-only until the outstanding gate is cleared.
No merge, release, production restart, or Team dissolution is included in the
operator's authority.

The two completed live-test runs left six native app-server instances after
Vitest timeouts. Their exact temporary test socket paths identified the owned
processes; SIGTERM stopped those six instances and their six launcher processes.
A process check confirmed all twelve exited. No production runtime was stopped.
