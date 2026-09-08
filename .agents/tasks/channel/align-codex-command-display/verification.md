# Verification

## Scope and TeamLeader pre-review

- Review baseline: `305e3fc8`; inspect the uncommitted workspace change, not
  unrelated commits already in that baseline.
- The only executable product change is the private display decoder in
  `/packages/agent-runtime/codex/src/tool-display.ts`. No execution, activity
  contract, Core projection, or Feishu rendering implementation changed.
- Existing assertions were retained. New coverage checks shell extraction,
  quoting, unsupported input, Windows round-trip spelling, structured action
  labels, started/completed runtime facts, and Feishu title/code consumption.
- The package LICENSE credits the rust-shlex parsing/quoting adaptation under
  its MIT option; no dependency was added.
- Initial compilation exposed TypeScript loop-inference errors on the three
  quoting-strategy booleans. Explicit boolean annotations resolved them.
- TeamLeader pre-review and final revalidation after both approved corrections
  passed: build, lint, all tests, and test typechecking. The full test run
  includes real Codex model gates.

## Commands and results

The four repository gates were rerun successfully after both approved review
corrections on 2026-09-09. Build reused up-to-date outputs for unchanged packages;
all test suites ran without skips.

| Check | Result |
| --- | --- |
| `node common/scripts/install-run-rush.js update` | Passed after the authorized removal of injected hook-path environment entries from this child process; Rush installed the repository pre-commit hook. |
| `node common/scripts/install-run-rush.js build` | Passed on the final source. |
| `node common/scripts/install-run-rush.js lint` | Passed on the final source and tests. |
| `node common/scripts/install-run-rush.js typecheck:tests` | Passed across all packages. |
| `node common/scripts/install-run-rush.js test --only @excitedjs/agent-runtime-codex --only @excitedjs/feishu-channel` | Passed, including the added canonical Windows quoting cases. |
| `node common/scripts/install-run-rush.js test` | Passed with the existing operator Codex proxy supplied through `HTTP_PROXY` and `HTTPS_PROXY`: 149 test files, 2,263 tests, no skips; includes all 9 `codex-live.test.ts` cases on Codex 0.153.4. |
| `python3 .agents/skills/dev-workflow/scripts/init_task.py check --domain channel --slug align-codex-command-display` | Passed with this verification record included. |
| `.agents/scripts/check.sh` | Passed: 193 files reachable. |
| `git diff --check` | Passed. |

The initial live-test process initialized Codex 0.153.4 but received no model
response for even the plain `Reply with exactly the word ok.` case. Model cases
failed by timeout or empty activity, including the issue #63 folding gate. The
operator's interactive Codex alias supplies proxy variables; direct test child
processes did not have them. The rerun supplies the same existing proxy without
changing repository or persistent runtime configuration. No live-test skip,
assertion change, or timeout increase was used.

Rush generated the package patch note through `rush change --bulk`. Its own
`ChangeFiles.validate` accepted the new uncommitted change file and Codex package
coverage. `rush change --verify` discovers change files through a committed
three-dot diff, so final branch verification remains a post-commit gate; no
commit was created to make that check pass.

## Delivery baseline

The original workspace starts at `305e3fc8`, whose Workflow notification change
is not part of `origin/next`. The original task commit `bac326a8` is preserved on
its implementation branch. Only that patch was transferred onto `origin/next`
(`2b3d6971`) as `fix/codex-command-display`, excluding the unrelated change from
the PR. The only conflict was concurrent task-index additions; both entries are
retained. The parser source and its direct tests are byte-identical to the
reviewed implementation; runtime and Feishu tests applied without content
conflicts. The checks above describe the original reviewed baseline.

The isolated delivery branch passed build, lint, test, and `typecheck:tests`:
150 test files and 2,300 tests, no skips, including all 9 real Codex cases.
The test total includes coverage added by the newer trunk; the Codex display
suite remains 62 cases. The task validator, KB check (206 reachable files),
and diff whitespace checks also passed. No inherited commit is discarded or
published as part of this task.

## Display-chain evidence and visual limitation

An in-memory probe imported the compiled Codex `toolDisplay`, Core
`createConversationProjection`, and Feishu `toolCallStartEvents` /
`toolCallResultEvents` implementations. Six cases passed: Zsh multiline, Bash
Unicode and literal variables, PowerShell, unknown shell, malformed quoting,
and noncanonical Windows drive-path text. The probe asserted the raw argument
survived and the final title/code payload matched the decoded script or the
unchanged input, as appropriate. It performed no command execution or network
send.

For `/usr/bin/zsh -lc "node --check script.mjs\necho done"`, the title was
`node --check script.mjs` and the expanded code was the two-line inner script.

No browser/client visual verification has been performed. This change has no
local web UI or dev-server surface, and no browser tool is available in this
session. No live Dreamux service was restarted, replaced, or used to send a
probe card. Automated payload verification does not establish the rendered
Feishu client result.

## Independent review

The single independent read-only review completed with no functional or
architecture blocker and two improvement-level findings. The reviewer reported
16,009 differential inputs with no mismatch against an independently transcribed
Python oracle, including 3,253 unwrapped inputs and 1,292 Windows round-trip
inputs. This is reviewer evidence, not execution of the original Rust; a shared
transcription error remains possible. The review did not rerun repository gates
or perform a Feishu client render.

### TeamLeader adjudication

| Finding | Verdict | Reason | Operator-ruling conflict / ratification |
| --- | --- | --- | --- |
| 1. NUL-input branch and fabricated fixture (`tool-display.ts:69`, `tool-display.test.ts:105` before cleanup) | Accepted; operator approved on 2026-09-09 | All traced producers already call `shlex_join`, which substitutes a literal marker on NUL; no reachable additional display failure needs this branch. | Operator ruling: "删除冗余分支 (Recommended)". Delete only this predicate and fixture; no other parsing rule changes. |
| 2. Stale invocation description (`provider-runtime.md:664-665` before correction) | Accepted; operator approved on 2026-09-09 | The owner page must distinguish a recognized wrapper's decoded inner script from an unchanged ordinary command. | Operator ruling: "同步文档 (Recommended)". Documentation only; no new runtime behavior. |

Finding 1 is applied after the operator's explicit approval: removed the NUL
predicate and its fabricated test fixture only. The targeted Codex and Feishu
package tests, task validator, KB check, and `git diff --check` pass after this
cleanup; the final four-gate rerun also passed. Finding 2 is also applied after
its separate approval: the provider-runtime owner now distinguishes the display
command from unchanged raw arguments.

The TeamLeader traced the reviewer's previously untraced guardian `Command`
producer to upstream `core/src/guardian/approval_request.rs:199-208`: it also calls
`shlex_join`. Therefore the review's side claim that this producer establishes
noncanonical raw command input is not accepted. The Windows round-trip rule
remains required by explicit acceptance criterion 4 and is not part of finding 1.
The noted trailing-slash shell-path difference has no demonstrated executable
producer and is not expanded into a new parser special case.
