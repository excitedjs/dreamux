# Verification and delivery evidence

Current target: selected requirement revision 3 and final solution, rebased onto
next after [#474](https://github.com/excitedjs/dreamux/pull/474). The resumed developer
completed the source change and supplied command logs; TeamLeader pre-review
inspected the whole implementation boundary, selected ownership and test diff.
Two independent implementation reviews completed. The runtime review found an
observed-terminal loss at the Codex pending-admission/connection-failure boundary;
the single writer corrected it and reran required gates. Corrected whole-change
independent review found no new reachable defect; root adjudication closes F1.

## Source and architecture adjudication

Three independent complete-design comparisons and one cross-review were completed.
The TeamLeader selected the result-value/one-Core-report-owner design, rejecting
vote counting and old-ABI preservation as decision criteria. Source counterexamples,
actual removals and the strongest residual risk are in technical-design/
architecture-selection.md. Proposal agreement is not executed acceptance.

## Rebase verification

- Fetch of origin next succeeded. Upstream contained #474 workflow simplification
  only; no package source overlap.
- Rebase advanced the [#473](https://github.com/excitedjs/dreamux/pull/473) baseline through [#474](https://github.com/excitedjs/dreamux/pull/474) without conflicts.
- Recovery snapshot plus include-untracked stash preserved the tracked binary
  patch, every untracked file and original index. Apply with --index restored
  them byte-for-byte; the implementation fingerprint was unchanged before the
  resumed writer started.
- No snapshot paths or private channel metadata are part of public delivery.

## Prior implementation evidence

The earlier developer reported Rush update/build/lint/test/typecheck:tests exit 0,
24 Core focused cases and 130 adapter cases. That report covered the historical
revision-2 dual-owner candidate. It does not certify the resumed one-report-owner
implementation or revision-3 managed-Team boundary. Six authenticated Codex model
gates and both-scope/both-runtime live member acceptance were previously unrun.

## Evidence ownership

The command/model evidence below covers the resumed implementation. The separate
review record owns independent whole-diff findings and root adjudication. Public
content scans include the whole staged task/KB/product change. Rush change
verification runs against the committed branch; GitHub owns PR CI status. Actual
model delivery is distinguished from collector replay and protocol smoke.

## Known contract limits

- Automatic reports require an available owner runtime and can be rejected/dropped;
  explicit send retains waking input. No offline replay guarantee.
- Input-only stopped/transport notices do not acquire a universal native order.
- Shared result reference discipline remains a provider contract; clones can
  duplicate reports. Contract tests mitigate this, not a runtime conformance claim.
- Loading an older provider preserves bound values but does not establish unbound
  coverage or ordered native observation. Optional observers are compatibility,
  not capability negotiation or feature conformity.

## Documentation preflight

- Task check-all with --allow-in-flight passed for all task records.
- Full KB preflight found broken historical proposal links, unreachable design
  artifacts and own-repository commit citations. Links/indexes were corrected
  without altering proposal arguments; own commit references were replaced by
  PR evidence. Rerun reports only the expected in-flight implementation state.
- Full KB validation runs after implementation/review closeout and done; the final
  submission checks below record that result.

## Current local and model verification (2026-10-14)

| Command / evidence | Result |
| --- | --- |
| Rush update | PASS, exit 0 |
| Rush build | PASS, exit 0 |
| Rush lint | PASS, exit 0, all nine operations |
| Rush test | PASS, exit 0, 2804 tests passed; six opt-in model cases excluded in default run |
| Rush typecheck:tests | PASS, exit 0, all eight operations |
| Opt-in Codex inbound/native-contract/activity model gates | PASS, all six separately enabled cases |
| New member MCP, isolated built target, real Codex model | Both Team and Dispatcher-root exercises passed; root first attempt timed out on an explicit owner reply, bounded retry passed, first failure retained |
| New member MCP, isolated built target, configured Claude-Code adapter model | Both Team and Dispatcher-root exercises passed after carrying the existing named-runtime settings/model configuration into the isolated helper; default-helper login failures retained |
| Native-only normal result, both adapters and both owner scopes | PASS; direct real native input with no registered submission, unchanged Core input count, exactly one owner report and actual owner-model acknowledgement |
| Peer-triggered reopen and fresh MCP lease, both adapters and both scopes | PASS; same record/native identity and resumed continuity, old lease revoked, real reopened model used fresh-lease list/send and peer model received its reply |
| Natural background chain, failed-background and Workflow live | Not run; deterministic adapter/Core tests cover these contracts |

The developer kept authentication/configuration unchanged, stopped owned exercise
servers/processes and removed temporary copied state/auth directories. No installed
production daemon restart or live Channel acceptance occurred. Actual model
binary versions were Codex 0.162.0 and Claude Code 2.1.295. The Codex retry proves the
bounded instructed exchange, not universal busy-model obedience. A follow-up
source/configuration check established that the initial Claude helper omitted
existing named-runtime settings and model arguments. With that already authorized
configuration, the actual Claude-Code adapter passed both scopes (five MCP calls
per scope, fourteen Dispatcher and thirteen Team model results). No new login or
credentials were acquired and all private copied settings were cleaned up. This
is configured-model evidence through the adapter, not a claim about a default
vendor login or every backend.

The final frozen-source follow-up used direct real turn/start RPC input for Codex
and direct resident stdin input for Claude-Code. Neither registered a Dreamux
submission. This proves actual native-only result delivery, not a naturally
generated background chain. All four adapter/scope combinations also exercised
actual peer-model send reopening a closed peer, native resume identity and a
fresh usable MCP lease. Five attempts were recorded: the first Codex-root reopen
assertion ran before its actual terminal arrived; waiting for that terminal on
one bounded retry passed, and the original failure remains recorded. The source,
tests, change notes and operator configuration audit stayed unchanged; all owned
temporary directories and processes were cleaned up. TeamLeader inspected the
exercise assertions and structured evidence rather than adopting PASS labels.

TeamLeader verified command logs and reviewed the new outcome/identity/order/
convergence cases rather than treating the developer's verdict as proof. Existing
load-bearing inbound/lifecycle assertions remain; removed EntityTurn controller
unit coverage moved to actual AgentService/recipient tests. The source diagnostic
fix preserves the original stop reason when stop and unsettled-input failures are
aggregated; no existing destruction assertion was weakened.

## Deliberate timing difference

Requested eligibility is still read at settlement observation, but the policy's
aggregate-fence check and queue entry advance one microtask by removing the old
EntityTurn deferred policy call. This is named in final.md, package guidance and
behavior tests: a pre-entry fence suppresses; an already queued report is not
retracted; actual owner close/host stop suppression and started-delivery joining
remain. Native subscription eligibility stays at terminal publication.

## Accepted runtime review correction

The initial full local/model evidence above predates the F1 correction. Codex
could queue an already observed unbound terminal behind an in-flight admission,
then clear that terminal on connection failure. This loses a real result, unlike
the correctly forbidden fabrication of a result for transport failure. Root
accepted the defect under Q1/Q1a and delegated one-writer correction, including
adjacent queued-result, interruption, late-admission and retirement cases.

The correction deletes the representative, admission publication barrier,
terminalOrder and terminal mirror. C is selected/published synchronously at native
observation and retained only for native admissions already in flight. Late
positive admission consumes known C before considering later failure/stop;
unobserved accepted inputs still fail/stop, ambiguous input has no reply, and
interrupted selected values do not add native notifications. This intentionally
removes the delayed bound-answer race as well as silent unbound-result loss.

| Corrected-target evidence | Result |
| --- | --- |
| Adapter collector/runtime regressions | PASS, 75 cases |
| Core owner/report/admission/identity regressions | PASS, 76 cases, both owner scopes |
| Rush build | PASS, exit 0 |
| Rush lint | PASS, exit 0, nine operations |
| Rush test | PASS, exit 0, 2831 tests; six opt-in model cases excluded |
| Rush typecheck:tests | PASS, exit 0, eight operations |

Dependencies did not change; no additional update was necessary. Initial test
fixture errors (standalone TurnManager does not own transport-close lifecycle,
and Runtime status is observed through its state sink rather than a nonexistent
getter) and their failures remain recorded. Production lifecycle assertions are
retained; the queue-wait assertion now requires ordered actual owner delivery
before admission while preserving fold/count checks. TeamLeader inspected the
corrected source, assertions and final command summaries. The fault interleavings
are unit/collector-replay evidence. Prior model evidence is retained as prior-build
evidence, not silently renamed corrected-build fault acceptance; its unchanged
messaging/resume coverage and the unrun live limits remain explicit.

Root also read the eight package test summaries from Rush's chunked logs: their
passed counts sum to 2831, with six excluded opt-in cases in the Core package.

## Submission closeout

Independent whole-change Core review and corrected runtime review completed; no
accepted finding remains unresolved. Root updated the current architecture,
provider/runtime, orchestration, service topology, product and glossary owners,
and reconciled task authority, selected design and evidence. Root routing was
already sufficient; state/config maintenance is N/A because no persisted shape,
config/default or path changed. The explicit staged paths exclude local .vite
cache and private exercise/recovery artifacts. GitHub owns PR CI and merge status.

Final KB validation passed: 56 task records and 384 reachable knowledge files.
Working and staged diff checks passed. Complete staged public-content and gitleaks
preflight passed; the reviewed implementation commit passed the current worktree's
canonical mandatory staged-ESLint, author, gitleaks and internal-content hook.
The committed-branch Rush change verification against origin/next passed and
discovered all four ordinary minor notes. Delivery is linked from task README;
GitHub records the exact PR heads, check runs and eventual merge disposition.

After external final review, the original writer replaced only two Codex comment
lines to spell out completion rather than C. Build, lint, test and
typecheck:tests each exited 0 again; the default test count remains 2831 passed
with six opt-in model cases excluded. No test or change note was added, no
dependencies changed, and no live-model evidence was rerun or reclassified.
Root verified that the executable diff is unchanged. External approval and the
operator's separate decision withholding merge authority are linked in the task.

## Published alpha and managed restart acceptance (2026-10-14)

The operator authorized an alpha publish, local upgrade, restart and testing
through the merge-card response quoted in task README. This is acceptance
authority, not merge authority. The [feature-branch release run](https://github.com/excitedjs/dreamux/actions/runs/38530361815)
succeeded from the reviewed PR head and audited tarballs before OIDC upload.
Registry metadata and the installed CLI both report
`@excitedjs/dreamux@0.27.0-alpha.ga706555cedee`. The matching installed types,
Codex and Claude-Code packages are respectively
`0.12.0-alpha.ga706555cedee`, `0.8.0-alpha.ga706555cedee` and
`0.9.0-alpha.ga706555cedee`; these are installed artifacts, not source-build
substitutes.

The existing managed installation was upgraded from `0.27.0-beta.276` using
its same Node/npm prefix. Initial global-install attempts returned ETARGET
because the global registry differed from the project's public registry. An
explicit public-registry command succeeded; no global registry or operator
config was changed. The target changelog was read: it records stable entries
through `0.26.0` rather than an alpha entry. This feature selects no persisted
state/config migration, and none was performed.

Pre-restart and independently repeated post-restart doctor each returned
`ok=true`, 33 checks and no failures. The notification restart injected its
actual `Restart completed.` notice into the resumed Dispatcher, which handed
acceptance back to the existing TeamLeader. Root independently confirmed a
changed daemon PID, active/running and enabled user service, a ready Dispatcher
and the installed target version. This is managed-service restart evidence;
installation alone was not treated as restart success. The original config
content hash remained unchanged.

The resumed managed Team also ran a new ordinary Codex member using the actual
installed daemon. It called member `list` and `send` to the discovered owner;
the TeamLeader received both the member-addressed task with the host-bound
sender and its automatic final turn-result notification. This evidence is the
actual pushed input/notification, not an activity read. The smoke member was
closed after its completion.

The operator then explicitly requested Codex and DeepSeek owner/peer testing.
Two new members in this same managed Team each discovered the owner with the
member `list` tool and proactively sent it a uniquely marked message. Root
received both host-attributed messages and both normal turn-result pushes.
For Codex-to-DeepSeek and DeepSeek-to-Codex, the sender's completion, the
recipient's PING-handler completion and the sender's ACK-seen completion each
arrived through the actual notification path. Replies were explicitly addressed
with `send`, and ACKs did not trigger reply loops. Both actors were closed only
after those requested exchanges completed. No files, commands or Channel calls
were delegated to these actors.

Installed-artifact isolated real-model matrix (all modules and MCP launchers
resolved from the installed alpha):

| Adapter | Owner scope | Initial result | Model results | Actual member MCP calls | Cleanup |
| --- | --- | --- | --- | --- | --- |
| Codex | Dispatcher | FAIL: peer-exchange confirmation deadline | — | 3 | Complete |
| Codex | Team | PASS | 11 | 5 | Complete |
| Configured Claude-Code | Dispatcher | PASS | 14 | 5 | Complete |
| Configured Claude-Code | Team | PASS | 15 | 5 | Complete |

Passing rows asserted member `send/list`, host-bound sender envelopes, an
explicit cross-turn peer reply, the owner's message and explicit reply, and
automatic bound result delivery. The initial matrix exited nonzero because of
its Codex/Dispatcher row; the failed record was retained. One bounded retry
with the same helper configuration also failed at peer-exchange confirmation.
The instrumentation observed accepted peer request/reply calls and the reply
text in the sender runtime's submitted inputs, but did not observe the expected
final confirmation marker by the deadline. Admission was not called execution.

A separate Codex/Dispatcher exercise carried the existing named runtime's
configured model parameters, which the initial generic Codex helper omitted.
It retained the same assertions: peer exchange completed and all five member
MCP calls succeeded, including the explicit owner reply. The reply reached the
sender's submitted inputs, but its final confirmation still missed the deadline.
That exercise also exited nonzero and cleaned up. Changing configuration is not
proof of the earlier timeout's cause; no underlying cause is established here.
These three failed exercise records remain failures, not an all-green matrix
or a claim about universal busy-input scheduling.

The operator-requested actual managed-Team Codex/DeepSeek owner and reciprocal
peer exchanges above are separate passing evidence. They do not erase the
isolated Codex/Dispatcher confirmation limit. Natural background chains,
failed-background and Workflow live acceptance remain unclaimed. Every isolated
exercise reported completed shutdown/temporary-state cleanup; all three managed
smoke actors were closed. No credential acquisition, operator config change,
production source change or new model-backed fault-interleaving claim was made.
The acceptance verdict is PASS for publication/install/restart and the requested
managed-Team exchanges, PARTIAL for the isolated installed-artifact matrix.

### Supplementary managed-Dispatcher evidence

After the same installed-alpha restart, the Dispatcher reported an additional
actual managed-service smoke with its own ordinary Codex and configured
DeepSeek members. It reported four passing checks: both members proactively
sent host-attributed messages to their Dispatcher owner; the members explicitly
exchanged PING/PONG messages; both receiving turns confirmed the peer content
beyond the admission receipts; and the Dispatcher received four automatic
turn-result reports, including a peer-triggered follow-up.

Root independently queried the two named records through the installed admin
Command surface and confirmed their configured runtimes and closed state. The
Dispatcher's direct inbound-message and notification observations are reported
supplementary evidence, not events Root independently witnessed. This actual
root-collection test supplements Root's managed-Team and isolated-artifact
smokes; it does not replace them or turn their failed deadlines into passes.
The same natural-background, failed-background and Workflow-live limits remain.

The Dispatcher also observed discovery spilling a large historical peer roster
to a tool-result file, requiring the models to filter that file. Source inspection
confirmed the cause of that output scope: member `list` takes no query and
returns the owner's entire collection, including closed peers, with only the
caller excluded. Discovery worked, but the output is not limited to running or
related peers. This is a recorded usability limit, with no new filtering, cap
or discovery contract selected in this change. No configuration, credentials
or repositories were changed by the reported smoke; normal member creation
and close used Dreamux's existing server-owned lifecycle records.

## Earlier lightweight member guidance follow-up (2026-10-14)

The operator approved only the proposed three-sentence guidance and explicitly
requested push plus a new alpha. The source diff replaces one sentence in the
ordinary member prompt with that exact text. It adds no mandatory reporting
frequency or end-of-turn send requirement. Routing, tools, automatic results and
Workflow construction remain unchanged.

- Rush build, lint, test and typecheck:tests passed with exit 0. The first
  typecheck invocation was refused by Rush's repository lock while test was
  running; the sequential rerun passed. No dependency changed, so update was
  not repeated.
- Existing provider-launch prompt and lifecycle tests were retained. No static
  copy-only test was added. Built output contains the approved guidance.
- Independent read-only review approved the complete source follow-up and its
  generated Dreamux patch change note, checking both ordinary owner scopes and
  the unchanged Workflow exclusion. Earlier full implementation reviews retain
  their original targets.
- The change was inspected against the operator's exact approved text; source
  diff is one replacement. Public task/product records capture the bounded
  authorization. No new live-model claim is made for this prompt change.

### Follow-up alpha publication

- [Source CI](https://github.com/excitedjs/dreamux/actions/runs/38560106137)
  passed all nine checks, including both operating-system Rush jobs.
- [Feature-branch release](https://github.com/excitedjs/dreamux/actions/runs/38560685548)
  succeeded and published `@excitedjs/dreamux@0.27.0-alpha.g4af2f5f9ad03`.
  The workflow built, packed and audited before OIDC publication; its stable
  jobs were skipped. It made no source version commit or release tag.
- Public npm metadata confirms the fixed version. Root downloaded the published
  tarball, verified its SHA-512 integrity against registry metadata, and checked
  that compiled ordinary-member guidance contains the exact approved text and
  omits the replaced availability sentence.
- The alpha dist-tag points to that version. Before/after snapshots confirmed
  that latest and beta did not move.
- This follow-up publishes only; it does not install or restart the managed
  service. Its installed CLI remained on the earlier accepted alpha. No
  new live-model or proactive-send behavior proof is claimed for the new
  guidance. Earlier alpha acceptance and its recorded failures keep their
  original artifact provenance.

## Codex-style capability follow-up (2026-10-14)

The operator subsequently requested Codex's collaboration-capability wording.
The source replaces the entire prior communication appendix with a brief
capability overview: actual owner, teammate.send/list for that owner and
collection peers, and automatic normal/failed turn-result reporting to an
available owner. With an example owner name, that appendix is 49 English words
instead of about 120. Membership, plugin instructions and operator identity
remain separately appended in their existing order.

- Rush build, lint, test and typecheck:tests passed with exit 0. No dependency
  changed, so update was not repeated. Opt-in model gates were not enabled.
- Built output contains the new capability text. Existing provider-launch,
  owner-scope and Workflow tests were retained without weakening assertions;
  no static copy-only test was added.
- Independent read-only review approved the one-line source replacement and
  generated Dreamux patch note. It checked the local Codex default subagent
  capability paragraph, Dreamux's actual tools, owner scopes and Workflow
  exclusion; it found no actual defect.
- Tool schemas, receipts, routing, automatic-report eligibility and lifecycle
  behavior did not change. Product wording describes the shorter guidance;
  the superseded guidance and released artifacts remain historical evidence.
- This verification does not certify new proactive model behavior. Earlier
  installed-alpha model results and failures retain their original targets.
