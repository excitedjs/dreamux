# Data-flow ownership continuation

## Authority

The operator continued the same architecture task on 2026-09-29:

- "为啥还是有一些 Deps 类型？这些类型里还是有闭包函数"
- "onPersisted 这种状态同步为啥不能用 eventEmitter 来做呢？"
- "要做就要做到彻底，然后整个数据流这块用闭包是一个非常愚蠢的方案。明明我们有无数种其他的方式。"

This continues R69's architecture-first authorization and supersedes the
TeamLeader's narrower assumption that preserving entity-specific callbacks
was sufficient. The previous pass improved eight areas but did not establish
that the remaining dependency callbacks had justified ownership.

The confirmed product shape decides. Current code and earlier designs are
evidence, not a preservation order. Product behavior decisions remain with
the operator. Delivery continues through reviewed child PRs into PR #453;
merging PR #453 into `next` and its final coverage restoration remain separate.

## Required outcome

Review and reshape the complete inter-component data flow in core services,
runtime providers, and the Feishu channel, including function-valued members
named `Deps`, `Options`, factories, scopes, and callback bags. A field's name
does not narrow this scope. Track its producer, captures, all forwarding hops,
consumer, and actual capability before deciding its disposition.

Remove closures that carry an owner's private state or operations through
other objects, wrap an already available collaborator, or defer a value that
can be fixed at construction. State notifications should be facts published
by their owning module and observed by holders; the operator specifically
identified `onPersisted` and EventEmitter. Queries and operations should have
an explicit authoritative owner and a direct collaboration boundary.

The chosen design must remove the old plumbing. Renaming `Deps`, wrapping each
callback in a one-method object, inserting a global bus/registry between the
same original sides, or moving closures to another file is not completion.
Compare a greenfield design against the existing object relationships before
choosing local adaptations or replacing them.

Ordinary local functional operations and callbacks required at an external
library/protocol boundary are not automatically inter-component ownership
defects. A retained function-valued construction dependency requires a named
real consumer and a reason its owner cannot provide the capability directly.
This distinction is the TeamLeader's scope interpretation, not a blanket
operator exception for existing callbacks.

## Current evidence to investigate

- `onPersisted` travels from Team/Dispatcher through agent construction,
  runtime-state, and identity writes back into the owner's publication method.
  Creation/upsert, status updates, and record-only `closeUnbuilt` all publish.
- `TeamServiceDeps` is derived from the collection's options and forwards
  functions including leader MCP construction, admission, recipient lookup,
  and Team announcement. Trace those alongside sibling Workflow and scheduler
  construction; do not stop at the `Deps` declarations.
- Existing plugin hook objects are wrapped by `applyCreateTeamHook` and
  `announceTeam` closures while `teammateLaunch` is passed as the object itself.
- Workflow construction passes a captured completion recipient and delivery
  callback; initiation, stop, and finalization must be traced together.
- Codex socket allocation receives a closure over paths already carried by
  the runtime. Claude binary resolution is called once during construction.
- The internal `CreateFeishuBotDeps.createTransport` field has no supplying
  production or test caller and no package-root export.
- Provider process/client/session factory options are package-root exports,
  but no in-repository caller supplies them. Exported status does not prove a
  real requirement. Record any proposed public API contraction explicitly;
  distinguish absence of repository consumers from evidence about outsiders.

These are investigation inputs, not an exhaustive accepted fix list. Inspect
the rest of the data flow and correct this list when source contradicts it.
The [baseline construction inventory](data-flow-inventory.md) indexes additional
callable contracts and lifecycle paths that the final solution must classify.

## Behavior and acceptance boundaries

- Preserve create/upsert publication and status-change filtering after a
  successful commit, including creation before a live Agent exists and
  closing an unmaterialized member. Explain event subscription ownership,
  initial state, and listener lifetime without adding replay machinery.
- Preserve Team roster/dispatcher projections, live sibling-worktree queries,
  role-specific MCP/launch behavior, and per-owner completion recipients.
- Preserve admission and shutdown/dissolve semantics, worktree authority,
  completion suppression and retry behavior, and non-blocking inbound #63.
- Preserve restart-time resource allocation and the neutral runtime/channel
  boundaries. Core must not learn provider-native implementation details.
- Do not silently repair the separate deferred product questions in the
  [previous follow-up](ownership-follow-up.md#deferred-behavior-discussion).
- R43 still governs this child PR: no new/repaired unit tests and no test
  deletion to conceal a regression. Report any existing-test incompatibility
  before deciding how it relates to the final parent coverage work.
- Complete all four Rush gates, knowledge checks, a structural deletion
  account, and independent heterogeneous implementation review. Review the
  whole resulting change and every retained function-valued seam.

## Consultation

This crosses several owners and disputes the existing object model. Three
independent proposals and one cross-review round are complete. The consultants
were Claude, MiMo, and DeepSeek, following R70. The TeamLeader adjudicated
their revised positions against source and selected the
[final solution](../technical-design/data-flow/final.md), also published in
[issue #458](https://github.com/excitedjs/dreamux/issues/458). Implementation
continues under the existing R69/R71 authority with one writer.

- [Claude proposal](../technical-design/data-flow/proposals/claude.md)
- [MiMo proposal](../technical-design/data-flow/proposals/mimo.md)
- [DeepSeek proposal](../technical-design/data-flow/proposals/deepseek.md)
