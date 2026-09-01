# Requirement: Feishu conversation-of-thought cards

## Outcome

Feishu shows one continuously writable COT card for each TeamLeader and one
equivalent card for the Dispatcher. The card follows the recipient's latest
visible-message anchor, displays every supported input and runtime activity by
default, suppresses only the duplicate body of the Feishu input that is already
visible in chat, and closes when the runtime reports the end of its one native
turn.

## Locked product model

1. **One recipient, one anchor, one open card.** Every TeamLeader and Dispatcher
   that can receive Channel input owns one COT presentation, regardless of which
   Feishu chat, DM, group, or topic supplied its anchor. Once initialized, that
   recipient has exactly one standing anchor and at most one open card. A target
   is a property of the anchor; it is not a presentation identity, state key, or
   card partition. Anchor and card state exist only in the live Feishu Channel
   session's memory.

2. **Inbound anchor changes follow successful admission.** A Feishu inbound
   message becomes the selected recipient's current standing anchor only after
   Core has successfully accepted it by steering the live native turn or queueing
   a new one. It is never stored as a deferred future anchor after that success.
   Feishu then closes the recipient's open card, if any, replaces the standing
   anchor, and opens the new card under the new message with the fixed receipt. A
   rejected, failed, or ambiguous admission does not change the presentation. A
   subsequent successfully admitted inbound repeats the same transition; it never
   waits for a logical settlement or native turn end.

3. **Reply never affects the anchor.** A Reply is not Channel user input. Its
   success receipt never creates, replaces, defers, or otherwise changes a
   Dispatcher or TeamLeader anchor, and it never closes, moves, or opens a COT
   card. Only a Channel user message may change an established anchor.

4. **Anchor initialization is explicit.** A visible Team bind card may initialize
   its TeamLeader only when that recipient has no standing anchor; it never
   replaces an existing anchor. A Dispatcher has no installation or restart
   anchor: its first anchor is established only by the first Channel user message
   routed to it. Any task, notification, cron, system, restart-notice, assistant,
   or tool fact received before a recipient has an anchor produces no Feishu COT
   output solely because there is nowhere to place a card, not because that event
   source or kind is filtered.

5. **Anchor delivery is best effort and memory-only.** Anchors, open-card state,
   and their presentation bookkeeping are never persisted. Closing or restarting
   the Feishu Channel session loses every Dispatcher and TeamLeader anchor and
   open-card reference by design. The next live session does not restore, replay,
   or backfill them. Each recipient remains unable to display COT until a new
   Channel user message establishes an anchor, except that a visible Team bind
   card emitted during the new session may initialize a TeamLeader that still has
   no standing anchor.

6. **Feishu owns recipient selection.** The Feishu Channel owns bindings and
   routing, so it knows whether an inbound will be submitted to a concrete Team
   or to the Dispatcher before invoking Core. It advances that recipient's anchor
   after successful admission; it does not need a Core-provided presentation
   correlation.

7. **Exactly one fallback branch.** A stored route may name a Team that Core
   proves does not exist or is already closed, or automatic provisioning may
   prove that no Team submission occurred. In those proven-no-admission cases,
   Feishu removes or retires the stale route as appropriate and submits exactly
   once to the Dispatcher. If that submission succeeds, Feishu advances the
   Dispatcher to the same inbound anchor. An ambiguous or unknown submission
   outcome is never retried or rerouted and does not change the presentation.

## Display policy

8. **Default-show after anchor initialization, without a source whitelist.**
   Once the recipient has an anchor, every projected input is shown
   by default, including `task`, `task-notification`, `cron`, `system`, and future
   source names. Assistant messages, tool calls, and tool results are likewise
   shown whenever the recipient has an anchor. A native turn end is shown only
   when it can close an existing open card. A restart notice delivered within a
   live Channel session is an ordinary system input under this rule: it displays
   when an anchor exists and is absent only when that live session has not
   established an anchor. When a recipient has a standing anchor but no open card,
   the next opening activity opens a new card at that anchor before it is rendered.
   A failed card create or append attempt does not disable the
   standing anchor: a later opening activity may try to open a card at the same
   anchor again. A native-ended fact closes an existing open card but never opens a
   new one; when no card is open, Feishu ignores it.

9. **One narrow suppression.** Outside the accepted synchronous-admission loss
   window, the only hidden body is the exact user input that entered through this
   Feishu Channel and is already visible at its anchor. The
   fixed receipt still opens the card, and every later assistant, tool, push, and
   native-end event from the same native turn remains visible. This policy does
   not require a new request-correlation field: Feishu already knows the intended
   recipient from its routing decision, including when it deliberately executes
   the proven-no-admission Dispatcher fallback. Suppression is best effort across
   the synchronous admission window: Feishu does not add a correlation contract,
   buffer, or reorder facts merely to prevent that body or early runtime activity
   from appearing on the predecessor card before admission success is observed.

10. **Role parity.** Dispatcher and TeamLeader use the same state shape and the
   same anchor replacement, card open, append, interrupt, and close transitions.
   Their only legitimate differences are identity and outer lifecycle policy: a
   TeamLeader is additionally fenced by Team close and route removal or
   replacement, while the Dispatcher has no Team fence. A visible bind card may
   initialize a TeamLeader only while that TeamLeader has no standing anchor.

11. **Display scope.** Core may publish neutral conversation facts for the
   Dispatcher, TeamLeaders, and Team members. Feishu COT renders only Dispatcher
   and TeamLeader presentations. Team members and Dispatcher-scoped TeamMates do
   not receive their own Feishu COT cards in this task.

