# Technical Solution Selection and Review

## Freeze the shared input

Start only after requirement clarification has converged. Use the current
requirement artifacts linked from the confirmed task README as the sole requirement
input for every solution TeamMate. Do not restate or paraphrase the requirement in
dispatch prompts. Provide only the task path, input paths, assigned output path,
and write boundaries.

Set `State: solution` and record the input revision in the task README. If a material
requirement change lands during this phase, invalidate the current draft, proposals,
and reviews, then restart the selected path from the updated task files.

Do not modify implementation artifacts or create prototypes during consultation.

## Select the path

Apply the one-file fast path first when it is eligible. Otherwise choose between a
TeamLeader-authored solution with three reviewers and a three-proposal consultation.
Base the classification on the recorded requirement and current code, not on task
size labels or intuition alone.

Treat the task as simple when it has one clear owner, a bounded implementation
surface, one evident design direction, and no material contract, migration,
lifecycle, compatibility, or cross-owner trade-off. Have the TeamLeader author the
solution, then use three TeamMates to review it independently.

Treat the task as complex when it has multiple plausible ownership or architecture
choices, changes a public or persisted contract, crosses several owners, requires a
migration or substantial lifecycle redesign, or is a broad refactor whose correct
boundary is itself disputed. Use three independent proposals and cross-review.

Before asking the operator which path to use, search the TeamLeader's available
durable memory for an explicit preference about solution workflow or repeated
workflow questions. Follow a clear applicable preference. Do not infer a durable
preference from a single past acceptance or from task history.

If no explicit preference applies, state the classification and its concrete
rationale, then ask once. For example:

> This task has several competing ownership and architecture choices, so I propose
> the three-seat solution-consultation path. Is that acceptable, or would you prefer
> that I author the solution directly?

or:

> This task has one clear owner and a bounded change surface, so I propose to author
> the solution and send it to three reviewers. Is that acceptable?

If the operator has explicitly asked not to be consulted on this recurring choice,
select the path according to that preference and proceed. When the operator asks
to remember a preference, use the available durable-memory mechanism; do not store
a user-global interaction preference in a repository task. If memory is unavailable,
say so rather than pretending the preference was persisted.

Confirmation of the solution workflow is not development approval.

## Run the simple solution-review path

Have the TeamLeader write the proposed solution to `technical-design/draft.md`,
grounded in the current requirement and code. Load and follow `team-workflow`, then
start exactly three independent review TeamMates with the common and solution
reviewer identities from [solution-identities.md](solution-identities.md). Add
another only for an additional genuinely independent technical domain.

Assign each reviewer a disjoint file such as
`technical-design/reviews/<concrete-teammate-name>.md`. Pass only the task path,
requirement paths, draft path, assigned review path, and write boundaries. Require
reviewers to challenge ownership, end-to-end behavior, change boundaries, contracts,
verification, risks, and simpler alternatives. They must not edit the draft or
another reviewer's file.

Have the TeamLeader adjudicate every finding against code and the clarified
requirement, revise the solution, and write `technical-design/final.md`. Do not use
reviewer votes as the verdict. If review reveals competing architecture choices or
a materially wider boundary, stop the simple path and propose switching to the
three-proposal consultation.

## Run the complex three-proposal path

Load and follow `team-workflow`. Start exactly three independent solution TeamMates
with the common and solution-author identities from
[solution-identities.md](solution-identities.md). Add another only when the task
contains an additional genuinely independent technical domain that the first three
do not cover.

Keep the first proposal round independent: do not let a TeamMate read another
proposal before submitting its own. Assign disjoint files such as
`technical-design/proposals/<concrete-teammate-name>.md`; each TeamMate may edit only
its own file. Parallel writes are allowed because the paths are explicitly
independent.

Require each proposal to ground itself in current code and cover, in proportion to
the task:

- the owning component and end-to-end behavior;
- the proposed change boundary and unchanged boundary;
- reuse, deletion, and new capability decisions;
- relevant contract, data, lifecycle, concurrency, compatibility, or migration
  implications;
- verification and acceptance mapping;
- risks, unresolved facts, and rejected alternatives.

After all proposals settle, send each existing TeamMate a follow-up to read every
proposal and perform one cross-review round. Require each TeamMate to append its
review, accepted and rejected arguments, and revised position to its own file. Do
not let it edit another TeamMate's file.

## Converge or escalate

Treat consensus as the absence of an unresolved disagreement that would materially
change ownership, behavior, contracts, risk, or implementation boundaries. Do not
require identical wording and do not decide by vote count.

Resolve factual disputes through code and evidence. If a real product, architecture,
compatibility, or risk trade-off remains, present the operator with the options,
consequences, and TeamLeader recommendation. Record the operator's decision in the
task, then reconcile the final solution.

Write or update the single authoritative local solution at
`technical-design/final.md` and link it from the task README. Then have the
TeamLeader create or update one public GitHub Issue whose body presents that final
solution for operator review, and record its URL in the task README. The local
final file is the durable solution; the GitHub Issue is the operator review surface
and never a second task-state authority.

Keep the Issue title and body public-safe and self-contained. Do not expose private
transport metadata, internal URLs, internal repository names, or private source
artifacts. Solution TeamMates never mutate GitHub.

Apply operator feedback to the local final first, then update the same GitHub Issue.
If the operator rejects or materially changes the architecture, ownership, public
contract, or core data flow, use the complex three-proposal path again. Reattach the
same three TeamMates: reviewers from a simple path now each produce an independent
proposal, while proposal authors from a complex path revise their own proposal. Run
cross-review and reconcile a new final solution.

## Use the one-file fast path

Skip technical proposal and solution-review TeamMates when all of the following are
true. Skip the GitHub solution-review Issue for this path.

- the expected implementation changes exactly one existing implementation file;
  task-document updates do not count;
- the change is local and mechanically direct;
- it changes no public contract, persisted data, migration, dependency, build
  configuration, security boundary, or compatibility behavior;
- it contains no material technical choice requiring comparison.

One file is necessary but not sufficient. A high-risk or decision-bearing change
uses one of the reviewed paths even when physically located in one file.

For an eligible fast-path task, have the TeamLeader write a brief repair solution
and verification plan to `technical-design/final.md`, link it from the task README,
and proceed to the development-approval gate.
If investigation or implementation reveals a second implementation file or a
material technical choice, stop, mark the fast path invalid, reclassify it between
the simple review and complex consultation paths, and do not let the earlier
approval cover the expanded scope.
