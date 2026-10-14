# Architecture selection after complete replacement comparison

Selected by the TeamLeader on 2026-10-14 under the operator's delegated technical
judgment. Product authority: requirement revision 3. Implementation authority and
resumption are recorded in the task README. This records a design choice, not
executed implementation acceptance.

## Selected architecture

Keep provider-resolved per-input result values and one narrow native-result
observation capability. Make AgentService the sole Core notification owner and
remove EntityTurn's delivery controller. A provider creates one immutable native
result C, publishes it, and resolves the inputs actually answered with C. Core
folds these observations of the same fact by C, then queues one owner report.

The native runtime owns grouping and outcome selection. Core owns addressed
messages, reply rights, ordinary-member subscriptions, receipt identities,
report eligibility and delivery convergence. A managed TeamLeader has request
reply rights only; an ordinary member has an actual-owner subscription. These
rights do not follow the management tree recursively.

## Fair comparison and root adjudication

The alternative was a complete replacement, not an additional event layer:
Core-issued input receipt IDs, Core-owned result Promises, provider events with
answered ID sets, and input-only stopped/failed events. Its input map can replace
retained input records and its ID can replace the existing receipt ID. Neither
is counted as a second ledger or a third ID system. The text-only current ABI,
compatibility and prior refactoring are not reasons to reject it. Receiving
provider-computed membership would not itself reconstruct membership in Core.

| Consideration | Selected result-value design | Complete attributed-event replacement |
| --- | --- | --- |
| Native terminal production | One observation per normal/failed terminal; provider discipline | One event per terminal; still provider discipline |
| Per-input association | Provider resolves the actual input's result value | Provider echoes Core input IDs; Core resolves their values |
| Report folding | Shared result identity across observations | Recipient set within the one event |
| Native attribution bookkeeping | Retained in adapter | Retained in adapter; no grouping deletion |
| Admission ambiguity | No accepted handle means no retained reply right | Prebound input must retire on non-submitted admission; positive early acceptance needs an explicit rule |
| Native cause vs selected answer | Adapter selects the answer value | Event must carry both; cause/text cannot infer the value |
| Actual removal | Per-input Core delivery controller and second in-flight tracker | These plus adapter result-Promise plumbing and identity fold |
| Residual cross-package risk | Cloned result can duplicate a bound notification | Wrong/missing answered ID can resolve a wrong request or strand its value |

The replacement is implementable. The independent event sketch had gaps, but
none makes an ID-based protocol inherently impossible: an explicit selected
answer, an input-only outcome variant, and immediate ambiguity retirement can
close them. The claim that it must carry a frozen completion identity is rejected;
it needs the selected value, not cross-path reference equality. Likewise, a
prebound input record is feasible; it is provisional rather than already admitted.

The decisive selection criterion is separation of facts that become known at
different times. A native terminal can be known before the complete input
association is known. Codex's `bindSubmission` accepts a late admission against
an already selected record and resolves it with the stored C
(`packages/agent-runtime/codex/src/turn-manager.ts`: bindSubmission,
observeTerminal and releaseRecordIfReady). A single event with the complete answered set must hold that
terminal until the outstanding native admissions are attributable, even when a
bound member already exists, and hold later terminals to preserve order. Core IDs
do not remove the native turn/start association or that barrier. The selected
model lets the native result be observed and each request value become available
at its own authoritative boundary. Identity folding joins facts without adding
an exported membership protocol or provisional Core answer lifecycle.

The implementation review found the old unbound admission barrier had survived
despite no longer owning publication. It could discard an observed terminal on
connection failure and delay later bound answers. The final implementation
deletes that barrier, representative and terminal queue/mirror, selecting C
directly at observation. Existing admission snapshots retain C for late positive
acknowledgements; a later failure/stop does not overwrite the known answer.

This is not a universal mathematical optimum. Under the confirmed requirement,
it is the stronger complete design: retain one result identity to decouple native
observation from input association, remove the duplicate Core delivery lifetime,
and keep the request-value producer with the runtime that knows its answer.
The single-event alternative's real deletion of provider Promises is acknowledged;
it does not outweigh the lifecycle coupling and enlarged correspondence contract.

## Source counterexamples, not preservation slogans

- Codex interrupted terminals still pass through schema restoration. They can
  select a completed answer with null/partial text or a failed answer on codec
  error. Claude selects stopped. Native cause or nonempty text cannot decide
  script values or bound notifications (`turn-manager.ts:419-433`,
  `claude-code/src/rpc.ts:309-330`). No unbound interruption report is added.
- Claude ambiguous writes delete the unconfirmed request. Closing can select a
  private stopped/failed value whose handle was never admitted. Codex failed
  turn/start returns ambiguous without a handle. Those private values acquire
  no requested reply right (`rpc.ts:127-176`, `turn-manager.ts:149-158`).
- Two resolved input Promises do not by themselves fold two reports. Shared C
  is the one-result fact used by the policy. Distinct equal-text native results
  create distinct C values and remain separate.
- Subscription eligibility and a requested reply's observation need not share
  one incidental Promise clock. The selected design keeps terminal-time native
  eligibility and settlement-time request eligibility; started delivery is not
  retracted. An event-only design can intentionally move reply timing, but that
  movement is not necessary for this requirement.

## Consultation and strongest counterexample

Three independent selections and one cross-review were completed in the existing
DeepSeek, MiMo and Trae Seed proposal files. MiMo initially chose the replacement;
its final cross-review chose the result-value design. Root selection rests on
source and the comparison above, not unanimity. Root rejects the cross-review
claims that an event must preserve frozen reference identity or that provisional
records are impossible, while accepting their concrete outcome/admission cases.

The selected design's strongest surviving failure is provider reference misuse:
publishing C and settling with cloned C values silently duplicates reports. Types
do not enforce reference equality. Each adapter's reference-identity and delivered
order tests must cover the actual native finalization boundary, including late
admission; Core tests must cover folded leader replies and dual observation.
Tests and the provider contract mitigate this risk; they do not eliminate it.

## Adoption and execution

Core reporting ownership is replaced; the native observation is an additive
neutral capability with optional presence and mandatory emission when supplied.
Current Core always supplies it. New provider/old host can retain request behavior
with a guarded observer call. Old provider/new host retains bound answers but
lacks background coverage and native-order assurance. Neither skew is advertised
as feature conformity. No capability negotiation, fallback queue or persisted
migration is added. Exact implementation and acceptance are owned by final.md.
