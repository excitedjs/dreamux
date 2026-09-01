# Large-Refactor Mode

Apply this reference in addition to the normal workflow when a task is an
architecture-domain refactor expected to span multiple implementation stages —
typically: it rewrites a public contract in `dreamux-types`, touches several
route rows in `.agents/root.md`, or plans more than one developer pass. The
normal ten steps still govern; this page adds the discipline that multi-day
refactors have proven to need.

## Set the authority order at kickoff

Record in the task README, before clarification starts:

> The confirmed final product shape decides. Existing code, prior decisions,
> and existing documents are evidence of how the system got here; any of them
> may be overturned to fit the current product scenario, knowingly — by naming
> what is being changed and why its original rationale no longer holds.
> User-visible behavior changes are operator decisions.

Load `engineering-whitepaper` and pass a pointer to it in every seat identity.

## Design against the ideal shape, not the diff

During solution work, run one explicit greenfield pass per reshaped module:
design what the module would look like if it did not exist and only the
current requirement did, then diff that ideal against the current shape.
Classify the gap as adaptation (evolve in place) or replacement (redesign the
module), state which, and put that classification in front of the operator.
Skipping this pass is how a refactor silently becomes glue accumulation.

Diff the plan against [the product behavior catalog](/.agents/product/README.md):
list every catalog entry the plan touches. For a contraction refactor, have an
independent reviewer produce a feature-loss ledger (existing behavior → what
threatens it → concrete failure mode → smallest correction) and a
consumer matrix (member → consumer `file:line` → unconditional/conditional/
none) before the requirement freezes. "Zero consumers" splits two ways: never
had one (delete) versus lost its last one through this task's own rulings
(take back to the operator).

## Keep an operator rulings ledger

Maintain one `rulings.md` in the task directory. Every operator ruling gets a
row in the same turn it is given: the operator's words (verbatim or narrower —
never broadened), a timestamp, and the object it applies to. Commit the ledger
update before moving to the next question; chat history and context memory do
not survive compaction.

The ledger is enforced at dispatch time: every developer, solution, and
review dispatch names the ledger as required reading; a review finding that
contradicts a ledger row is rejected by the TeamLeader with the row cited
(see [implementation-review.md](implementation-review.md)); an entry may be
recorded as a confirmed operator decision only with the operator's actual
words behind it — inferences are labeled as inferences and confirmed before
anything cites them.

## Re-supply knowledge at stage boundaries

At every stage switch, and after every context compaction: re-run the
`.agents/root.md` task routes for the stage's area, re-read the rulings
ledger, and restate the remaining-work list to the operator. A route read on
day one does not survive to stage five.

## Pre-review includes a structural account

A stage pre-review report includes, besides gates: files added and deleted
with line counts, net line change, and the consumer count of every new symbol
on both sides of a seam. "Gates are green plus a design intent paragraph" is
not a pre-review. A shared layer that leaves both sides' schemas and wiring in
place is glue, not ownership convergence — count what it actually removed.

## Report on the operator's cadence

Sync one line to the channel at each of: dispatching any TeamMate or workflow;
receiving each review or workflow result (even before adjudication); a gate
moving from one phase to the next; ten minutes past any promised "I'll have X
shortly"; and after every context compaction. Each line: what is running, what
is blocked, expected time to the next event. Long delegation with no updates
reads as a stall and costs an operator round trip.
