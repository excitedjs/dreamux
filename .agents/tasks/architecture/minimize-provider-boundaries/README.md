# Minimize Core Provider Boundaries

## Current state

- Goal: Reduce the public Agent Runtime and Channel contracts to minimal capability-neutral ports, with Channel bridging external interaction through Core Command invocation and Core event subscription.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/minimize-provider-boundaries/requirement.md)
- Current solution input revision: `requirement.md` SHA-256 `e7683f475f83e1cecfbb78f280d899b611b443e648ea48a3ced09f2e26b8376d`
- Prior solution input revision: `requirement.md` SHA-256 `5e8b6ccb14666ddce48398744c5797fd6008b45979ed63f13edd2967185f628a`; the operator then required failed or empty Feishu bot self-identity resolution to remain retryable on the next inbound message instead of becoming a process-lifetime negative cache.
- Prior solution input revision: `requirement.md` SHA-256 `60319f3d72dc414772a687718923ceea4304dcc0ca82f8fdf0d98dd0ac4af5a3`; it still demanded a persisted Feishu provisioning saga with phases, an outbox, and a restart-resume recovery cursor, which the operator replaced with process-local execution over the Channel's persisted Collaboration Space policy and completed bindings.
- Prior solution input revision: `requirement.md` SHA-256 `217db5fc35801ca54a6af2f9752f1557dd411af4b2dd8b96b0ef3be97adce414`; the operator then required live member cleanup during Team dissolve while allowing cold Identity normalization without Service construction.
- Prior solution input revision: `requirement.md` SHA-256 `4a6b889cd97899fa216c64af57912e98b8f32a0734fd5fa14e707d80d04ba4d4`; the operator then made Team-scoped TeamMates CWD-only borrowers and rejected copying Team worktree facts into their identities.
- Prior solution input revision: `requirement.md` SHA-256 `f0dbdc9d62777ff2176045599c02c2734bd48d685b917bb26ce044b9851b4cc4`; the operator then removed the invented per-Dispatcher stop/restart capability while retaining initial activation and process-level graceful shutdown.
- Prior solution input revision: `requirement.md` SHA-256 `7c4b5c8f13103080426c841586c245a3fce00a141545709eba55db015cf0389c`; the operator corrected a misrecorded decision that had narrowed all Channel input to Team delivery. A Channel supplies `team_name` for TeamLeader delivery and omits it for the existing unmatched-input path to the Dispatcher Agent.
- Prior solution input revision: `requirement.md` SHA-256 `4cf3a6fe591caeac24925d8e72dec84b8d3a0a18f0632a53bd5b6c0707a85d31`; the operator then restored the previously discussed universal MCP delegate architecture: every tool call converges through generic MCP infrastructure and a runtime-bound delegate rather than flattening Team, TeamMate, Cron, or Channel tools into domain Commands.
- Prior solution input revision: `requirement.md` SHA-256 `666386b915db3553fe5436ae6d7def7634917ebf8e708fea79828738907b1b36`; implementation audit then exposed that the canonical `team.submit` interface omitted the Channel attributes and reminder its own target narrative required, incorrectly deferring a known Core contract to Stage 5.
- Prior solution input revision: `requirement.md` SHA-256 `46bea76019056f03daf4e853f130a727b74d106c61ca524fb56decfd762eee76`; the operator then locked the exact seven-field `submitInput` contract and required the concrete field-by-field reduction process to govern every later adjustment, with Core remaining business-agnostic for arbitrary Channel forms.
- Prior solution input revision: `requirement.md` SHA-256 `13e61811a1fbe91e8002739739444ce41e336d0a0376817c32851ba5c2f1fc6a`; the operator then closed Channel presentation entirely through Channel-owned Team/leader anchor state plus Core turn events, deleting `ChannelOrigin`, presentation correlation, and separate `turnOrigin` from Core.
- Prior solution input revision: `requirement.md` SHA-256 `92c8d2148879c03141454a3b96de7151810ba02d72ac5e4ca2f2f80f0e5135ca`; the operator then replaced the unbounded registry of per-entity ledgers with one globally bounded Dispatcher-lifetime ledger keyed by target entity and source ID.
- Prior solution input revision: `requirement.md` SHA-256 `be4cd3202e0971b15b1f5b4fe62c7968f5738f5e2978ab913ed6a280ef8f6417`; the operator then removed the redundant invocation-origin dedupe scope, leaving each target ledger keyed only by its source owner's optional stable ID.
- Prior solution input revision: `requirement.md` SHA-256 `2d659247b6a36c209ee1b3d8c0808637cd3d0659b16d078a351494a3adae4be0`; the operator then made the string-record attributes optional, with omission meaning exactly an empty attribute set.
- Prior solution input revision: `requirement.md` SHA-256 `89ffda2fcfcda22877747c1de1da7f6ff0b79cad2c80827bfeca387e7d22c81d`; the operator then selected an unordered string-record shape for open, validated model-input attributes, with TeammateService owning attribute-value escaping.
- Prior solution input revision: `requirement.md` SHA-256 `344b58191229bfc45cd4e6f610227220f2dd0f7921f3e609e4419664802fec37`; the operator then reserved `system` for Core restart notice, mapped Channel and `admin.sock` input to `channel`, Agent-facing MCP task input to `task`, and model completion delivery to `task-notification`.
- Prior solution input revision: `requirement.md` SHA-256 `9fa223e1c474ff91be61e8e1e259bbc2024d6ae39b5dfbefd254c857f5361f4c`; the operator then kept source names open for future owners, forbidding only `system`, while retaining factual Channel forcing and safe tag-name validation.
- Prior solution input revision: `requirement.md` SHA-256 `707f093860a2ed51f371764eccdb4000c09d57bae4943fb7662dcbddbbe0c9c7`; model-input review then showed that text-only Runtime submission still needs a compact Core source envelope, while parser-grade XML, `<content>`, CDATA code conversion, and per-message reminder duplication are unnecessary for model understanding.
- Prior solution input revision: `requirement.md` SHA-256 `29d1b68baf4e5dc69ad43d8d7a94b76a51ea3a70d2e8e6df59f06189d76ea42b`; the operator then made ordinary input materialization unconditional, removed the three Core input wrappers, and kept scheduler cancellation inside Scheduler rather than leaking `AbortSignal` into the shared submission seam.
- Prior solution input revision: `requirement.md` SHA-256 `dd40eba6529e9bac30607dcbf0d085f22210b76e6d501a00450a082ad2f1fc00`; the operator then scoped the task to fresh installations, declared local Team/Agent runtime state disposable, rejected upgrade migration/backfill/rebuild design, and chose empty defaults without old-record backfill for missing TeamLeader creation inputs.
- Prior solution input revision: `requirement.md` SHA-256 `de13b7478c5f153c22f85029d0cb881459423117ea3c2ff82e8290c9c30850cc`; the operator then made the symmetric constructor-bound persistence roots explicit and rejected any identity-store path re-derivation from logical fields.
- Prior solution input revision: `requirement.md` SHA-256 `d40ca59f624db37e7c97c40c0cd156435233f8054528a8cd02e7e774eaab5a57`; the operator then removed persisted Agent `role` as duplicated runtime topology and deleted the non-product `team_member` vocabulary.
- Prior solution input revision: `requirement.md` SHA-256 `8bce0f28a1146df4a4b14c1286f297350481d314d0a2e48ffe82df615a0bf780`; the operator then separated Team aggregate authority from TeamLeader identity ownership: Team checks only the minimum identity link, preserves an aligned identity, and delegates both missing-identity creation and runtime restoration to `TeamMateService`.
- Prior solution input revision: `requirement.md` SHA-256 `f1058c2c1225dc39c04732a6f5357827eb6d214c0ac3239ca97d9384d8a100be`; the operator then clarified that existing code and historical Decisions are evidence rather than preservation authorities, and that the refactor must remove bad deployed designs in favor of the final product shape.
- Prior solution input revision: `requirement.md` SHA-256 `6c1439342e469dc9c69b7413e84b0b2fd49c5aa13ea01b332cc2f7b74caae3f3`; the operator then defined a valid readable Team record as the sole Team-existence, concrete-name, and accepted-create-idempotency authority, removing the separate request ledger and name claim, and clarified the ordinary Error inheritance model.
- Prior solution input revision: `requirement.md` SHA-256 `366c48bfe81d98f52506b36ee3d6fb723b84e57eb7c97077e95ebce93961b33f`; a later review then over-promoted a narrow hard-process-interrupt window into an automatic partial-Team recovery requirement, which the operator rejected as unjustified complexity.
- Prior solution input revision: `requirement.md` SHA-256 `9379059c23690491a1709af5474f5f48f5aec886b326081f075f49941f1b1f35`; the operator then approved durable candidate rotation when exact name-claim ownership cannot be proven and rejected a speculative registry-wide Command-output byte cap.
- Prior solution input revision: `requirement.md` SHA-256 `aa8dbb4892267f54450fa7822367d2d708f823d902d15177b9b630e335973405`; TeamLeader review then clarified that fixed `delete-on-close` belongs only to Feishu-owned automatic provisioning and must not narrow the generic Team MCP surface.
- Prior solution input revision: `requirement.md` SHA-256 `90eac997bfc4f8427aa464dfa0a95e3de598d8b73164479b5f9e318dc0f77326`; the operator then rejected an artificial lifetime-count limit for never-evicted Team-creation idempotency identities.
- Prior solution input revision: `requirement.md` SHA-256 `acf90312dbeb02861654172943f1fd016de04d6c7c6a6c9c155e78889d0d5f28`; Stage 3 implementation review then exposed that the narrow Feishu provisioning payload had incorrectly replaced the broader existing `team.create` repository capability.
- Prior solution input revision: `requirement.md` SHA-256 `4bbaa002810b3b561626c037fb26b50fe4bfd988887bfeb3574c53650087b26f`; the operator then moved stable source identity and duplicate admission from the Agent Runtime seam to the Core admission owner.
- Prior solution input revision: `requirement.md` SHA-256 `bb41254a1f0e9f07a2626921bf9fdde7e11b7e83d0a19a7946f14b76729290dd`; the operator then removed the replacement submission discriminator and moved external-message XML rendering entirely into Channel.
- Prior solution input revision: `requirement.md` SHA-256 `996580fa8f32fdd09795d79f6639581f4a9e70cdb3cdaf13b66f2b8f8083e9dd`; focused review then recovered the previously omitted ordinary-TeamMate and Workflow prompt sources, and the operator confirmed ordered append-only re-supply across every runtime-context rebuild.
- Prior solution input revision: `requirement.md` SHA-256 `2b3fa58302dca9d533f97a2c92b35cd2b4e74cfcab6846f3a859c744578ade2e`; the operator then made the implementation stop rule explicit: written baselines never silently override unexamined load-bearing source behavior or prior Decisions.
- Prior solution input revision: `requirement.md` SHA-256 `803bf0d086f38c583ba3d146f96de098c828e07bb27ef5b1510e63536da8798d`; implementation review exposed the previously omitted, load-bearing neutral system-prompt replace/append behavior, which the operator restored before Agent Runtime migration continued.
- Prior solution input revision: `requirement.md` SHA-256 `7895d39a7f47c557afb82f8f0bc7c46520566566cc14557bae5572d646bd5e2c`; the operator subsequently retained the explicit Collaboration Space user flow as a Feishu Channel-owned MCP and provisioning policy without restoring the deleted Core container.
- Prior solution input revision: `requirement.md` SHA-256 `349635060d19afe73ed3d1e84df5070bce225364553389f5074c624180598a07`; the operator subsequently specified the complete Channel-MCP registration/forwarding path and unified `admin.sock` with Channel invocation through one unrestricted, domain-namespaced Core Command registry.
- Prior solution input revision: `requirement.md` SHA-256 `527711f503b9a948a1e5eb0b58187b6736abeae3b9f7fb74084a4793df47642e`; the operator subsequently unified Agent state as `teammate.state`, added redundant member summaries to `team.state`, and namespaced the submit Command as `team.submit`.
- Prior solution input revision: `requirement.md` SHA-256 `89e95d7fb3fd0dcf5585484becbd529a34d6d425e73aae500a31595210a5433c`; the operator subsequently namespaced the complete TeamMate turn-event family as `teammate.turn.*`.
- Superseded solution input revision: `requirement.md` SHA-256 `28ecbb5363f0d0faa2a696a6bf0eb0670192c89e7c778241c37aafecc5a3fbdc`; third-round review temporarily reopened a binding-reconciliation concern whose independent-offline-Channel premise the operator rejected.
- Independent review: [Consolidated findings](/.agents/tasks/architecture/minimize-provider-boundaries/review-findings.md)
- Verification: [Current verification record](/.agents/tasks/architecture/minimize-provider-boundaries/verification.md)
- Defensive-recovery review guide:
  [Durable-fact recovery principles](/.agents/tasks/architecture/minimize-provider-boundaries/durable-fact-recovery-principles.md).
