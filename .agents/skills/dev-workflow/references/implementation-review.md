# Implementation Review and Adjudication

Enter `review` after implementation and local verification are ready and the
operator confirms the stage transition. Obtain an independent review of the complete
current change against the final requirement, approved solution, and applicable
repository guidance.
Record the review target and actual coverage; partial coverage is not a passed gate.

The TeamLeader adjudicates every finding against current source and the approved
boundary. Record each disposition in the task:

| Finding | Accept, reject, or defer | Evidence and reason | Operator ruling affected |
| --- | --- | --- | --- |

Present the adjudication to the operator one finding at a time through an
interactive card, and obtain an explicit ruling before applying corrections.
Approval covers only the enumerated items. New blocking findings require their own
ruling. Reviewer agreement does not replace evidence or operator authority.

If a correction was started without ratification, stop it, disclose the dispatched
scope, and obtain the missing rulings before resuming. A correction that materially
changes the requirement or solution returns through the corresponding stage and
development-approval gates.

Verify accepted corrections against the whole resulting change. Update verification
and adjudication evidence; name any deferred scope and coverage limits. Request
`knowledge-closeout` through a stage-transition card only when no accepted blocking
finding remains unresolved.
