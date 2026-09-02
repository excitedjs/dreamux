# Requirement: Feishu conversation-of-thought cards

## Outcome

Feishu shows one continuously writable COT card for each TeamLeader and one
equivalent card for the Dispatcher. The card follows the recipient's latest
visible-message anchor, displays every supported input and runtime activity by
default, suppresses only the duplicate body of the Feishu input that is already
visible in chat, and closes when the runtime reports the end of its one native
turn. Projected operator paths remain readable without exposing the host's raw
workspace or home prefix: the current workspace is shown as `.` and the current
home as `~`.

## Locked product model

1. **One recipient, one anchor, one open card.** Every TeamLeader and Dispatcher
   that can receive Channel input owns one COT presentation, regardless of which
   Feishu chat, DM, group, or topic supplied its anchor. Once initialized, that
   recipient has exactly one standing anchor and at most one open card. A target
   is a property of the anchor; it is not a presentation identity, state key, or
   card partition. Anchor and card state exist only in the live Feishu Channel
   session's memory.

2. **The Channel establishes its own anchor when it submits.** An anchor is the
   Channel's own state: Core neither carries nor validates one. So a Feishu
   inbound becomes the selected recipient's standing anchor at the moment the
   Channel submits it, not after Core answers. Feishu closes the recipient's open
   card as interrupted, replaces the standing anchor, and opens the new card under
   the new message with the fixed receipt.

   This supersedes the 2026-09-01 adjudication that the anchor may switch only
   after steer-or-queue admission succeeds. That rule was adopted to keep a
   rejected submission from moving the presentation, and it bought that at the
   price of every fact Core published synchronously inside the admitting call —
   the user body and any early activity — landing on the predecessor anchor,
   which is what produced both the duplicated body and the spurious
   immediately-interrupted card. Establishing the anchor first removes the
   ordering problem entirely rather than compensating for it, and it needs no
   change to any event or request contract.

   A submission Core proves it did not admit — rejected, failed, or the
   proven-no-admission fallback — retires the anchor it optimistically took, so a
   recipient is never left presenting under a message that produced no turn. An
   ambiguous outcome proves nothing and changes nothing.

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

9. **The Channel's own body is hidden.** The one thing a card does not repeat is
   the Feishu message already visible at its own anchor. Everything else displays.

   The Channel identifies that body from what it already holds — it knows the
   recipient it submitted to and the text it submitted — and hides it once. It may
   not buffer, reorder, or add a field to any event or request to do so, and it
   must not hide another producer's body: a turn this Channel did not submit
   displays normally. Whatever the Channel remembers about a submission in flight
   is bounded and released.

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
    provider-neutral ended fact for each runtime-native turn. Every Claude Code
    terminal `result` is one native turn, and every Codex `turn/completed` is one
    native turn. One resident Claude Code execution window may legally produce
    several sequential `result` boundaries; each boundary emits its own ended
    fact. Several Dreamux inputs or logical submissions folded into the same
    single `result` still emit only that result's one ended fact.

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
    workflow-card, Collaboration Space, web, or unrelated platform expansion is
    part of this correction.
18. **Readable local-path projection is original scope.** In projected assistant
    text, tool arguments, and tool results, the current workspace prefix is shown
    as `.` and the current host home prefix as `~`, preserving the useful suffix
    instead of blanking the path or replacing it with an opaque placeholder. A
    foreign-machine home-shaped path is not treated as this host's home. Prefix
    recognition must remain correct next to ordinary prose punctuation and inside
    `file://` URLs. If the current host home cannot be resolved, projection does
    not invent one by treating the process working directory as home; workspace
    renaming remains available independently.

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
- No suppression that depends on buffering, reordering, or a new field on any
  event or request. The Channel identifies its own body from state it already
  holds.
- No admission-gated anchor. Waiting for Core to answer before moving the
  Channel's own anchor is what created the predecessor-card losses.
- No provider-side deduplication flag for native turn ends. A synthesized end is
  reported only when the reporting call actually settled something, so no second
  report exists to suppress.
- No process-global cache for host home prefixes. The resolved prefixes are an
  input passed to the conversation projection.

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
- A Feishu inbound displays the fixed receipt under its own message and does not
  repeat its user body. Because the anchor moves when the Channel submits, neither
  the body nor a spurious card can land on the predecessor anchor. Task,
  task-notification, cron, system, and an unknown future source all display
  without a whitelist.
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
- Projected text renames the current workspace and current host home prefixes to
  `.` and `~` respectively, including paths followed by sentence punctuation and
  paths embedded in `file://` URLs. A missing home environment does not cause the
  process working directory to be displayed as `~`.
- On the Claude side a synthesized end is reported only when that call settled a
  submission that was still open, so an ordinary success reports exactly one end
  without any deduplication state, and each terminal `result` reports its own end
  by construction.
- The conversation projection receives this host's home prefixes as a constructor
  input. No module-level cache, no test reset hook, and no start-order dependency
  decides whether a projected path is renamed.
- Focused tests cover both providers' one-ended-per-native-turn contract, Feishu
  single-card state, post-admission anchor replacement, fallback-to-Dispatcher,
  bind-card initialization, no-anchor suppression, default-show policy, narrow
  Channel-body suppression, Reply non-interference, memory-only restart loss, and
  stale lifecycle callbacks.
- Full workspace build, source/test typecheck, lint, and test suites pass for every
  affected package, with appropriate Rush change files and no private identifiers
  in public artifacts.
