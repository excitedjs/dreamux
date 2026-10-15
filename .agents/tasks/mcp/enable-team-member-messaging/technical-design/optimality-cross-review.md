# Architecture selection: single cross-review

Read the three sections titled "Operator-delegated optimal architecture
selection — independent proposal (2026-10-14)" and the current owning source.
Append one cross-review (target at most 600 words) to your assigned proposal.
Choose the stronger complete architecture; do not count votes. No implementation,
tests, prototypes, Git, or external writes are authorized.

## Fair comparison requirements

1. Candidate 2 is a complete replacement: Core mints an input receipt identity
   before calling the provider, owns the result Promise, and receives provider
   grouping metadata. Its map can replace the current retained input records;
   its ID can replace the current public receipt identity. Do not automatically
   count either as a second registry or a third ID system. Conversely, enumerate
   the native attribution/admission bookkeeping that still remains in adapters.
2. The current text-only ABI and the old refactoring are evidence, not constraints.
   Receiving the grouping computed by a provider is not inherently Core
   reconstructing that grouping. Explain any extra knowledge the alternative
   actually requires, without relying on what the present interface forbids.
3. Candidate 1's two observations of one result and cross-package reference
   equality are real costs, even if already implemented. Candidate 2's event loss
   and wrong input association are real costs too. Once-per-terminal production
   remains a provider obligation under both; a single path does not prevent a
   producer from publishing twice. Recipient-set folding within an event does
   not require a new Core native-turn ID or a turn-ID dedup ledger.
4. Candidate 2 must distinguish the native terminal cause from the selected
   per-input outcome. Codex interruption settles a completion with partial text,
   including a potentially null/empty text; Claude interruption settles stopped.
   Inferring that distinction from whether text exists is unsound. Preserve the
   bound member notice and Q5 reply, while unbound interruption remains silent.
5. Input-only outcomes include stopped as well as failed. Admission failure,
   skipped and ambiguous are not automatically accepted input answer rights.
   Claude `failWrite` deletes an unconfirmed request and returns ambiguous;
   `close` can return ambiguous for an unconfirmed request while resolving its
   private, never-admitted result Promise. Codex failed native admission likewise
   returns ambiguous without a handle. Do not retain an ambiguous Core record
   indefinitely or manufacture an upstream reply. Specify retirement and early
   positive acceptance, rather than hiding them behind "wait until an event".
6. Name eligibility timing movement for managed leader replies. Promise hop
   count is not an immutable product requirement; preserving it is not by itself
   a selection criterion. Preserve actual stop suppression, started-delivery
   behavior, accepted-input convergence and request outcomes. Neither design may
   claim a total order for input-only notices unless it supplies one.

## Source anchors for falsification

- Core admission attachment and non-submitted retirement:
  `packages/dreamux/src/service/agent/service.ts:313-357`.
- Existing public receipt and retained values:
  `packages/dreamux/src/service/agent/turn.ts:70-107`,
  `packages/dreamux/src/service/team/requests.ts:119-122`,
  `packages/dreamux/src/service/workflow-service/run.ts:582-597`.
- Claude admission, ambiguous write, close and positive result acceptance:
  `packages/agent-runtime/claude-code/src/rpc.ts:85-176,278-330`.
- Codex admission association and interrupted completed-shaped settlements:
  `packages/agent-runtime/codex/src/turn-manager.ts:120-173,276-334`.
- Actual fail-loud convergence:
  `packages/dreamux/src/service/agent/service.ts:379-391`.

Give accepted/rejected arguments, a corrected interface/ownership sketch if
needed, actual net additions/deletions, the strongest surviving counterexample,
and a definite recommendation. Keep product revision 3 fixed; the TeamLeader
will decide the internal architecture without another operator choice card.
