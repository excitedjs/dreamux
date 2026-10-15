# Neutral runtime interface reassessment

## Operator input and authorized boundary

On 2026-10-13, after implementation was delivered but before independent review,
the operator requested a hold and challenged architectural optimality. The next
instruction was:

> 进一步讨论一下，agent runtime 的接口扩展需要格外谨慎。我理解这是对compilation的整个颠覆，但是任何中立 interface 的变更都要慎重

The authorized next action is further architecture discussion, with particular
care around neutral-interface changes. The quoted term is retained verbatim;
this record does not reinterpret it as an additional operator ruling.
Requirement revision 2 supplied the completed consultation's product input.
The current revision 3 consolidates that behavior with Q5: no unsolicited
managed-Team activity stream to Dispatcher, while explicit request replies
remain. No decision removes ordinary-member normal/failed native-result
coverage or changes Workflow/interruption scope.

Preserve the delivered implementation as comparison evidence. Do not implement,
prototype, run tests, correct code, commit, push, dispatch implementation review,
or open a PR during this consultation. The existing three solution seats each
append an independent reassessment to their own assigned proposal file, followed
by one cross-review after all independent submissions settle. The task README
remains the sole current-state authority. Prior approval does not authorize a
materially changed interface/architecture.

## Evidence to distinguish

- `HEAD` is the pre-feature `next` baseline after #473/#469/#467. `git show
  HEAD:<path>` reads that contract without discarding worktree changes.
- The current worktree contains the delivered feature. Its added required
  `AgentRuntimeCreateContext.results` and changed provider emission/EntityTurn
  behavior are the candidate under challenge, not evidence of the old contract.
- `RuntimeSubmission.settled` and `RuntimeCompletion` already exist on the old
  neutral seam. Determine their original ownership, identity, and stop contracts
  from baseline source and the owning task records.
- The old live activity seam is documented as presentation. Determine what
  extending or reusing it would actually change; its mere existence neither
  approves nor rules out a deliberate contract replacement.
- The delivered candidate publishes completed/failed native terminals through
  a synchronous sink and also retains submission settlement reporting, using
  shared completion identity for folding. Compare the meanings and ownership of
  these two observations rather than counting fields or lines.
- Binary tolerance of an extra create-context property, TypeScript source
  compatibility, and fulfillment of the new semantic reporting guarantee are
  separate compatibility claims. An older provider that ignores a sink does not
  acquire background-result coverage merely because it still loads.

Owning source: `packages/dreamux-types/src/agent-runtime.ts` and `activity.ts`;
Core `service/agent/{service,turn,runtime-generation,index,mcp}.ts` and
`service/completion-router/index.ts`; both provider/runtime terminal paths.
Consultation/task history is discovered through the completion-routing and
architecture task README indexes. Current source takes priority over stale KB
descriptions; operator quotations are never stretched into adjacent decisions.

## Required comparison and report

Produce complete end-to-end alternatives against requirement revision 2, without
treating the delivered implementation or earlier consensus as the answer. For
each viable shape, explain:

- what the provider author must know and implement;
- whether a neutral contract changes, and why existing contracts cannot or can
  express the requested behavior;
- the owner of submission answers versus unsolicited native-result facts and
  model-directed reporting, with consumers named;
- once-only identity, mixed bound/unbound order, interruption/failure boundaries,
  owner-stop timing, generation replacement, and owned shutdown convergence;
- exact source, binary, and behavioral compatibility implications for both
  in-tree and external providers;
- which concepts/mechanisms/contracts are removed, which coexist, and whether a
  smaller change actually preserves every accepted capability;
- the strongest concrete counterexample and required verification for each
  option, plus any genuine product decision rather than implementation preference.

Classify what is an unavoidable capability requirement separately from a chosen
transport/interface shape. Give a recommendation and its evidence, without
claiming a globally optimal architecture or treating votes/tests as that proof.
