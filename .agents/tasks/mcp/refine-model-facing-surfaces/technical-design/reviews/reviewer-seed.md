# Independent review — Seed-runtime seat (R18)

Reviewed: `technical-design/draft.md` (2026-09-06, TeamLeader).
Authority: `../requirement.md`, rulings R1–R20 verbatim.
Baseline: PR #369 (`origin/pr-369`, head `5e1a3464`, merge-base `d74142c3`)
merged onto `origin/next` (`0d8098f1`). The workspace is on `next`; #369 text
was read with `git show origin/pr-369:<path>`.

Method: read the requirement and the draft in full; read every source file the
draft names, on both branches where the baseline differs; diffed
`base-prompt.ts` between `d74142c3` and `5e1a3464`; ran `git merge-tree`;
grepped `tests/` for text locks on the strings the draft changes. I did not
run the suites — no code exists yet; §7's gate list is reviewed as a plan.

## Findings (ordered by outcome impact)

### F1 — §3.9's KB plan for `model-facing-writing.md` is partly unexecutable and misses the updates that matter

Evidence:

- The draft says "the server map example changes from `channel-<id>` to
  `channel-<provider>`". No `channel-<id>` example exists in
  `.agents/domains/model-facing-writing.md` (grep for `channel-<id>`,
  `channel-``, "server map", "MCP server" finds nothing of the kind). An
  implementer following the draft literally finds nothing to change there.
- The same page's "Dispatcher prompt content" prescription (lines 111–123)
  lists nearly everything this task deletes: "load `dispatcher-workflow`
  before TeamMate, Team, channel, or cron MCP work" (gone per R17/R19),
  "treat MCP tool results as authority" (R19 权威句, deleted), "use
  provider-exposed reply tools for visible channel delivery" (R19
  channel-reply, deleted), "keep provider `meta` opaque and protect
  secrets/private identifiers" (R19 secrets, deleted).
- Lines 185–193: "The general no-polling and completion-delivery rule belongs
  in Dispatcher and TeamLeader role prompts." After R2/R19 neither role prompt
  carries it; the rule's owners are now `dispatch-reminders.ts` and the tool
  descriptions. This sentence becomes false on delivery day.
- Line 35: "Dispatchers and TeamLeaders both receive the shared `workflow`
  skill" — the skill is renamed `dynamic-workflow` (§3.5).

Why it matters: this page is the standing brief for everyone who later edits
a model-facing surface (the operator included). Shipping the prompts while
the KB prescribes their deleted content is a standing entropy source — the
next writer re-adds the rules the operator just removed, believing the KB.

Do instead: replace the "server map example" bullet with an explicit rewrite
list for `model-facing-writing.md`: the Prompt Shape bullets (111–123), the
no-polling ownership paragraph (185–193, re-pointed at the reminder/tool-
description owners), and line 35's skill name. The §2 principles themselves
are correct and belong there.

### F2 — The requirement's P1 invariant is never reconciled: after R2, the "public artifacts" half of the secrets rule has no owner

Evidence: `requirement.md` records, as an invariant of this very task, that
the P1 scenarios (a ChannelProvider without Feishu's reminder; a private
channel task surfacing in a public PR/Issue) "must still be covered somewhere
once their prompt lines are gone." The draft deletes the TeamLeader secrets
sentence (R2, "345删掉我赞同") and keeps the Feishu `reply.text` property
clause (R5), but no section states where each half of P1 lives after the
change. Tracing it: the reply half → `reply.text` property description (R5,
Feishu-owned); the external-provider half → R4's architecture (each channel
owns its consequence reminder); the public-artifact half → **no surface**.
The teamwork rewrite (§3.5) does not carry it; `dreamux-maintenance` is
untouched; no tool description owns it.

Why it matters: R2 was the operator's own deletion, so the outcome may well
be "the operator knowingly ruled it out." But the draft's job is to map the
rulings onto the design knowingly (CLAUDE.md: name what you are changing and
why its original rationale no longer holds). As written, the approval
playback cannot confirm the invariant was handled — it disappears by
omission, not by decision.

Do instead: add one reconciliation paragraph (in §3.1 or §3.4) mapping each
P1 half to its owner, and for the public-artifact half state plainly:
deleted by R2, no model-facing surface carries it, flagged for the operator
at approval. If the operator wants it back, the natural home is the `teamwork`
skill (the TeamLeader is the role that writes public artifacts), not the
prompt.

### F3 — §3.7 undercounts the `resolve()` blast radius and omits the simpler alternative

Evidence: `ChannelProviderCatalog.resolve` has **four** callers, not three:
`channel-service/mcp-delegates.ts:45`, `channel-service/index.ts:81`,
`provider-diagnostics.ts:80` (unnamed in the draft), and
`dispatcher-service/runnable-channel.ts:34` — the last is a structural
`ChannelProviderResolver { resolve(ref): unknown }` whose result is
discarded, so it needs no edit but does need to be named so the implementer
checks it. Also, `channel-service/mcp-delegate.ts:60,112,140` carries the
comment that justifies id-based naming (`SERVER_NAME_PREFIX = 'channel-'`,
identity `dreamux-channel-<channelId>`); the comment must be rewritten
knowingly, not just the code — the draft never mentions it.

Simpler alternative: keep `resolve()` bare and add a narrow id accessor (or
pass `descriptor.id` at the delegate construction site, which already holds
the ref). Three untouched callers stay untouched; the neutral seam's shape
changes for no consumer beyond the delegate. The draft's consistency
argument (the agent-runtime twin returns `{descriptor, implementation,
capabilities}`) is real but weaker than it looks: that wrapper exists because
capabilities travel with the implementation; here only the id travels. I
would take the narrower change; if the operator values the symmetry, the
wrapper is defensible. Either way, name all four callers and the comment.

### F4 — §0's "`git merge-tree` reports no conflict" is wrong

Evidence: `git merge-tree $(git merge-base origin/next origin/pr-369)
origin/next origin/pr-369` reports one conflict in `.agents/tasks/mcp/README.md`:
both branches append a task-index line at the same list position (the #369
line for `relocate-role-skill-guidance`). It is a trivial additive conflict —
keep both lines — but the stated merge procedure (branch from `next`, merge
`origin/pr-369`) will hit it, and the draft's claim is factually wrong.

Do instead: say "one trivial additive conflict in `.agents/tasks/mcp/README.md`,
resolved by keeping both index lines."

### F5 — §3.1 overstates what the `channel-feishu` example buys on Codex

Evidence: the draft says the example makes the name "work[] as a catalog
filter on Codex (`channel_feishu`)". Codex rewrites hyphens to underscores,
so the model sees `channel_feishu` — the exact string `channel-feishu`
matches nothing. The example works as an **existence pointer** (the model
learns a channel server exists) and a **substring filter** ("feishu"), which
is what R5 actually asked for (the model can find the channel's tools
without a per-turn load). The overstatement matters because §7's acceptance
probe should test the real behavior: "can you find the Feishu channel's
tools?" not "does `channel-feishu` filter?".

Do instead: say "existence pointer and substring filter" in §3.1 and phrase
the acceptance question accordingly.

### F6 — §6's test list is inaccurate in four places

Evidence:

1. `tests/mcp-public-failures.test.ts:435` uses `name: 'channel-x'` as an
   inline fixture in a public-failure case, not as a server-naming
   assertion. My read: it needs no edit for R12. The draft lists it among
   the tests that change.
2. `tests/completion-delivery.test.ts` never calls
   `buildCompletionTurnText`; its bodies (lines 94, 468, 516) are hand-built
   opaque text fed to `renderSubmission`/projection. It needs no edit for
   the notification sentence; only `tests/completion-renderer.test.ts`
   exact-matches the renderer's output and must change. The draft lists both.
3. §3.11 says this task's README lineage sentence "is corrected in the same
   commit." The current README (line 12) already says the right thing —
   "This task adds one delivery line to that PR's record … #369 is not
   merged and its content ships through this task's PR." There is no stale
   sentence to correct; only #369's own record gains the delivery line.
4. Two runtime test files use `team-workflow` as sample text and are
   unnamed: `packages/agent-runtime/claude-code/tests/tool-display.test.ts:47-48`
   and `.../runtime-submissions.test.ts:394-412`. Like
   `feishu-cot-tool-rows.test.ts` (which the draft does name) they are
   untouched — but the rename's `rg` will find them, and one line in §3.5
   settles the decision.

Why it matters: §8's implementation boundary is "Tests: §6". An inaccurate
list makes the boundary untrusted at exactly the moment a reviewer checks
whether a test edit was knowing.

Do instead: fix the four entries; keep the list short and true.

### F7 — The rename is the moment to gate `dynamic-workflow`'s description, and the draft misses it

Evidence: `tests/mcp-tool-descriptions.test.ts`'s `SKILL_DESCRIPTION_SOURCES`
(#369) covers only the `dispatcher-workflow` and `team-workflow` roots — the
shared `workflow` skill's description is not subject to the "no `before
using`" gate. It is the one skill whose description most needs the
narrow-trigger discipline (its four tools are the over-broad load the
requirement complains about), and the rename touches this test anyway.

Do instead: add the `dynamic-workflow` root to `SKILL_DESCRIPTION_SOURCES`
in the same edit.

### F8 — §3.2's doc-comment rewrite drops the sentence that stays

Evidence: the doc comment above `DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS`
currently says the delta carries "the MCP server map, MCP result authority,
visible-channel delivery, and host-operation boundaries." The draft rewrites
it to list "server map, working-directory identity, host boundary" — but the
delta also still carries the `dreamux-maintenance` load sentence (J15 keeps
it). The rewritten comment should list four things, not three, or the next
reader concludes the load sentence is dead text.

## Answers to the open questions (§9)

**Q1 — record the external-provider naming constraint, add no code: agree.**
No external channel provider exists; builtin ids are pattern-validated
(`registry/provider-ref.ts:107`, `/^[a-z][a-z0-9-]*$/`), so naming is total
for everything that can ship today. When the first `npm:` channel provider
ships, an illegal `descriptor.id` fails loudly at launch rather than
misbehaving silently — that is the acceptable failure shape, and a sanitizer
now would be defense without a named scenario. One addition: record the
constraint where the next provider author will look — the
external-channel-provider loader/descriptor docs — not only in
`provider-runtime.md`.

**Q2 — J7 (Team-scoped only) over one sentence per entity: agree.** R9 was
ruled in the Team context; the Dispatcher variant is an extrapolation the
operator did not make, and Dispatcher TeamMates are the legacy path R15 is
narrowing (their hand-down philosophy already lives in
`dispatcher-workflow`). The symmetry is one line later if the operator wants
it; adding the branch now pays complexity for a path the architecture is
closing.

**Q3 — the `teamwork` outline carries no control; two cautions.** (a) "the
full requirement context … pointed at by path where it is recorded" has no
path for a channel-delivered requirement whose only record is the
conversation. The skill body should say: when no path exists, write the
context into the shared workspace (or into the brief itself) — otherwise the
TeamLeader invents a path. (b) See J13 below: drop "name the paths it owns"
from the *rule* framing, but keep one coordination line for parallel spawns.
Otherwise the outline is faithful to R8 ("cannot" is a finding; never re-send
with firmer wording; context not control) and to R10 (`get_capabilities`, no
runtime names, no model-to-role mapping — verified against the draft text).

**Q4 — delete the J3 bullet: agree.** R19 deleted the channel-reply rule in
substance; the "# Working With The User" bullet is the same rule's second
copy. Keeping it on the reading "R19 named only the Dispatcher Role bullets"
preserves a deleted rule on a technicality — the unknowing-change trap in
reverse — and violates the one-owner discipline this task executes (the
channel owns the reply rule via its reminder, R4). The draft already flags J3
as an extension for approval; that is exactly the right handling, and the
task record should note it.

**Q5 — placement is fine; no production consumer parses the status line.**
`renderSubmission` and the conversation projection treat completion text as
opaque; nothing branches on the status line's shape. The only exact-match
consumer is `tests/completion-renderer.test.ts` (`toBe` on full text), which
the draft already updates knowingly. Keep the new sentence on the status
line's own line (the draft's shape does this) so the body's byte-for-byte
pass-through stays untouched.

## Views on the judgments (§4)

| # | View | Reason |
|---|------|--------|
| J1 | Agree | Same rule, same owner: the engine owns tool-definition loading; R5's TeamLeader deletion applies symmetrically. |
| J2 | Agree | The fold keeps "unless the user explicitly asks this Dispatcher to inspect or edit local files" (verified in the after-text) — the load-bearing half survives; the "wait for" half is R19's deleted rule. |
| J3 | Agree | See Q4. |
| J4 | Agree | `workflow_status`/`stop`/`list` take a `run_id`; no skill content applies to them, and a pointer there would contradict the narrow-trigger design. |
| J5 | Agree | R15 says follow the earlier decisions and don't make it complex; one paragraph is the minimum that keeps both skills on one philosophy. |
| J6 | Agree | R17's intent excludes channel; workflow has its own skill; the skill has no cron content. The description names exactly the tools the skill covers. |
| J7 | Agree | See Q2. |
| J8 | Agree | Verified: workflow agents are entities of the same teammate collection with `team_id` set (`agent-policy.ts`'s `WORKFLOW_AGENT_SYSTEM_PROMPT` is the operation append; `buildEntity` holds the identity). The second half of the sentence holds for them — the workflow consumes the turn's output. "TeamLeader" is one hop away (it spawned the `workflow_run`) but factually true. |
| J9 | Agree | Located the settlement envelope: `feishu-session-ops.ts:383-420` (`deliverAskUserSettlement`) builds its attrs inline and submits through the same `deliver`→`submit` path, so it renders as a `<channel>` envelope and needs its own `['source','feishu']`. The draft says "located at implementation" — name the file: `feishu-session-ops.ts:391`. |
| J10 | Agree | The MCP identity (`dreamux-channel-<id>`, consumed at `mcp/shim.ts:83`, `mcp/commands.ts:103`) is model-visible in some engines; an id-based identity beside a provider-based server would recreate the two-name confusion the rename removes. One public name. |
| J11 | Agree | A Team works in its own workspace; the files sentence would be false in the TEAM reminder. |
| J12 | Agree | `@excitedjs/feishu-channel` is past 1.0; a new envelope attribute is a feature → real semver minor. |
| J13 | Agree, with Q3(b) | The `spawn` description owns the shared-workspace rule — but the dropped bullet also did parallel-spawn coordination. Keep one coordination line in the skill ("agree on which paths each TeamMate owns before parallel spawns"); the rule's owner stays the tool description. |
| J14 | Agree | "(its schema is the authority)" is a rule inside an identity line, and a duplicate of the engine's own behavior; dropping it fits identity-carries-no-rules. |
| J15 | Agree, stronger rationale exists | "No ruling touched it" is true but weak. The structural reason: `dreamux-maintenance`'s trigger is inherently cross-tool (server operation, host diagnosis, daemon/config/log work, missing-reply investigations) — no tool description can point at it, so the prompt sentence is the only viable trigger. That is why it stays while the skill pointers move into tool descriptions. Also see F8: the doc comment must still list it. |
| J16 | Agree | Verified the baseline: `team-collection/mcp-delegate.ts`'s `create`/`send` descriptions carry no pushed-completion sentence, and the failure mode (the model reports or predicts the result before the completion arrives) is identical for Team hand-offs. |

## Verified clean

- Every baseline quote I checked matches #369 byte-for-byte: the five
  TeamLeader sentences (`team-service/leader-agent.ts`), both Dispatcher
  prompt exports, the three dispatch reminders, the spawn/send closing
  sentence, and the workflow tools' "Load the bundled `workflow` skill before
  use." prefix.
- R19/R20's bullets are byte-identical at #369 (`git diff d74142c3
  5e1a3464 -- base-prompt.ts` is empty); the R17 baseline interaction is
  reported correctly (#369 replaced the load sentence with the server map in
  both variants).
- The server name is built in exactly one place
  (`channel-service/mcp-delegate.ts:60,112,140`), is not persisted, and
  leases are in-memory (`mcp/identity-version.ts:21`,
  `MCP_IDENTITY_VERSION = manifest.version`); no config or state migration
  follows from the rename. `channels[].id` keeps its meaning.
- Runtime adapters need no change: Claude Code's `args.ts` builds
  `--disallowedTools` from feature names only (`cron`, `userInterrupt`);
  Codex's `mcp-config.ts` renders `server.name` verbatim.
- No test asserts the dispatch-reminder sentences verbatim; §3.3's
  rewording is free of text locks.
- `source`-first attr ordering works: `renderSubmission` emits attrs in
  `Object.entries` order (`teammate-service/submission.ts:86-103`) and
  `feishu-session-inbound.ts:428` preserves order through
  `Object.fromEntries`. The three tool descriptions that already say
  `<channel source="feishu">` become accurate without edits.
- Both inbound paths pass `CHANNEL_REMINDER` through the `reminder` field
  (`feishu-session-inbound.ts:430`, `feishu-session-ops.ts:409`); Core does
  not author it — §3.4's ownership claim holds.
- Config already refuses duplicate providers per dispatcher
  (`config/config.ts:567`), so two channels cannot collide on one
  provider-named server.
- The dev-workflow rename reference list is complete (`SKILL.md:123`,
  `references/solution-consultation.md:62,82`, `implementation.md:12`,
  `implementation-review.md:24`, `team-dissolution.md:14`); archived
  proposals keep historical names, as the draft says.
- `workflow_run`'s description already states its pushed-completion
  contract; keeping it (§3.3) is correct.
- §3.10's change-file handling fits the repo rules: #369's two files are
  *added* files in this PR, so replacing them under new names is legal
  (editing a pending file in place is what `rush change --verify` rejects);
  `minor` with no `BREAKING:` is right — no config/state/path contract
  changes shape (the Codex tool-name change `channel_<id>__…` →
  `channel_feishu__…` is model-facing, not persisted).

## Could not verify

- Whether the narrow skill descriptions stop per-turn loads on Codex. This
  is the engine's description-matching heuristic; it cannot be proved
  structurally. The draft is honest about this (§7) and the post-release
  acceptance plan (ask the live TeamLeader what it loaded and why) is the
  right instrument.
- Whether models associate a message with its provider from
  `source="feishu"` plus `channel_feishu`. Same acceptance plan; see F5 for
  the probe wording.
- Whether the reworded reminders change model behavior. Only the operator's
  live TeamLeader can show this; the consequence shape is right by
  construction, the effect is empirical.
- The suites themselves. No code exists yet; §7's gate list is complete and
  correct as a plan (including `typecheck:tests`, which the rename's test
  edits make load-bearing), but green is unprovable until implementation.
