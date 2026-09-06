# Independent review: Codex

The draft needs revision before implementation approval. The most consequential
gap is the Claude Code skill cache: renaming the bundled directories does not
necessarily make the renamed skills available after an upgrade. There are also
changes to authorization and delegation guidance that exceed the cited rulings,
and several proposed factual statements contradict ordinary supported paths.

## Review basis

- Requirement: R1–R20 in [requirement.md](../../requirement.md); rulings take
  precedence over the file's older
  alignment and proposed-change paragraphs.
- Draft reviewed: `../draft.md`, workspace commit
  `d709c9ab0b47f7a363eb6536c1fd6b72b6d3b29f`.
- Delivery baseline: `origin/next` at
  `0d8098f1d0afee640faef157cc5fab7069e8d4d9`, plus PR #369 at
  `5e1a346430807db139e46da34a6362f975c98983`. The workspace does not contain
  #369's implementation. References marked **369** below were read with
  `git show origin/pr-369:<path>`; other source references are workspace reads.
  The cache, collection, workflow, catalog, and completion-renderer files cited
  below have no difference between the two inspected heads.
- Read `.agents/skills/engineering-whitepaper/SKILL.md` first, then the
  requirement and recorded probes, then the draft and source. Also checked the
  product catalog and relevant ownership history (#280, #338, #350).
- This review changes only this file. It does not change the draft, requirement,
  implementation, runtime state, or the other reviewer's file.

## Findings, ordered by effect on the outcome

### F1 — P1: An existing Claude skill adapter can hide both renamed skills

**Draft:** §3.5, §3.9–3.10, §5, §7–8.

**Evidence:** `packages/dreamux/src/service/team-service/leader-agent.ts:198–206`
still supplies roots named `team-leader` and `shared`;
`packages/dreamux/src/platform/paths.ts:227–236` derives their outer directories.
`packages/agent-runtime/claude-code/src/skill-adapter.ts:68–79,99–109` hashes
only root names and absolute paths and puts the same facts in the manifest.
Its validator returns true after comparing that manifest, without examining
child skills (`:56–65`).
`packages/agent-runtime/claude-code/src/skill-materializer.ts:26–27` then returns
without rebuilding the symlinks created at `:33–44`.

**Trigger and consequence:** Upgrade an installation in place, retaining its
package path and existing adapter cache. The root names and paths stay the
same, while `team-workflow/` and `workflow/` disappear. The adapter still
contains links under the old child names and never creates `teamwork` or
`dynamic-workflow`. Restart alone does not fix this: startup calls the same
validator (`packages/agent-runtime/claude-code/src/runtime.ts:130–139`). A fresh
cache passes the proposed tests while an existing Claude TeamLeader cannot
load the new skills.

**Instead:** Resolve this item before approving the runtime exclusion. The
Claude adapter owns its cache and native directory view (already the boundary
in #350, `2ed5f5ea`, author YourWildDad). Prefer making that owner's cache
identity/materialization reflect the actual child-skill inventory. Do not
smuggle a cache-busting value into Core's role names or add old-name aliases.
If the chosen solution is an operator cache-clear action instead, record that
upgrade action and its release/maintenance implications explicitly; the current
unqualified no-upgrade-work claim is insufficient. Update the implementation
boundary and affected package change files to match the chosen resolution.

**Verify:** Materialize the old skills, rename the children under the same
outer roots, then start/materialize again with the same source descriptors.
Observe usable new skill names. Test fresh and resumed Claude sessions; inspect
Codex's actual extra-root inventory separately. This is a source-proven cache
path, not a claim that a particular installed host has already failed.

### F2 — P1: The host-boundary rewrite excludes clear channel authorization

**Draft:** §3.2, especially draft lines 107 and 118; R20 attribution.

**Evidence:** R19 explains the original boundary as guarding an *ambiguous*
channel request; R20 says to retain it and express the consequence. **369**
`packages/dreamux/src/service/dispatcher-service/base-prompt.ts:32,81` says
“from an ambiguous channel request.” The same scope is present when #280 added
the text (`1b9f2712`, author YourWildDad, that file at line 30).

**Problem:** “A channel request alone does not authorize changing them” applies
to a clear, explicit operator request too. The Claude variant drops ambiguity
entirely. This changes a permissions rule while presenting it as a wording
change. The product catalog identifies the Channel as the operator's doorway;
this can make ordinary authorized maintenance require redundant confirmation.

**Instead:** Keep the qualifier in both variants, for example: “An ambiguous
channel request leaves authorization for host-owned changes unresolved.” Retain
the named host-owned resources. R20 authorizes a consequence sentence, not a
new requirement for authorization outside the channel.

**Verify:** Review the two complete rendered variants against two cases: an
explicit owner request to change config, and a request whose intended host
change is ambiguous. Only the latter remains unresolved.

### F3 — P2: “No file lists” confuses imposed implementation with useful ownership

**Draft:** §3.5, draft lines 240–253; J13; Q3.

**Evidence:** R8 objects to absolute implementation instructions that prevent a
TeamMate from responding to contrary facts; it does not prohibit identifying
files, read-only boundaries, or ownership. **369**
`packages/dreamux/skills/team-leader/team-workflow/SKILL.md:46–57` separately
explains artifact paths, shared-file ownership, and disjoint roles. **369**
`packages/dreamux/src/service/teammate-collection/mcp-tool-descriptors.ts:285`
provides a *general* shared-workspace coordination rule, not a task's actual
ownership assignment. Its `send` description (`:399–419`) has no equivalent
ownership content.

**Problem:** The new blanket exclusion of file lists undermines the brief that
the operator actually needs. Two writers exploring overlapping code still need
to know who owns writes; a reviewer needs to know its assigned artifact. The
general tool description cannot supply those task-specific facts, and retained
“roles disjoint” prose does not establish disjoint writes. Moving a method rule
to the tool does not move the current assignment with it.

**Instead:** Distinguish evidence paths and reasoned ownership boundaries from
a prescribed edit plan. Carry the former as context; label suggested edit
locations as hypotheses. Require a member to report a boundary that blocks the
goal so the leader can revise it. This preserves R8's exploration posture and
the concrete shared-file scenario without a new ownership mechanism.

**Verify:** Read a representative developer/reviewer brief and a follow-up
`send`: each can identify the requirement, its deliverable, who may write what,
and what to do if reality requires a different boundary. The present review
assignment is itself such a brief.

### F4 — P2: The TeamMate sentence claims the wrong visibility and recipient

**Draft:** §3.6; J7–J8; Q2.

**Evidence:** `packages/dreamux/src/service/teammate-collection/index.ts:300–319`
implements `last` through the activity reader; **369**
`packages/dreamux/src/service/teammate-collection/mcp-tool-descriptors.ts:171–172`
expressly includes an in-progress turn. The product catalog calls this the
mid-turn progress window. Workflow children are created through the same
collection (`packages/dreamux/src/service/team-service/index.ts:592–602`), but
their outputs go to the workflow runner as `agent_result`
(`packages/dreamux/src/service/workflow-service/run.ts:470–495,537–549`).
`packages/dreamux/src/service/workflow-service/agent-policy.ts:1–7` already
states this return-value contract; that ownership dates to #338 (`8ed949e2`,
author YourWildDad).

**Problem:** “Your TeamLeader sees nothing of your turn until it ends” denies
the supported observation path. For workflow children, the recipient is the
script, whose eventual result can transform or omit the child's output. Being
in the same collection proves lifecycle ownership, not identical completion
delivery. Adding both sentences creates conflicting guidance for structured
workflow output.

There is also a literal type error in the proposed condition: the supplied
`AgentEntityIdentity` has `team_id`, not `teamId`
(`packages/dreamux/src/service/agent-entity/types.ts:67–71`).

**Instead:** State the narrower *automatic delivery* fact for ordinary Team
members: the final response is what Dreamux pushes to the TeamLeader when the
turn ends. Keep the workflow return-value statement with the workflow owner;
do not infer its recipient from `team_id`. The collection can state the common
Team/name identity, while the known ordinary/locked construction paths supply
the appropriate delivery fact. No new persisted role or provider flag is
needed. Keep Dispatcher-scoped members outside R9.

**Verify:** Exercise ordinary Team spawn and reopen, Dispatcher spawn, and a
Team workflow whose script returns a different value from its child's result.
Inspect the delivered prompts and actual recipients, including schema output.
Do not lock the false “sees nothing” wording into a construction test.

### F5 — P2: A Team workspace is not necessarily isolated from other writers

**Draft:** §3.3; J11.

**Evidence:** **369**
`packages/dreamux/src/service/team-collection/mcp-delegate.ts:277` supports
`repo.mode: reuse-cwd`; `:128–131` resolves an omitted explicit repo path to
the Dispatcher's workspace.
`packages/dreamux/src/service/team-collection/runtime-registry.ts:132–159`
passes that request into the worktree owner. Members then share the Team's
chosen directory (`packages/dreamux/src/service/team-service/index.ts:581–589`).

**Problem:** Two Teams can intentionally reuse the same repository, or a Team
can reuse a directory another delegate is editing. “Own workspace” describes
the Team's selected working directory, not exclusive filesystem ownership.
It cannot justify omitting R7's file-overlap sentence from Team dispatch.

**Instead:** Keep the same concise overlapping-file guidance for Team work.
There is no need to inspect workspace state and add conditional reminder
machinery. Also avoid describing Dispatcher TeamMates as necessarily sharing
the caller's directory: their `repo` choice can isolate them.

**Verify:** Assess the wording against managed, fresh-directory, and reuse-cwd
cases. Preserve the existing workspace choices; this finding requests no new
filesystem exclusion policy.

### F6 — P2: `team.create` is not an unconditional hand-off, and has no reminder

**Draft:** §3.3, “attachment points unchanged”; J16; §8's descriptions-only
boundary for the Team delegate.

**Evidence:** **369**
`packages/dreamux/src/service/team-collection/mcp-delegate.ts:127,160` accepts
an optional prompt and returns only `{ structured: result }`. The Team reminder
is attached by `send` only (`:183–188` in the workspace, same behavior in #369).
`packages/dreamux/src/service/team-service/index.ts:279–304` creates a submission
and completion delivery only when a prompt is present. The product catalog
explicitly preserves process-free Team creation.

**Problem:** Adding “the completion is pushed later” to every `create` promises
a notification when no work was submitted. Conversely, a `create` *with* a
prompt still never gets the revised Codex dispatch-result reminder. The draft
and requirement evidence incorrectly count it among the existing attachment
points. The description contract and the result reminder are different
surfaces; changing one does not attach the other.

**Instead:** Qualify the create description by the optional first prompt. If
the intended R1/R7 coverage includes prompt-bearing create, attach the Team
reminder only for an admitted initial submission, at the Team delegate that
already has that result. Widen the descriptions-only boundary explicitly.
Do not make prompt mandatory or emit a synthetic completion for empty create.

**Verify:** Inspect actual MCP results for create without a prompt, create with
an admitted prompt, and send. Observe one completion for submitted work and
none for empty creation; check Codex text and Claude structured-result views.

### F7 — P2: The channel reminder should describe reply delivery, not all visibility

**Draft:** §2 and §3.4, draft line 183.

**Evidence:** R1 requests the consequence explaining the need for the reply
tool; R4 assigns the reminder to the channel. Neither requires the proposed
exact English sentence. Current Feishu code passes assistant content to the
conversation card (`packages/channel/feishu-channel/src/feishu-cot-activity.ts:113–121`),
and the product catalog expressly preserves live conversation display. The
ask-card path is another visible output with a separate tool.

**Problem:** “The user ... sees only what you send through the reply tool” and
“your assistant text is not shown to them” overstate the fact. A visible COT
stream is not the deliberate progress/final reply the operator wants, but it
does exist. This is the same distinction the reminder should help the model
understand, rather than deny.

**Instead:** State the actual channel-delivery consequence, for example:
“Assistant text is not posted as your chat reply; replies reach this chat
through the reply tool.” Leave COT behavior, ask cards, and the retained
`reply.text` confidentiality clause unchanged. The channel remains the author.

**Verify:** Observe one assistant event on the conversation card and one reply
tool call as a chat reply; the sentence should accurately describe both.

### F8 — P2: The proposed negative tests cannot pass their own accepted prompt

**Draft:** §3.1–3.2, §6–7; J15.

**Evidence:** Draft lines 93–94 list `Load` as a forbidden marker and lines
141–143 apply “the same” gate to both Dispatcher variants. Those variants
deliberately retain “Load `dreamux-maintenance`” (draft lines 105 and 115).
R2 removes Dreamux-authored TeamLeader rules, not constraints an operator puts
in `identity`; **369** `packages/dreamux/src/service/team-service/leader-agent.ts:223`
appends that identity verbatim.

**Problem:** The literal Dispatcher test rejects J15. Applying a broad lexical
ban to a prompt containing operator identity can likewise reject a legitimate
identity mentioning a reply tool, polling, or a skill. These tests conflate
text ownership and token occurrence. The gates also cannot establish that R8's
collaboration outcome improves.

**Instead:** Assert removed Dreamux-owned sentences at their rendered boundary,
with the maintenance sentence explicitly retained and a separate identity
pass-through case. Do not introduce source/AST mirrors or a global forbidden
vocabulary. Before declaring acceptance, observe actual tool activity on both
engines: plain channel reply, TeamMate hand-off, workflow run, and a brief whose
proposed implementation conflicts with the recorded requirement. Include an
upgraded session/cache, not just a fresh run. The central R8 observation is
whether the member reports the conflict and the leader revises the plan or
seeks the user's decision.

**Verify:** Use tool/transcript evidence for skill loads, reply calls, polling,
and completion delivery. Asking a model which skill it loaded is useful
diagnosis but not sufficient evidence of an absent load. Engine-dependent
outcomes can remain unknown; they should not first be classified as accepted
solely because wording tests passed.

### F9 — P3: The universal “never orders” KB rule contradicts the approved exception

**Draft:** §2, §3.3 and §3.9.

**Evidence:** R7 explicitly selects Claude-style dispatch wording and adds the
file sentence. Draft §3.3 accordingly says “do not report,” “continue,” and
“Do not edit,” while §2 says a reminder “never orders.”

**Problem:** The proposed standing KB principle would classify this task's
own R7 implementation as forbidden, making later cleanup likely to undo a
specific operator decision. R7 is more specific than the general taste in R1.

**Instead:** Record the default preference for consequences with the specific
R7 dispatch wording decision and scope. Do not rewrite R7 away to satisfy a
new absolute rule. No additional prompt mechanism is needed.

**Verify:** Compare the principle and all three dispatch texts in one review;
their coexistence should be explainable directly from the rulings.

## Views on J1–J16

| Judgment | View | Reason and evidence |
|---|---|---|
| J1 | Agree as an explicitly identified extension. | R5's stated reason is the engine's native definition-loading mechanism; removing the equivalent Dispatcher sentence is consistent. R16 includes Dispatcher work. Do not relabel R5 as a verbatim Dispatcher ruling. |
| J2 | Agree, with the existing explicit-user exception retained. | **369** `base-prompt.ts:25–26` has separate workspace/delegation and wait guidance. Combining the workspace statements removes duplication; R1 explains the coordinating role. It does not settle F2's host authorization issue. |
| J3 | Agree as an extension to approve, not as R19's literal scope. | **369** `base-prompt.ts:30,48` repeats channel delivery. One channel-authored reminder serves both deletion sites (R4); keeping the duplicate contradicts the intended ownership reduction. |
| J4 | Agree. | **369** `mcp-tool-descriptors.ts:336–382` gives self-contained status/stop/list schemas. `workflow_list` actually takes no `run_id`, so correct that rationale. The script skill need not load for these calls. |
| J5 | Agree if the paragraph adds only context and conflict-reporting posture. | R15 says to follow earlier decisions without complexity; the **369** Dispatcher skill's lines 41–56 already cover outcome, context and boundaries. Preserve those useful boundaries; do not copy F3's blanket prohibition. |
| J6 | Agree as a scoped design inference. | The **369** Dispatcher skill covers delegation, not cron or scripting. R15 favors reducing triggers. R17 literally removes channel from one load sentence; it is not a general ban on channel content or skill routing. |
| J7 | Agree. | R9 explicitly names Team-scoped members. Applying a Dispatcher version for slightly simpler code would expand the ruling. |
| J8 | Disagree as written. | Collection membership does not prove the notification recipient or absence of mid-turn visibility; see F4. A common Team identity sentence is separable from a delivery statement. |
| J9 | Agree. | `feishu-session-ops.ts:381–409` sends the settlement through the same channel submission path. R13's provider attribute belongs there too; preserve optional sender, thread, message and request attributes. |
| J10 | Agree. | `channel-service/mcp-delegate.ts:136–141` owns both the delegate name and MCP initialization identity. Using the same provider basis there adds no provider-specific logic to a runtime. Preserve internal channel-id context and routing. |
| J11 | Disagree. | `reuse-cwd` is supported; ownership of a Team does not imply exclusive ownership of its filesystem. See F5. |
| J12 | Agree for the additive Feishu attribute. | Feishu supplies opaque attributes; Core renders without interpreting them (`teammate-service/submission.ts:86–100`). A minor additive feature is reasonable on this package's >1.0 line. This does not classify the separate cache fix or removed skill/tool names. |
| J13 | Disagree as written. | A tool's generic shared-workspace rule cannot supply current task ownership, and `send` does not restate it. Keep reasoned ownership context; see F3. |
| J14 | Agree. | Removing “its schema is the authority” from the map fits the no-rule identity goal; the schema remains available through native tool discovery. |
| J15 | Agree. | No ruling removes the maintenance trigger. Keep it, and fix the contradictory `Load` test in F8. |
| J16 | Partly agree; disagree with identical unconditional wording. | `send` is a hand-off; optional-prompt `create` is not always one. Describe the branch and resolve the absent create reminder explicitly; see F6. |

Abbreviated source paths in this table refer to the fully identified files in
the findings above; all **369** line numbers refer to that PR's head.

## Answers to draft §9

**Q1 — external channel naming:** Defer an invented sanitizer, but do not call
the general external path verified. The source confirms
`seedDescriptorId(ref)` is `ref.raw` for npm
(`packages/dreamux/src/registry/provider-loader.ts:238–239`), including scope and
export syntax (`registry/provider-ref.ts:116–129`). It also already supports
external MCP providers in the catalog and its tests
(`packages/dreamux/tests/channel-service.test.ts:361–397`). No deployed external
provider is claimed here.

There is a relevant existing decision: #350's
`packages/dreamux/src/service/mcp/descriptor.ts:46–58` deliberately treats
server names as logical identities, with runtime quoting owned by adapters.
Thus “not a legal segment” needs an engine acceptance fact; the catalog itself
does not define such a segment grammar. The requirement reports the gap, but
neither live engine's acceptance of an npm-derived name was verified in this
review. Keep the gap explicit for the first external provider. If the final
solution promises all existing configured provider references work on both
engines, this item remains unresolved until that path is checked. A silently
lossy replacement of punctuation, fallback to channel id, or new global
allowlist is not justified. A future naming decision must also distinguish
different named exports from the same package; provider uniqueness is by full
canonical ref (`config/config.ts:565–570`), not package basename.

**Q2 — fact sentence scope:** Choose J7. Use the existing Team construction
scope, not a new all-entity identity rule. Correct the field spelling and
separate ordinary completion delivery from workflow return values as in F4.

**Q3 — context versus control:** Goal, reason, authoritative artifacts,
verbatim constraints, marked assumptions, completion evidence, unknowns, and
permission to report impossibility address R8 well. The blanket file-list
exclusion does not. Include justified write/read ownership and distinguish
operator constraints from the TeamLeader's tentative design. A “cannot” report
must identify the observed contradiction, not silently modify the requirement.
The mechanism remains a completed turn plus an ordinary follow-up; do not
promise a new mid-turn mailbox or plan-approval protocol.

**Q4 — duplicate channel-reply sentence:** Delete it as J3's explicit extension
in the approval playback. R19 itself names only Dispatcher Role bullets.
Removing the second copy follows R4's ownership rationale and removes a whole
duplicate rule rather than leaving an alternate owner. No extra Core fallback
reminder is warranted for external channels.

**Q5 — completion sentence placement:** The insertion is reasonable. The
source search found no production parser of the English status line:
`packages/dreamux/src/service/teammate-service/index.ts:363–369` treats the
renderer output as opaque text, and `renderSubmission` preserves the body.
Tests do parse exact output: `packages/dreamux/tests/completion-renderer.test.ts:70–75`
uses a spill prefix and slices the file path after it. Preserve the two current
branches in `completion-renderer.ts:12–14`: inline “Output below” versus the
saved-file explanation. §3.8's single after-example for both branches should
not replace the spill explanation with “Output below” followed by a pathname.
Add the sentence once before either existing suffix, covering TeamMate and
workflow completed/failed/stopped results. No synthetic flag or neutral
submission-contract change is needed for R14. External consumers of the prose
were not inspected.

## Boundary, release, and verification conclusions

The proposed ownership is otherwise economical: role owners construct prompt
identity/maps; channels supply their reminder and provider attributes; Core
renders opaque envelopes; delegates author tool contracts and dispatch text;
skills teach collaboration. Returning descriptor identity alongside a neutral
channel implementation is a reasonable catalog seam. No new durable state,
provider field, event taxonomy, or completion protocol is required by these
wording changes.

The final boundary must nevertheless acknowledge the concrete changes:

- §5's “tool names unchanged” means local names such as `reply` only. R13
  changes fully qualified names on both engines, as well as the public server
  name. State both facts; preserve config ids, routing documents, internal
  event ids, and session-call contexts.
- The general no-runtime-change claim is contingent on resolving F1. No
  provider ABI change is needed to solve it, but the runtime's own skill cache
  is inside the affected end-to-end path.
- The non-breaking Dreamux change-file classification cannot be justified
  merely by unchanged config/state schemas while F1 remains. Explain skill
  renames and fully qualified tool renames to existing callers, and classify
  any actual upgrade action after choosing the cache solution. R12/R13 avoid
  a channel config/routing rebuild; they do not decide every skill-cache
  consequence. Generate change files with `rush change`, including the runtime
  package if changed; do not hand-edit generated changelogs.
- Run the listed Rush gates and KB check on the combined delivery baseline,
  then verify the rendered catalogs, prompts, and actual engine observations.
  Preserve the baseline schemas/results while revising descriptions; test the
  channel-name change through a real caller-specific lease and tool call, not
  only a delegate name assertion. Preserve internal ids and existing routing
  records across restart. Add the settlement `source` case, not only normal
  inbound. A model's subsequent behavior remains empirical, not a guarantee
  provided by a narrower description.

## What I could not verify

- No implementation exists for this draft, so I did not run build, lint,
  tests, typecheck, live spawns, channel sends, or upgrade operations. This is
  source/design review, not an implementation-green verdict.
- I read #369's objects and the relevant unchanged source paths, but did not
  create or execute the proposed merged delivery checkout or reproduce its
  reported `merge-tree` result.
- The mid-turn delivery and per-engine tool/reminder visibility probes are
  recorded evidence in the requirement; I did not rerun them. In particular,
  description-driven skill loading, absence of polling, provider recognition,
  and better conflict reporting require observed model turns after the change.
- I did not verify external npm-derived server-name acceptance on either
  engine, any third-party consumers of renamed tools/skills or completion
  prose, or whether an actual installation upgrades at an unchanged path.
  F1 identifies the concrete supported in-place path from source, not an
  observed deployment incident.
- I did not inspect the other reviewer's file. No findings depend on another
  reviewer's conclusion.

## Reconsideration under R21 (2026-09-06)

I withdraw F7 and F9. I narrow F4 to the `team_id` spelling correction and
withdraw its requested visibility/recipient wording changes. I also narrow F3
and the corresponding J13 objection to preserving useful task ownership,
without requiring a particular bullet or repeated coordination instructions.
My J8 view changes from disagree to agree. The other findings remain for the
action-relevant reasons below.

This section supersedes the earlier dispositions and their associated wording,
construction, and verification requests. The earlier review remains intact as
the record of my initial judgment.

### The criterion I applied

I read R21 at `../../requirement.md:184–193`. My reading is that a
model-facing sentence should give its recipient the information needed for
the intended action. A source-level exception warrants a finding when omitting
it leaves a concrete action wrong, blocked, or inadequately coordinated.
Showing that another surface exists is insufficient on its own.

For this task, the member needs to put its result or blocker in its final
response, and the leader needs to communicate with the user through reply.
Neither action requires a catalog of observation surfaces. My initial F7, and
much of F4, applied an exhaustive-description standard without establishing
that the extra information would improve either action.

### Findings F1–F9

| Finding | Revised disposition | Reason under R21 |
|---|---|---|
| F1 — Claude skill cache | Keep. | An existing adapter can prevent the model from loading the renamed skill it is directed to use. That is an executable upgrade path affecting access to required guidance. The source evidence and cache-owner boundary in F1 stand. |
| F2 — host authorization qualifier | Keep. | Removing “ambiguous” can make the Dispatcher treat an explicit operator request as insufficient authorization. The qualifier affects whether it proceeds or asks again, and R20 did not authorize that expansion. This is an action and ruling-scope issue. |
| F3 — file lists and ownership | Narrow. | Keep the objection to excluding task-specific artifact paths and justified write boundaries: a writer needs enough information to avoid overlapping another writer, and a reviewer needs its assigned output. Withdraw any implication that the old “name the paths it owns” bullet must survive, every brief must enumerate files, or `send` must repeat a general rule. The skill can remove duplicate mechanics while allowing the brief to carry ownership where needed. |
| F4 — TeamMate visibility and recipient | Narrow to the field spelling. | Withdraw the observation-path objection and the workflow-recipient objection as reasons to change the prompt or add construction branches. Both variants direct the member to return its final output; the workflow's existing append already specifies the script-return and schema contract. The model does not need the full routing topology to comply. Keep `identity.teamId` → `identity.team_id`, because the supplied type actually lacks the former field. |
| F5 — Team workspace overlap | Keep. | A supported reuse-cwd hand-off can put another writer in the same files. The practical information is that Team work can overlap the caller's other work; omitting overlap guidance on an assumed isolation guarantee can permit conflicting edits. Keep the concise file guidance without teaching the model the workspace implementation or adding workspace-dependent reminder machinery. |
| F6 — optional-prompt create and reminder attachment | Keep. | Empty create submits no work, so an unconditional completion promise can make the caller wait for a result that will never arrive. With a prompt, the claimed existing result-reminder attachment is absent. Keep the conditional create contract and the explicit decision on whether to attach the reminder to admitted initial work. This affects expected next actions and intended dispatch coverage. |
| F7 — COT visibility exception | Withdraw in full. | The model needs to use reply to communicate with the user. Explaining that COT displays assistant text offers no useful alternative to that action and can dilute the reminder. I no longer request the replacement sentence or the COT-versus-reply test proposed in F7. The draft's reminder can stand under R21. |
| F8 — negative tests and acceptance evidence | Keep. | The literal `Load` ban rejects the intentionally retained maintenance sentence; an indiscriminate scan can reject operator-supplied identity. Those are verification defects, not exceptions a model must be taught. Keep checks scoped to the owner and intended behavior. Observed skill loading, reply use, and conflict reporting remain relevant evidence; exhaustive wording truth across all surfaces is not an acceptance goal. |
| F9 — “never orders” versus R7 | Withdraw as a finding and required change. | R7 already chooses the dispatch wording. I identified a grammatical/general-principle inconsistency, but no current action that needs an additional exception catalog to resolve it. The hypothetical future cleanup I cited is insufficient to retain this finding. Judge the approved reminder by its effect on delegation; I no longer require a KB qualification or a test reconciling every imperative with “never orders.” |

F4 deserves an explicit correction to my earlier reasoning. I had treated
“the script may transform or omit the child's output” as enough to require
another delivery-specific construction path. The child instead needs to know
what to return. `packages/dreamux/src/service/workflow-service/agent-policy.ts:1–6`
already says its final response is consumed by the workflow, requests only the
value, and requires the output schema when present. The additional Team
sentence does not ask it to abandon that contract or send a separate
human-facing report. I have no behavioral evidence of such a conflict.
Accordingly, I withdraw the proposed ordinary/locked prompt split and its
recipient-distinguishing verification requirement. The concrete field at
`packages/dreamux/src/service/agent-entity/types.ts:67–71` is the remaining F4
correction.

F3's narrower boundary also changes how I would phrase its remedy. The useful
instruction is to include the ownership context this assignment needs. A
standing demand for file lists would recreate the control-heavy briefing
pattern R8 targets. Deleting duplicate coordination prose is acceptable;
forbidding a relevant ownership boundary in the task is the part I still
oppose.

### Judgments J1–J16

| Judgment | Revised view | Action-relevant basis |
|---|---|---|
| J1 — remove Dispatcher definition-loading sentence | Keep agree. | Native tool discovery already supplies the mechanism. Repeating the instruction adds no useful Dreamux-specific information. Retain its identification as an extension of R5's named TeamLeader item. |
| J2 — fold delegation into workspace statement | Keep agree. | The Dispatcher still knows its coordinating role and the explicit-user exception, with duplicate wait guidance removed. Exact sentence form is not the reason to accept it. |
| J3 — remove the second channel-reply sentence | Keep agree. | The channel reminder carries the actionable reply direction. A second standing copy adds no needed information; R21 reinforces that focus. |
| J4 — remove skill pointers from workflow status/stop/list | Keep agree. | Their tool definitions supply what the caller needs for those actions; the script-writing skill is unnecessary. The `workflow_list` argument correction is a small source correction, not a new prompt requirement. |
| J5 — one Dispatcher skill paragraph | Keep agree with the narrowed F3 boundary. | Goal, context, and permission to report a blocker support better delegation. No wholesale rewrite or repeated mechanics are needed. |
| J6 — Dispatcher skill trigger limited to TeamMate/Team hand-offs | Keep agree. | Load guidance where it assists the impending delegation. Unrelated channel, cron, and workflow inspection calls need not load it. |
| J7 — Team-scoped fact only | Keep agree. | R9 names that scope. R21 supplies no reason to expand the change to Dispatcher-scoped members. |
| J8 — Team workflow children receive the sentence | Change to agree. | The common Team sentence reinforces returning final output, and the existing workflow append states the value/schema requirement. The ultimate recipient and observation topology need not produce another prompt variant. Apply the field correction retained in F4. |
| J9 — settlement envelope also carries source | Keep agree. | Recognizing Feishu helps the model select the appropriate channel tools for an answer-card follow-up, as for ordinary inbound. No additional explanation of the settlement transport is needed. |
| J10 — MCP initialization identity follows provider name | Keep agree as a naming choice, not a model-information requirement. | The channel delegate already owns both names; aligning them adds no prompt or new mechanism. I would not require extra model guidance about the initialization identity merely for completeness. |
| J11 — omit Team file-overlap sentence | Keep disagree. | The supported shared-path case changes how concurrent writers must coordinate. The missing information can affect edits, as explained in F5. |
| J12 — Feishu minor change | Keep agree for the additive attribute. | This is release classification of a contract change, not a claim that every visibility detail belongs in a prompt. Cache-related release consequences remain separate. |
| J13 — drop “name the paths it owns” | Narrow the disagreement. | Dropping that exact bullet is acceptable when the general mechanics already have a home. I still disagree with using that deletion to exclude task-specific ownership context. The member needs the applicable boundary when work overlaps; neither the skill nor each tool must repeat it universally. |
| J14 — drop “schema is the authority” | Keep agree, revise the rationale. | The model already has the tool definition when using the tool. The extra clause contributes no needed action information; its being a “rule inside an identity line” is not independently a defect. |
| J15 — retain maintenance load sentence | Keep agree. | It directs the Dispatcher to guidance needed for the named maintenance actions. Its imperative form does not warrant removal under R21. |
| J16 — shared create/send contract sentence | Keep partial agreement and the create qualification. | A caller needs to distinguish a submitted turn from process-free Team creation to know whether a completion will arrive. This is a useful operational distinction, not exhaustive narration of internal surfaces. |

These revised views also supersede the portions of my earlier Q2 answer that
asked for recipient-specific construction, and the reference in the closing
verification discussion to F7's visibility distinction. Q2 still selects the
Team-only scope; the ordinary-member/workflow split is no longer requested.

### Limits of this reconsideration

This is a reassessment of the review standard and remedies using R21, the
existing draft, and the source facts already recorded and verified. I re-read
the workflow append and identity field; I did not run new engine probes or
claim observed changes in model behavior. The unchanged implementation and
upgrade findings still need resolution, but F7, F9, and the withdrawn parts of
F4 should no longer count against accepting the design.