## Native turn terminality

12. **One runtime event per native turn.** Each Agent Runtime emits exactly one
    provider-neutral ended fact for one runtime-native turn: Claude Code's one
    terminal `result`, or Codex's one `turn/completed`. The fact is emitted once
    regardless of how many Dreamux inputs or logical submissions the provider
    folded into that native turn.

13. **No logical membership contract.** The native-ended fact does not enumerate
    `RuntimeSubmission` members, logical `turn_id` values, presentation ids,
    Feishu targets, or an arbitrary owning logical submission. Core associates the
    runtime with its owning Dispatcher or TeamLeader and publishes that actor
    identity; Feishu closes that actor's one currently open card, if any.

14. **Logical settlement is not card terminality.** `teammate.turn.settled`
    remains a per-logical-submission lifecycle fact and never closes, reopens,
    re-anchors, or partitions a COT card. A native completed end closes the current
    card as completed; failed or interrupted native ends close it as interrupted.
    Channel-user anchor replacement is the only independent reason to close one
    card and open its successor while the same native turn is still running.

## Accepted best-effort losses

- Feishu does not buffer or reorder facts published synchronously inside the
  admission call before it can observe steer-or-queue success. Such a fact may
  remain on the predecessor card, or produce no COT output when no standing anchor
  exists. The anchor transition itself still occurs only after admission succeeds.
- Feishu does not add an admission/native-end ordering buffer for the exceptionally
  early native terminal case. If a terminal fact is observed before the admitted
  inbound installs its anchor, the later receipt card may remain open until a
  subsequent anchor replacement or session close.
- A tool-call result that crosses an anchor replacement may be omitted. This task
  does not add cross-card tool-call recovery or migration.

## Existing COT behavior retained or completed

15. Runtime providers expose neutral tool display facts with enough information
    for one-line tool rows; Feishu owns all card rendering and I/O.
16. COT remains the automatic progress surface. The model-facing `react` tool is
    retained; no automatic received/in-progress reaction ledger is reintroduced.
17. The existing official Lark COT transport surface and compatible SDK version
    are retained without regression. No transport, configuration, persisted-state,
    path, workflow-card, Collaboration Space, web, or platform expansion is part
    of this correction.

## Explicitly rejected designs

- No state keyed by Feishu target and no simultaneous cards for one Team.
- No Reply-derived anchor and no deferred `nextAnchor`. Only a Channel user
  message changes an established anchor.
- No native-execution member set, `turn_ids` array, per-submission presentation
  ownership, or cross-presentation member retirement.
- No actor-level recent-conversation selection, target affinity, or target-based
  presentation permit.
- No early native-end group buffer and no request-correlation contract added to
  `team.submit` for presentation ownership.
- No persisted anchor/card store, restart recovery, replay, or backfill.

## Acceptance criteria

- For one TeamLeader, inbound messages from any sequence of Feishu targets always
  leave exactly one current anchor and at most one open card. Each successfully
  admitted inbound closes the old card and opens the new card under the new
  message. Facts published before admission success is observed follow the
  accepted best-effort-loss rules above.
- Dispatcher passes the same anchor and card-transition contract tests as
  TeamLeader; only Team/route fences and the Team bind-card initialization use
  role-specific tests.
- A visible bind card may initialize a TeamLeader only when it has no standing
  anchor. A fresh or restarted Dispatcher remains without an anchor until its
  first Channel user message; pre-anchor events create no COT card because no
  placement exists. While that session stays live and an anchor exists, a restart
  notice and every other system input display normally.
- Restarting the Feishu Channel session discards every in-memory anchor and open
  card reference. The new session renders nothing for any recipient until a new
  Channel user message or a newly emitted Team bind card establishes an anchor;
  no anchor is restored or replayed.
- A valid bound Team receives the anchor and submission directly. A proven stale
  or closed Team route produces no Team turn and submits once to the Dispatcher.
  A successful Dispatcher admission moves the same anchor; ambiguous outcomes do
  not fallback or change the presentation.
- After the successful anchor transition, a Feishu inbound displays the fixed
  receipt without a duplicate copy of its user body; duplication during the
  synchronous pre-result admission window is an accepted best-effort loss. Task,
  task-notification, cron, system, and an unknown future source all display without
  a whitelist.
- One folded native turn containing any number of logical submissions emits one
  native-ended fact and closes the recipient's current open card once, if any. If
  no card is open, the fact is ignored. Intermediate or final logical settlements
  do not close a card.
- A successfully admitted new anchor arriving before native end closes the old
  card and opens one new card; the eventual native end closes only the currently
  open card, subject to the accepted exceptionally-early-terminal loss.
- With a standing anchor and no open card, the next displayable fact opens a new
  card at that anchor. This remains true after a create or append failure. A
  native-ended fact is the explicit exception: it never opens a card and is ignored
  when no card is open.
- A Reply never creates, replaces, defers, or otherwise mutates an anchor and
  never closes, moves, or opens a COT card.
- Focused tests cover both providers' one-ended-per-native-turn contract, Feishu
  single-card state, post-admission anchor replacement, fallback-to-Dispatcher,
  bind-card initialization, no-anchor suppression, default-show policy, narrow
  Channel-body suppression, Reply non-interference, memory-only restart loss, and
  stale lifecycle callbacks.
- Full workspace build, source/test typecheck, lint, and test suites pass for every
  affected package, with appropriate Rush change files and no private identifiers
  in public artifacts.
