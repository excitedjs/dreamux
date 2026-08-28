# Minimize Core Provider Boundaries

## Current state

- Goal: Reduce the public Agent Runtime and Channel contracts to minimal capability-neutral ports, with Channel bridging external interaction through Core Command invocation and Core event subscription.
- State: `development`
- Requirement: [Current requirement](/.agents/tasks/architecture/minimize-provider-boundaries/requirement.md)
- Current solution input revision: `requirement.md` SHA-256 `4cf3a6fe591caeac24925d8e72dec84b8d3a0a18f0632a53bd5b6c0707a85d31`
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
- Solution consultation:
  [Codex proposal and cross-review](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/proposals/codex.md),
  [Claude proposal and cross-review](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/proposals/claude.md), and
  [Trae Seed 2.1 proposal and cross-review](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/proposals/trae-seed-2-1.md).
- Current solution baseline: [Technical design](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/final.md), SHA-256 `54034bc0deefeefdff1310ad431bce69e512329a02c5fc42f64945f8130b7b4c`. Requirement text, technical design, current source, and prior Decisions are evidence; the final product shape and explicit operator principles are authoritative. Existing load-bearing code has no automatic preservation right.
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

For every later refactor surface, the TeamLeader must perform the same producer,
consumer, behavior, ownership, lifetime, model-clarity, and failure-semantics
audit; challenge the Developer when any answer is missing, and return only a
genuinely product-shaping choice to the operator. Core itself stays absolutely
generic: it provides the open envelope and admission mechanisms but never
interprets Channel, cron, task, or any future source's business meaning and
never branches on a concrete source name.

- Next action: finish the active Stage 3 correction round, then perform the
  TeamLeader drift audit before authorizing Stage 4.
- Related tasks: Surfaced after [Feishu COT Conversation Cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md); this is an independent architecture outcome.

## Development approval

- Status: Granted by the operator on 2026-08-27.
- Approved implementation boundary: The complete frozen requirement and final
  technical design, executed through the staged protocol in
  `implementation-plan.md`.
- Review-fix boundary: No Reviewer finding may be implemented without a new
  explicit operator approval for that correction round.

## Delivery

- Pull request / CI / merge: Not started.
- Knowledge closeout: Pending.