- Solution consultation:
  [Codex proposal and cross-review](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/proposals/codex.md),
  [Claude proposal and cross-review](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/proposals/claude.md), and
  [Trae Seed 2.1 proposal and cross-review](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/proposals/trae-seed-2-1.md).
- Current solution baseline: [Technical design](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/final.md), SHA-256 `374dd8d96bd36df12ff60e42d7854e79ec24cf2d8bbf35aeec5655a2d8434900`. Requirement text, technical design, current source, and prior Decisions are evidence; the final product shape and explicit operator principles are authoritative. Existing load-bearing code has no automatic preservation right.
- Prior final-solution revision: SHA-256 `20760aaaaf90526685bfb2818c59df10bcdd6544416521aba1e715440f6015ca`; it did not yet specify that Feishu bot self-identity failures remain unresolved and retry on the next inbound message before mention gating.
- Prior final-solution revision: SHA-256 `01d26442d6ce37660139f869bc1f3a9e42a60b5521bc4aa95f9e16941b37da6c`; it still specified the persisted Feishu provisioning saga and let a Channel invoke Core Commands to resume it at startup, before automatic provisioning became process-local execution.
- Prior final-solution revision: SHA-256 `90917acb1b38072437fba3fff2f62b23e58670ebea4a9ddaf8b5a5ba17ebecfc`; it had not yet separated live-member runtime close from cold member Identity normalization during Team dissolve.
- Prior final-solution revision: SHA-256 `40369754e08d5920125c059858261997b54163c1ca0b53df5d00c27305025742`; it had not yet made Team-scoped TeamMates CWD-only borrowers or rejected Team worktree cleanup projection into their identities.
- Prior final-solution revision: SHA-256 `aa91e17740863fb8638f7e23468646e415e38c6a6b802da9b175c6ba327032fa`; it still exposed `dispatcher.stop` and therefore implied a per-Dispatcher stop/restart lifecycle that the operator never designed.
- Prior final-solution revision: SHA-256 `5c74dc37bf0681b2c8e722a3cab3cf1c7b240395a8007b73b6586c9c6b80a05e`; it incorrectly expanded the Team-route requirement into a ban on unmatched Channel delivery to the Dispatcher Agent and keyed local presentation only by Team/leader identity.
- Prior final-solution revision: SHA-256 `54034bc0deefeefdff1310ad431bce69e512329a02c5fc42f64945f8130b7b4c`; it correctly modeled a Channel MCP lease but failed to generalize the same delegate boundary to Team, TeamMate, Cron, and other Agent-facing MCP servers, leaving their shims incorrectly mapped to domain Commands.
- Prior final-solution revision: SHA-256 `e87f24cc1ca224407398f9b73212fb058d875a7e9f234cf6cf6dc09557b439da`; it locked `submitInput` but its `team.submit` interface still omitted the already-confirmed Channel attributes and reminder, contradicting the surrounding delivery contract.
- Prior final-solution revision: SHA-256 `54bfc6b43ce9ad37c058fbbafe1ff2e4a726f0413b9bd200ffe01147afd4d10f`; it had converged the generic envelope semantics but had not frozen the complete `submitInput` signature or recorded the concrete review sequence as the mandatory method for later surfaces.
- Prior final-solution revision: SHA-256 `dd23103bcdbcb5c79dd02c02feef498b4079961867e7a96e95f362b08f34b520`; it still routed Channel presentation anchors through Core Turn/Event metadata instead of using Team/leader identity and `turn_id` to close the loop inside Channel.
- Prior final-solution revision: SHA-256 `e498c30da2342e8ca96af2158e09cab8322ce9099dfde7ee5cca40d1408d1d2a`; it removed origin scope but still retained a child ledger for every entity ever hosted by a Dispatcher process, leaving historical-entity memory unbounded.
- Prior final-solution revision: SHA-256 `0ed6a016612fcc4cfea3a5dc9ff144c0f4e03629e3cc3d2f995e4033a0e63a87`; it still carried an invocation-origin scope beside the source ID even though the ledger was already per target and source owners already produce stable IDs.
- Prior final-solution revision: SHA-256 `84701d83c687b3f601ff4026d589c005d107d7ee8adea0678e181536e633a7d9`; it fixed the attribute record shape but had not yet made omission exactly equivalent to an empty attribute set.
- Prior final-solution revision: SHA-256 `3e54aeb6c5022df4d4c556189e1e8ad6cbacd62002ff0d10d3ca715f8b71ee1f`; it assigned source defaults but had not yet fixed `attrs` as an unordered duplicate-free string record with open safe names.
- Prior final-solution revision: SHA-256 `b3ef537758c8366a2aa6913f99fd599788a385335478e4fa78a94bd15a45f5a4`; it kept source names open and rejected `system` universally before the operator reserved it for Core restart notice and assigned the initial source defaults.
- Prior final-solution revision: SHA-256 `eccef89bc71a38c6486177e448087aac46d00cd183ea23295a9293ff0b94aa4c`; it described source as a closed Core vocabulary before the operator selected open safe source names with only `system` forbidden.
- Prior final-solution revision: SHA-256 `af51c5423298f9a4776e620ae1d92ec2e1712a2b78ab55e9353f69194768bb0e`; it unified Core submission and removed scheduler cancellation leakage but still treated every caller as supplying complete final text rather than having TeammateService assemble the compact model-facing source envelope.
- Prior final-solution revision: SHA-256 `a9574d1bcc59b49f0e983ba9f554240f06057a5cdde0cff7a8bea88c384441d4`; it still exposed three `TeammateService` input wrappers, a caller-selected reopen flag, and a scheduler `AbortSignal` whose only purpose was the already-rejected held-fire mechanism.
- Prior final-solution revision: SHA-256 `71831201a09e3e5e408aa1d3f2a815f14237ec8ade5adfcf10c3cb95988051eb`; it had not yet made the fresh-install-only state policy explicit or named the TeamLeader identity prompt and normalized skill sources as the minimal stable Team-owned reconstruction inputs.
- Prior final-solution revision: SHA-256 `786f046223bfb6883e3f2605bd60147035aecfd5945edb45189e1448e5c94bee`; it removed persisted role but had not yet prohibited the dispatcher-wide Store from flattening the object graph and recomputing paths that constructors already owned.
- Prior final-solution revision: SHA-256 `e861e80b250b21fedac5796ccf4cd08d97b0ba74f8a783e38cb2647d8301bba7`; it still treated identity `role` and `team_member` as persisted ownership evidence rather than deriving runtime context from the owning Service, Collection, and directory scope.
- Prior final-solution revision: SHA-256 `c2332ef6a78aecd35776d552e6301c66e7022bf7e25571f2518db4bc243b44ef`; it treated an incomplete accepted Team as a fail-loud terminal state and had not yet separated minimum Team-to-identity validation from TeamMate-owned identity creation and restoration.
- Prior final-solution revision: SHA-256 `a042a5946bb121357e472fb3e20c508994aeab82fa562c2680c7621138c80d2b`; it removed the extra Team-creation authorities but still described existing load-bearing source and historical Decisions too strongly as preservation constraints.
- Prior final-solution revision: SHA-256 `6a828b277a1b3b65609450c067fc8dab898e650924bebaa7e7e90ef8491cbce5`; it still persisted a Team-create request ledger and name claim before a Team existed, and did not yet capture the approved Error inheritance and shutdown-race semantics.
- Prior final-solution revision: SHA-256 `3a36054580b35bfd5427d0b35dfd074f3bd1a56856fa2adbc0b0f5fa546593d0`; it had not yet made the narrow hard-interrupt boundary and fail-loud incomplete-Team behavior explicit.
- Prior final-solution revision: SHA-256 `7cafa98baf5b48ddb885faea94c7daafbcfc6c539a3594b9245442091108bc84`; Stage 3 review then over-defended unprovable name claims as fatal and proposed a generic output-size limit without a concrete domain failure.
- Prior final-solution revision: SHA-256 `b0c37c9c24ce84e56e1805019ce3a95ebfbe7ff57049e7bf0a4ff7f25c89d339`; its wording could be misread as narrowing the generic Team MCP creation tool to Feishu's local repository subset.
- Prior final-solution revision: SHA-256 `ef90aec0bf56975f354452489701ec4617778ed0c838da797be9c3080cde014b`; it still imposed a configured hard count on identities that could never be safely evicted.
- Prior final-solution revision: SHA-256 `30fa81118a9008eb28d171113bc87cb9e5acfe9fbf78d3028efd49aa67c28010`; it modeled only Feishu's minimal managed-repository subset and therefore did not preserve the complete existing `team.create` repository union.
- Prior final-solution revision: SHA-256 `3a4d76b35345cb37197c9eb519f0806275c48e3bbf5afcdd2700e8353c0f1647`; it still placed stable source identity and duplicate admission inside the Agent Runtime Provider seam instead of the Core admission owner.
- Prior final-solution revision: SHA-256 `e8dc75bade851fa27cf8ad4d67b2885267bbac2891182f039c412513aed29ff1`; it still recreated the deleted Channel/completion split as submission `kind` variants and left XML rendering below Channel ownership.
- Prior final-solution revision: SHA-256 `c456165258757c1ea6df8a753691d118b691fca379e65205f9c3450395e7c452`; it restored the neutral replace/append object but had not yet modeled ordinary-TeamMate and Workflow prompt sources or explicit re-supply on every runtime-context rebuild.
- Prior final-solution revision: SHA-256 `137db732ebdcd07f902f1b31d45682610f656d240bbad831e3b9744af8a7fdda`; it restored system-prompt semantics before the operator made the stronger current-code conflict stop rule explicit.
- Prior final-solution revision: SHA-256 `62e48dc31ea49356b0836abb2bf73523591989d57a199bb8266ab59061b6477d`; it incorrectly flattened the load-bearing system-prompt replace/append pair to one string.
- Implementation plan: [Staged implementation ledger](/.agents/tasks/architecture/minimize-provider-boundaries/implementation-plan.md)
- Prior Fable audit: `READY` for requirement SHA-256 `803bf0d086f38c583ba3d146f96de098c828e07bb27ef5b1510e63536da8798d` and final-solution SHA-256 `62e48dc31ea49356b0836abb2bf73523591989d57a199bb8266ab59061b6477d`.
- Solution review Issue: [#349 Architecture: minimize Agent Runtime and Channel provider boundaries](https://github.com/excitedjs/dreamux/issues/349)
- Solution workflow: Complex three-proposal consultation with one independent round followed by one cross-review round; selected by the operator through the Team's bound channel on 2026-08-27.
- Blockers: None. Channel and Core are same-process and lifecycle-coupled; no
  independent Channel offline/reconnect, remote state synchronization, startup
  Team-read reconciliation, snapshot, or replay model is required.
- Stage 3 operator decision: the canonical `team.create` Command preserves the
  complete existing repository union (`reuse-cwd` or configurable `managed`).
  Feishu maps its smaller path/base-ref policy into managed mode with fixed
  `delete-on-close`; consumer minimalism must not narrow the shared domain
  capability.
- Stage 3 operator decision: a valid readable Team record is the sole proof of
  Team existence, sole concrete-name owner, and durable home of accepted
  `team.create` request identity and payload hash. Exclusive atomic record
  publication is the acceptance point. Missing, malformed, or unreadable records
  are `TEAM_NOT_FOUND` and reserve no name; no separate request ledger, name
  claim, or tombstone remains.
- Stage 5 audit decision: Team-record validity covers exactly the facts required
  to establish Team existence and, when no aligned Identity exists, to recreate
  the TeamLeader from the Team-owned creation snapshot. The reader validates the
  directory-bound Team identity, leader name, lifecycle status vocabulary,
  leader runtime, repository and runtime directories, worktree identity,
  identity prompt, and normalized skill sources. A record missing or corrupting
  one of those facts is not a Team and reserves no name. This is not a generic
  deep-schema defense: do not add speculative length limits, migration,
  repair, backfill, or validation of unrelated presentation fields.
- Stage 3 operator decision: Command failures use ordinary Error inheritance.
  `DreamuxError` owns stable codes; generic validation, real cross-process
  transport, and unknown internal failures have reusable subclasses, while
  business errors extend `DreamuxError` directly. There is no `DomainError` or
  public layer taxonomy; MCP renders known errors consistently for models.
- Stage 3 operator decision: `TransportError` uses stable
  `TRANSPORT_ERROR`, not `BAD_REQUEST`; connection, timeout, closed-socket, and
  malformed-response failures are transport failures. Team not-found, closed,
  and generation-changed failures remain distinct, operation-independent
  business errors rather than one reason-tagged `TeamUnavailableError`.
- Stage 3 operator decision: the shared Command registry validates output JSON
  representability and schemas but adds no speculative global result-size cap;
  pagination and size policy remain with domains that have a real need.
- Stage 3 operator decision: Team and TeamLeader identity have distinct narrow
  authority. Team state decides whether the aggregate and leader should exist;
  TeamLeader identity is the sole runtime-reconstruction input. The Team record
  keeps only stable Team-owned input needed to invoke leader creation, never
  Provider session or mutable Agent state. Check only the minimum ownership
  link. Preserve an aligned identity exactly and let `TeamMateService` restore
  from it. For an active Team with no usable aligned identity, the Team layer
  calls the normal TeamMate creation path; `TeamMateService`, not the Team layer,
  creates identity as part of creating the TeamLeader. Continue `starting`,
  restore `running`, and never restart `closed`; add no direct cross-store repair
  or third durable recovery mechanism.
- Stage 3 operator decision: preserve the existing shutdown sequence. Close the
  shared Command admission fence, converge Dispatcher shutdown, drain accepted
  Command calls, then close the socket. A request racing the fence receives a
  specific `ServerShuttingDownError`.
- Stage 3 operator decision: state below a Team scope is meaningful only under a
  valid Team record. Orphan TeamLeader identity or other subordinate files do
  not block concrete-name reuse, and an in-memory snapshot cannot resurrect a
  Team whose record is invalid or unreadable. Once a valid record exists,
  identity reconciliation follows the distinct Team-versus-identity authority
  above rather than blindly overwriting a matching identity.
- Stage 3 operator decision: Agent identity does not persist `role`. Dispatcher,
  TeamLeader, Dispatcher-scoped TeamMate, and Team-scoped TeamMate context is
  already owned by `DispatcherService`, `TeamService`, their respective
  `TeammateCollection`s, and the directory hierarchy. Runtime consumers derive
  `dispatcher`, `team_leader`, or `teammate` from that owner context.
  `team_member` is deleted from persisted types, internal vocabulary, and public
  event values without a compatibility alias.
- Stage 3 operator decision: persistence location is constructor-owned.
  `DispatcherService` binds the Dispatcher state root, passes `teammate/` and
  `team/` roots to its Collections, `TeamCollection` passes each concrete Team
  root to `TeamService`, and `TeamService` passes its `teammate/` root to its
  Collection. A collection appends only the entity name; a `TeamMateService`
  receives the resolved entity directory. Identity contents never select or
  re-derive their own path.
- Stage 3 operator decision: target a fresh installation and do not design
  old-state upgrade behavior. Team records, Agent identities, and subordinate
  Dispatcher runtime state are disposable operational data; there is no
  migration, lazy backfill, compatibility reader, or rebuild workflow for old
  shapes. New Team records retain the normalized TeamLeader identity prompt and
  skill sources needed for missing-identity creation. Aligned identities remain
  untouched. If those fields are absent, they read as empty and are never
  backfilled from Identity.
- MCP architecture decision: Agent-facing MCP tools never flatten into the
  domain Command registry. Every official-SDK shim sends actual calls through
  one generic `mcp.toolcall` infrastructure Command using an opaque
  runtime-generation lease. Core resolves an `McpServerDelegate`; internal
  delegates call owning service objects directly, while Channel delegates call
  registered live/sessionless Channel handlers. The delegate, not the shim or a
  domain Command alias, owns caller context, task source, completion behavior,
  visibility, and model-facing errors. `mcp.describe` supplies the delegate's
  validated catalog to the generic shim.
- Stage 5 audit decision: Feishu automatic provisioning is volatile execution,
  not durable product state. The Channel persists Collaboration Space policy
  and completed target bindings only. It does not persist provisioning rows,
  request phases, an outbox, a recovery cursor, or a restart-resume scan. A Team
  exists exactly when its valid Team record exists. If the process stops before
  a binding is committed, the unfinished operation disappears; after restart an
  unmatched target follows the ordinary Dispatcher-Agent delivery path.
- Stage 5 audit decision: Collaboration Space policy updates use memory-only
  snapshot semantics for already-started work. A Team creation accepted before
  an update continues with the runtime, identity, and repository snapshot it
  captured; a creation accepted after the update uses the new current snapshot;
  existing Teams are never rewritten. Generation identifies a policy snapshot
  and is not a cancellation token. Losing the process loses the in-flight
  snapshot and requires no recovery.
- Stage 5 audit decision: `unbind_collaboration_space` affects future automatic
  provisioning only. An in-process creation that already captured a policy
  snapshot continues and may commit its completed binding; later unmatched
  targets have no policy and go to the Dispatcher Agent. Do not add a
  cancellation flag, generation re-check, cleanup branch, or removal of an
  already-published Team record merely to make unbind interrupt an accepted
  function call.
- Stage 5 audit decision: every Feishu inbound message whose non-admission is
  proven still has the Dispatcher Agent as its fallback recipient. Automatic
  provisioning failure before `team.submit`, and a typed pre-admission
  `TEAM_NOT_FOUND` or `TEAM_CLOSED` rejection, therefore deliver the original
  message once to the Dispatcher Agent. An ambiguous result or unknown failure
  after submission does not prove non-admission and must not trigger a second
  delivery. Do not replace this acceptance boundary with a blanket retry or a
  blanket no-fallback rule.
- Stage 5 audit decision: moving external binding ownership into Channel does
  not remove a TeamLeader's existing self-service routing capability. Feishu
  advertises `bind_channel` and `unbind_channel` to TeamLeader callers as well
  as the Dispatcher. The Dispatcher form may name any Team. The TeamLeader form
  has no caller-selected Team field: it uses the Team identity already bound
  into the MCP lease, may bind only to itself, and may release only a target
  currently bound to itself. Collaboration Space administration and the global
  binding listing remain Dispatcher-only. Do not restore a Core binding store
  or smuggle a caller-selected Team through the Channel seam.
- Stage 5 audit decision: when `team.state` proves a Team closed, Feishu removes
  every binding to that Team, notifies each removed target with the existing
  binding-unbound presentation, and releases that target's COT route state.
  This preserves the user-visible close transition after binding ownership
  moved out of Core. Typed stale-route cleanup during an inbound fallback stays
  silent so one failed delivery does not generate an unrelated notification.
- Stage 8 ownership decision: the public dissolve result is a submission
  receipt, not a logical-close receipt. After Core validates the caller and
  installs one Team-owned background operation, MCP and Command surfaces return
  immediately with `status: "submitted"`; they do not await worktree assessment,
  runtime stop, durable close, or physical deletion. The generic shim remains
  caller-blind. Core's lease-bound Team delegate alone resolves Dispatcher versus
  TeamLeader authorization and target, then both paths enter the same TeamService
  submission capability. Requester kind may change assessment/stop ordering but
  may not create two return mechanisms. Repeated submissions must not duplicate
  destructive work; Promise identity is not itself a product requirement.
  The Channel uses the removed rows it already owns; do not restore Core binding
  events, add persisted notification state, or make notification failure undo
  the committed route removal.
- Stage 5 audit decision: persisted Feishu routing facts become live only after
  their atomic file write succeeds. An update is prepared against an isolated
  next document, serialized with other writes, persisted, and then published as
  the session's in-memory current value. A failed write leaves the prior value
  live, so a reported failure never secretly changes routing or becomes durable
  through an unrelated later write.
- MCP invoke infrastructure decision: shim communication is synchronous generic
  request-response, never event delivery. A shim calls a transport-neutral JSON
  `invoke` facility, which invokes the ordinary `mcp.toolcall` Command through
  `admin.sock` and returns that invocation's JSON result on the same call. The
  reusable invoke request/result and failure boundary belong in shared
  infrastructure such as `dreamux-utils`; they know no Command name, MCP tool,
  Team, or Channel. Dreamux Core owns Command registration and socket binding.
  A delegate or Channel tool returns an explicit JSON success or public failure;
  the generic MCP shim alone converts that result into the official SDK's MCP
  tool result. Expected public failures must tell the model what was wrong;
  unknown thrown implementation failures remain sanitized.
- Stage 8 audit decision: an MCP server name is a provider-neutral logical
  identity. Core may compose the complete server set and reject duplicate names,
  but it must not constrain or encode those names from Codex TOML, Claude Code
  JSON, or any other Runtime's native configuration grammar. Each Agent Runtime
  adapter quotes or escapes the unchanged logical name when it renders its own
  native config. Adding a Runtime with a different grammar must not require a
  Core naming change, and a more permissive Runtime must not inherit another
  Runtime's restrictions or model-visible namespace transformation.
- Stage 8 type-boundary correction decision: before any broader Service
  redesign, correct only the two confirmed lint-derived type seams.
  `TeamServiceDeps` must be a lower, neutral contract and must not import the
  concrete `TeamService` implementation that consumes it. The Codex runtime
  dependency contract must remain internal to that adapter and must not appear
  as a public package capability merely because moving its declaration kept
  `runtime.ts` under the line limit. This correction must not change runtime,
  Team, or TeamMate lifecycle behavior, add a compatibility export, or move
  implementation logic merely to reduce a file's physical line count.
- Stage 8 Service simplification review decision: after the two type-boundary
  corrections are implemented, verified, and published, two fresh independent
  read-only reviews -- one Codex Ultra and one Claude -- will reconstruct
  `TeamService` and `TeammateService` from current source. They must enumerate
  every mutable state, fence, ledger, phase, and state transition; identify its
  real authority, producer, consumer, and product or persisted-data consequence;
  and distinguish essential lifecycle ownership from defensive machinery.
  `TeammateService` starts from the desired hypothesis that it is the minimal
  mapping between a Core Agent entity and a neutral `AgentRuntimeProvider`, but
  neither reviewer may accept that hypothesis without testing it against real
  creation, admission, settlement, recovery, completion, and shutdown paths.
  This is consultation only: no Service state machine or implementation is
  changed until the operator reviews the evidence and approves a design.
- Stage 8 Service ownership correction decision: the operator accepted the
  symmetric Collection + Service model as the implementation target.
  Collections own stores, factories, lookup/list, cached instances,
  materialization deduplication, and exact-instance eviction after terminal
  entity facts. Services own one entity's record or identity, operations,
  Runtime-backed work, and close. `TeamService`, not `TeamCollection`, owns Team
  dissolve; `TeammateService` owns one neutral Agent Runtime mapping; and
  `WorkflowService` owns Workflow-specific records, execution, leases, recovery,
  and terminal outcomes. Entity operations prefer Promise identity over phase
  machines, update durable facts through one owner-local record mutation path,
  and publish terminal events only after the durable fact exists. The shared
  `deduplicate` decorator exposes only `type: 'active'` and `type: 'once'` as
  Promise-retention behavior. It adds no lifecycle validation, persistence,
  policy, or error surface.
- Stage 8 Workflow ownership decision: a Team-scoped `WorkflowService` may
  create members only through a narrow `createLocked` capability backed by its
  owning Team's `TeammateCollection`. The Workflow holds only
  `LockedTeammate` handles and releases them at terminal cleanup; it never owns
  or constructs `TeammateService`. Delete the defensive
  `TeamCollection.withTeamLeaderLease -> TeamService` round trip: Workflow
  admission and `stopAll()` own convergence, while the current Team's
  `TeammateCollection` already owns member creation and registration.
- Stage 8 terminal-entity decision: Collections cache live objects only. Closed
  Teams and TeamMates remain persisted records and read paths project those
  `TeamRecord` or Agent Identity records without constructing Services. Startup
  never rebuilds a closed entity. A closed Team is never rematerialized,
  including for worktree cleanup; cleanup reads and patches its record directly.
  A closed TeamMate may be lazily constructed only by `send`, which reopens it
  in the same operation, and is published to the cache only after it becomes
  live. Historical usage must not cause unbounded entity-object retention.
- Stage 8 deletion authority: the implementation author may remove existing
  defensive state, phases, checks, wrappers, errors, recovery branches,
  registries, ledgers, and helper objects whenever current source cannot prove
  a real consumer and product or persisted-data consequence. Deployed code has
  no preservation right, and unjustified machinery must not be renamed,
  relocated, or replaced with an equivalent abstraction. Promise identity, one
  owner-local durable mutation path, terminal facts, and owned resources are the
  default primitives.
- Stage 8 Dispatcher lifecycle correction: `dispatcher.stop` was an invented
  public capability rather than an operator-designed product behavior. Remove
  it from the Core Command registry, admin-socket mapping, CLI, help, and
  maintenance guidance. `dispatcher.start` remains only for initial activation;
  it does not imply a supported stop/restart cycle. Internal resource stopping
  remains part of daemon/server graceful shutdown and failed-start rollback.
- Stage 8 Team workspace ownership correction: a Team's worktree state belongs
  only to its `TeamRecord`. TeamLeader-created TeamMates are CWD/reuse-cwd
  borrowers with cleanup `keep`; their identities never copy the Team's managed
  worktree metadata or cleanup result, and closing a member cannot clean the
  Team workspace. Dispatcher-scoped TeamMates retain independent managed
  worktree ownership and close/reopen behavior when explicitly requested.
- Stage 8 Team member dissolve correction: Team dissolve closes every cached
  live member through its `TeammateService` so its runtime and turns stop. The
  Team-owned `TeammateCollection` writes dormant non-closed identities directly
  to the same terminal timestamp and note without constructing Services;
  already-closed identities remain unchanged. This bulk capability is private
  to the Team and creates no Dispatcher-facing lifecycle surface.
- Implementation authority principle: existing design is not the target by
  default. The TeamLeader challenges why each mechanism exists and retains it
  only when it serves the confirmed final product. Deployed, load-bearing, or
  historical bad designs are removed during the refactor; only genuinely
  unmodeled product choices return to the operator.

## Architecture review method: the `submitInput` case

Every remaining adjustment must repeat the concrete review sequence that
converged `TeammateService.submitInput`; a plausible existing field or wrapper is
not evidence that it belongs in the final contract.

1. Enumerate every real producer and consumer before preserving the surface.
   This exposed Channel, cron, Agent task, task-notification, admin, and restart
   inputs, while confirming that Agent Runtime itself consumes only final text.
2. Compare wrappers by behavior rather than name. `channelInput`,
   `scheduledInput`, and `controlInput` all reached the same admission and text
   submission path, so they became one operation. Scheduler cancellation stayed
   with Scheduler; the cross-service `AbortSignal` disappeared.
3. Separate model-facing content from Core-only control facts. Model provenance
   needs `source`, optional string `attrs`, faithful `text`, and optional final
   `reminder`. Duplicate identity, recovery intent, and completion delivery stay
   outside the rendered envelope.
4. Challenge every extra field by asking who produces it, who consumes it, and
   what observable behavior changes without it. This removed `scope`, opaque
   correlation, `turnOrigin`, caller-selected `reopenClosed`, and logging labels.
   `sourceId` survived only because a real source owner supplies it for bounded
   process-local duplicate admission; `intent` and `deliverCompletion` survived
   only for their distinct accepted-turn and completion behaviors.
5. Trace lifetime and ownership, not just types. Replacing per-entity ledgers
   with one globally bounded Dispatcher-lifetime ledger removed historical
   entity retention. Channel presentation closed through Channel-owned
   Team/leader anchors plus pushed `turn_id`, so no presentation token crossed
   Core.
6. Test the model-facing representation with actual model reviewers, then pay
   only for demonstrated clarity. The result kept one paired source tag and an
   optional sibling `<reminder>`, while deleting parser-oriented `<content>`,
   CDATA/XML code conversion, body escaping, pretty indentation, and repeated
   reminders. Markdown code fences remain faithful.
7. Lock the contract only after every survivor has one independent use. The
   resulting signature is exactly
   `{ source, attrs?, text, reminder?, sourceId?, intent?, deliverCompletion? }`;
   future changes must reopen this reasoning rather than append another field or
   compatibility wrapper by proximity.
8. When one field still needs adapter-specific explanation, re-check the whole
   call topology instead of adding transport metadata. The apparent conflict
   between `channel` and `task` exposed that MCP shims had been incorrectly
   flattened into domain Commands. Restoring one generic MCP tool-call Command
   plus runtime-bound delegates removed the conflict at its real boundary.

For every later refactor surface, the TeamLeader must perform the same producer,
consumer, behavior, ownership, lifetime, model-clarity, and failure-semantics
audit; challenge the Developer when any answer is missing, and return only a
genuinely product-shaping choice to the operator. Core itself stays absolutely
generic: it provides the open envelope and admission mechanisms but never
interprets Channel, cron, task, or any future source's business meaning and
never branches on a concrete source name.

## TeamLeader failure ledger for the final Fable audit

This ledger records confirmed TeamLeader mistakes during this refactor. It is
not a list of hypothetical risks and it is not a preservation list for the
current implementation. Each item names a reasoning failure that already
produced an incorrect requirement, design, implementation direction, or review
instruction. The final Fable audit must inspect the complete current diff for
every item below, identify every surviving instance line by line, and then look
for additional instances of the same failure patterns. Passing this checklist
does not imply that the diff is clean.

1. **Treating existing design as authority.** I initially asked the Developer
   to preserve deployed mechanisms and historical Decisions without first
   proving that they belonged in the final product. That inverted the refactor's
   authority: current code and history are evidence, while the confirmed final
   product shape is authoritative. Fable must challenge every compatibility
   shim, preserved wrapper, copied state machine, and "load-bearing" mechanism
   that has no independent product behavior.
2. **Designing upgrade compatibility for disposable state.** I spent review
   effort on old-record migration, backfill, aliases, and rebuild behavior after
   the operator had scoped this work to fresh installations and declared local
   Team and Agent runtime state disposable. Fable must find any compatibility
   reader, lazy backfill, migration branch, or old-shape fallback that survived
   without an independently confirmed product need.
3. **Creating durable Team-creation coordination outside the Team record.** I
   accepted a request ledger, name claim, tombstone-like ownership, and
   hard-interrupt recovery around Team creation. These mechanisms made
   intermediate execution state compete with the valid readable Team record,
   which is the sole Team-existence, concrete-name, and accepted-request
   authority. Fable must search for every persisted claim, reservation, request
   ledger, partial-Team recovery record, or name owner outside `record.json`.
4. **Promoting narrow interruption windows into product recovery.** I repeatedly
   treated "the process can stop between two awaits" as a requirement to resume
   or compensate the interrupted operation. The product explicitly permits
   volatile intermediate work to disappear. Fable must reject recovery,
   replay, scanning, compensation, and repair state whose only justification is
   preserving an unfinished in-process operation.
5. **Persisting runtime topology as Agent identity.** I accepted persisted
   `role`, invented the non-product `team_member` vocabulary, and allowed
   identity contents to select storage location. Runtime role and path already
   follow from the owning Service, Collection, and constructor-bound directory
   hierarchy. Fable must find persisted role fields, role-based path selection,
   dispatcher-wide identity path re-derivation, and any remaining
   `team_member` concept.
6. **Confusing Team authority with TeamLeader identity authority.** I proposed
   Team-side identity synthesis, overwrite, and repair instead of checking only
   the minimum Team-to-identity link and delegating identity creation or runtime
   restoration to `TeamMateService`. Fable must find Team code that stamps,
   merges, rewrites, or reconstructs identity rather than preserving an aligned
   identity or invoking the normal TeamMate creation path.
7. **Preserving submission wrappers and fields by proximity.** I retained
   `channelInput`, `scheduledInput`, `controlInput`, caller-selected reopen,
   `scope`, opaque correlation, `turnOrigin`, logging labels, and a leaked
   scheduler `AbortSignal` before proving distinct behavior or consumers. Fable
   must enumerate every producer and consumer of the final submission surface
   and reject any wrapper or field without an independent behavioral effect.
8. **Optimizing model input for an XML parser rather than the model.** I
   accepted `<content>`, CDATA conversion, XML entity rewriting of the body,
   pretty indentation, and repeated per-message reminders. These changed or
   inflated the user's text without demonstrated model benefit. Fable must
   verify faithful body and Markdown-code preservation, one compact paired
   source envelope, attribute-value escaping only, and at most one optional
   sibling `<reminder>`.
9. **Giving duplicate admission the wrong lifetime and dimensions.** I accepted
   one ledger per historical entity and a redundant invocation-origin scope,
   creating unbounded retention and duplicate keys for facts already owned by
   target plus source ID. Fable must prove one bounded Dispatcher-lifetime
   ledger, no per-entity registry growth, and no scope or origin dimension that
   lacks a separate deduplication meaning.
10. **Smuggling Channel presentation correlation through Core.** I tried to
    preserve `ChannelOrigin`, presentation correlation, and manual anchors in
    Core instead of closing presentation through Channel-owned state and pushed
    `turn_id` facts. I later accepted a per-session, per-Team anchor mutex that
    could not distinguish the same Team's events broadcast to multiple Channel
    sessions. Fable must reject Core presentation tokens and prove exact
    Channel-local association by the returned and emitted `turn_id`, including
    concurrent sessions bound to the same Team.
11. **Flattening Agent-facing MCP tools into domain Commands.** I initially
    treated shims as direct aliases for Team, TeamMate, Cron, and Channel
    Commands, despite the required generic `mcp.toolcall` boundary and
    runtime-bound delegate. Fable must prove that generic MCP infrastructure is
    business-blind and that each delegate owns its catalog, caller context,
    source, completion behavior, authorization, and direct owning-object call.
12. **Deleting unmatched Channel delivery by misreading a Team-specific
    statement.** I rewrote the requirement so every Channel input required a
    Team and unbound input was dropped, even though the operator only said that
    a delivery *to a Team* necessarily has a Team or leader name. This error was
    introduced in commit `4655d6593a90262126c684559800aac1377af9c3` and the
    documentation correction was committed as `8ba508f3`. Fable must prove that
    unmatched input reaches the Dispatcher Agent, stale typed Team-route
    rejection removes the stale binding and falls back once, and no silent-drop
    interpretation survives.
13. **Inferring product intent from the transport adapter.** I allowed
    `team.submit` to choose completion delivery from whether the call arrived
    through Channel or admin, and accepted removal of Dispatcher COT as a side
    effect of the same mistaken Channel narrowing. Completion ownership belongs
    to the real caller, not the adapter class; existing Dispatcher and
    TeamLeader Feishu presentation must remain unless explicitly removed.
    Fable must search for `isChannelInvocation`-style behavioral branching and
    role filters that silently erase Dispatcher presentation.
14. **Turning host shutdown into logical close.** I accepted shutdown and
    startup-rollback paths that materialized dormant entities, persisted
    `closed`, emitted retirement facts, or performed worktree cleanup. Host stop
    releases runtime authority; explicit close, Team dissolve, creation failure,
    and Workflow-owned lifecycle are the durable close owners. Fable must trace
    every stop and rollback path to prove that ordinary persisted entities are
    not logically closed as a host-cleanup side effect.
15. **Forcing defensive implementation before proving a product boundary.** I
    instructed the Developer to add validators, freeze/copy layers, limits, and
    edge-case guards because code could theoretically be malformed, rather than
    first identifying a real producer, consumer, user-visible consequence, or
    data consequence. Confirmed examples include the expanded Core-event
    payload validators and speculative global limits that were later removed or
    deferred. Fable must review each non-domain limit, duplicate validation,
    canonicalization pass, and "unreachable" guard; keep only a demonstrated
    external, persistence, authorization, or cross-owner boundary. This does
    not authorize deleting proven boundaries such as immutable cross-Channel
    event delivery, JSON wire normalization, or MCP lease authorization.
16. **Persisting Feishu automatic-provisioning execution progress.** I carried
    the old Core `ProvisionedTargetRecord` state machine into Channel as
    `provisioning[]`, with `request_id`, phases, resume, and finish operations.
    That repeats the same durable-intermediate-state mistake as the deleted Team
    name/request records. Space policy and completed bindings are durable;
    automatic creation is process-local and may disappear. A valid Team record
    means the Team exists; no record means it does not. After restart, an
    unmatched target is delivered to the Dispatcher Agent. Fable must require
    deletion of the persisted provisioning rows, phase machine, recovery scan,
    and restart resume path, and must reject any replacement outbox or repair
    ledger.
17. **Treating Collaboration Space generation as cancellation rather than a
    snapshot version.** I proposed invalidating an older in-flight creation when
    the Space policy changed. The operator's product model is snapshot-based:
    a Team creation accepted before an update uses the old runtime, identity,
    and repository snapshot; a creation accepted after the update uses the new
    snapshot; already-created Teams are untouched. Fable must find any current
    generation comparison that cancels or rewrites already-started work. This
    rule does not make the in-process operation durable: the captured snapshot
    remains memory-only and is lost with the process.
18. **Reviewing by command rather than collaborating on ownership.** I too often
    translated my first interpretation into mandatory Developer constraints,
    especially for defensive code, instead of showing the evidence, discussing
    the ownership model, and letting the Developer challenge the design under
    the same product principles. Fable must not inherit my instructions as
    truth. It must independently reconstruct the product consequence of every
    surviving mechanism and call out both unnecessary defense and missing
    product behavior.
19. **Giving one durable fact two different commit authorities.** I accepted a
    Feishu routing store that mutated its live in-memory document before its
    atomic write, then reported the write failure to the caller. That made a
    failed bind active in the process and allowed an unrelated later write to
    persist it. Fable must prove that Space policy and completed bindings become
    live only after their atomic file commit, and that a rejected write leaves
    the prior committed in-memory value unchanged.
20. **Modeling expected tool rejection as a cross-package exception.** I let
    Channel-owned actionable failures become plain thrown errors, then explored
    public error classes and code duck typing after Core hid them as `INTERNAL`.
    This missed the simpler existing topology: MCP shim communication is a
    synchronous generic JSON invocation. Fable must prove that expected public
    failures return an explicit JSON result through `mcp.toolcall`, the generic
    shim alone assembles the official MCP error result, and events or
    Channel-specific Core error types are not introduced.
21. **Turning a capability move into a capability deletion.** When external
    binding ownership moved from Core Team MCP to the Feishu Channel delegate, I
    accepted making all binding tools Dispatcher-only. That silently removed
    TeamLeader self-bind and self-release behavior instead of re-homing it.
    Fable must compare behavior before and after every ownership move and prove
    that TeamLeader binding tools derive the Team from the descriptor-bound
    caller rather than disappearing or accepting an arbitrary Team name.
22. **Letting deterministic non-delivery end at a log.** I accepted automatic
    provisioning failures that occurred before any turn admission as a terminal
    error with no recipient, even though unmatched Channel input belongs to the
    Dispatcher Agent. Fable must prove one Dispatcher fallback whenever
    non-admission is known, while preventing fallback after ambiguous or unknown
    post-submit outcomes that could otherwise double-deliver.
23. **Expanding Team-record authority without rechecking its validity
    boundary.** Removing name claims made one readable Team record decide
    existence, name ownership, lifecycle admission, and missing-Identity leader
    reconstruction, while the inherited reader still validated only five
    fields and cast the rest. Fable must validate exactly the lifecycle and
    reconstruction facts that now carry product meaning, while rejecting a
    generic schema framework, unrelated field validation, and speculative
    limits.

The final Fable audit is read-only first. It must report evidence before any
repair round: current `file:line`, the real trigger, the product or persisted
data consequence, the violated operator principle, and the smallest correction.
Pure code-edge hardening that has no demonstrated product consequence belongs in
the final holistic code review and must not be promoted into product state or
architecture merely because it is possible.

- Next action: finish the active Stage 5 correction round, review each remaining
  product issue with the operator one at a time, and do not advance the later
  stages until the confirmed Stage 0-5 drift is removed. After implementation
  and ordinary review are complete, run the independent line-by-line Fable
  audit required by the failure ledger above.
- Related tasks: Surfaced after [Feishu COT Conversation Cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md); this is an independent architecture outcome.

## Development approval

- Status: Granted by the operator on 2026-08-27.
- Approved implementation boundary: The complete frozen requirement and final
  technical design, executed through the staged protocol in
  `implementation-plan.md`.
- Review-fix boundary: No Reviewer finding may be implemented without a new
  explicit operator approval for that correction round.
- Stage 8 Service ownership correction: Approved by the operator on 2026-08-29.
  The implementation author receives the accepted principles and current source,
  not a prescribed file-by-file patch; the TeamLeader reviews the completed diff
  against the ownership, simplification, and deletion constraints before
  accepting it.
- Stage 8 Dispatcher lifecycle correction: Approved by the operator on
  2026-08-29 after the independent capability audit exposed the unsupported
  start-stop-start path.
- Stage 8 Team workspace ownership correction: Approved by the operator on
  2026-08-29 after the defensive-style audit exposed the redundant borrower
  projection.
- Stage 8 Team member dissolve correction: Approved by the operator on
  2026-08-29 after distinguishing live runtime cleanup from cold-record
  normalization.
- Feishu bot self-identity recovery correction: Approved by the operator on
  2026-08-31. A failed or empty bot-info lookup is not cached as resolved;
  while unresolved, the next inbound chat message retries before mention
  gating, with one in-flight lookup shared by concurrent messages. Scope is the
  Feishu transport implementation, focused tests, and its Rush change note;
  the separate empty-TeamLeader recovery defect is explicitly excluded.

## Delivery

- Pull request / CI / merge: implementation merged into `next` as PR #350
  (squash `2ed5f5ea`); provider-boundary residue cleanup merged as PR #353
  (`e17650d1`); legacy persisted session-identity layout restored as PR #356
  (`3d907d52`).
- Knowledge closeout: Completed 2026-09-01, performed directly by Claude on
  explicit operator instruction (deliberately not delegated to the original
  TeamLeader). Knowledge owners updated:
  - `.agents/decisions/minimize-provider-boundaries.md` — new decision record
    (also resolves the "decision record §N" citations in the architecture
    guard tests via its numbered-section map);
  - `.agents/decisions/agent-runtime-provider.md` — annotated as superseded in
    contract shape;
  - `.agents/reference/model-facing-writing.md` — MCP failure contract
    corrected to the shipped `StatedFailure` / native-message-passthrough
    behavior (the prior allowlist/sanitized-error text contradicted merged
    source);
  - `.agents/product/README.md` — product behavior catalog seeded from this
    task's operator rulings;
  - `.agents/skills/engineering-whitepaper/SKILL.md` — durable operator taste
    extracted from this task's rulings (generalization of
    `durable-fact-recovery-principles.md` and the failure ledger);
  - `.agents/domains/**` — N/A beyond in-task updates: the affected behavior
    contracts (`channel-routing-and-binding.md`, `state-config-and-files.md`,
    `channel-runtime.md`, `service-topology.md`) were already aligned during
    the task itself;
  - `.agents/glossary.md` — N/A, no new overloaded term.
