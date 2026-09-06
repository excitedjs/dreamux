# Codex solution review

Reviewer: TeamMate `tm-codex-solution-review-6ksge` (codex runtime), 2026-09-02.
Restored verbatim from the TeamLeader's context after the workspace loss
recorded in the task README.

Verdict: the ownership direction is sound, but the draft is not ready for approval. It contains several silent behavior deletions, inaccurate tool/default descriptions, and new skill text that recreates the tool-manual duplication this task is meant to remove.

## Findings

1. **[High] The relocation table silently drops current behavior and is not a complete statement-by-statement account.**

   **Claim.** Several current statements have no row or are marked "dropped" without an operator decision even though they describe observable behavior or a user override. In particular: both current frontmatter load mandates are absent from the table (`packages/dreamux/skills/dispatcher/dispatcher-workflow/SKILL.md:3`, `packages/dreamux/skills/team-leader/team-workflow/SKILL.md:3`); the TeamLeader's user-requested parallel-edit exception is dropped (`team-workflow/SKILL.md:16-18`; draft:114); the due-cron ordinary-admission/folding behavior is dropped (`dispatcher-workflow/SKILL.md:90-91`; draft:110); and the separate warning not to infer branch-deletion authorization is reduced to the narrower fact that dissolve itself does not delete a branch (`team-workflow/SKILL.md:58-60`; draft:118). The table also does not account for "only after this Team's work is complete" or eligible cleanup continuing in the background (`team-workflow/SKILL.md:42-47,61-66`), and it does not fully account for the key-milestone/latest-source reply guidance present in both skills (`dispatcher-workflow/SKILL.md:76-80`, `team-workflow/SKILL.md:81-85`). D18 attributes the entire routing/tool-inventory statement to `bind_channel`, although the collaboration-space tools have their own owners (`packages/channel/feishu-channel/src/tools/space-tools.ts:80-87,149-179,226-230`).

   **Evidence.** Ordinary admission and possible folding are current scheduler behavior, not history (`packages/dreamux/src/service/scheduler/service.ts:264-270`). The requirement explicitly says every tool fact and caution moves to exactly one description owner (`requirement.md:170-175,242-244`). The whitepaper forbids treating capability deletion as simplification (`.agents/skills/engineering-whitepaper/SKILL.md:46-49,196-204`).

   **Recommended draft change.** Add rows for the two frontmatter mandates and every omitted sentence above. Relocate the due-fire behavior to the create/update cron descriptions; preserve the explicit user-request exception in the TeamLeader shared-workspace caution; preserve "dissolve does not authorize branch deletion" (which is distinct from "dissolve never deletes a branch"); and either relocate the other omitted facts or label each proposed deletion as a user-visible change requiring an operator ruling. Correct D18 to point to the individual Feishu routing and collaboration-space descriptors rather than `bind_channel` alone.

2. **[High] The proposed skill bodies reintroduce tool contracts, contrary to the core requirement, and the subagent comparison asserts engine behavior Dreamux does not own.**

   **Claim.** The outline says a TeamMate is addressed by name, has durable history, receives pushed completion, reopens after close, and appears in `list`/`status` (draft:252-255); tells the reader how to divide values among `identity`, `prompt`, and `intent` (draft:265-266); and repeats waiting, follow-up, and close-note operation rules (draft:272-274). The TeamLeader outline adds an unconditional channel reply-tool path (draft:284-287). These are precisely tool/schema contracts that the requirement says must leave the skill body (`requirement.md:178-186`). They already have descriptor owners (`packages/dreamux/src/service/teammate-collection/mcp-tool-descriptors.ts:97-168,185-200,277-305`).

   The statement that a subagent shares the caller's session, returns inline, and cannot be addressed again (draft:250-253) is not a Dreamux contract at all. Subagents are engine-owned; this repository defines the TeamMate surface but no cross-engine subagent lifecycle. The unconditional reply path is also false when the active Channel exposes no reply tool (`.agents/domains/model-facing-writing.md:37,225`).

   **Recommended draft change.** Keep the skills at the methodology level: compare Dreamux-owned, independently continuing collaboration with engine-native delegation whose exact lifecycle must be read from that engine; explain how to provide outcome, context, boundaries, and evidence without naming schema fields; and retain ask-then-discuss. Remove receipt, history, naming, reopen, polling, close-note, and reply-tool instructions from the bodies. Any channel communication guidance must be conditional on an exposed provider tool.

3. **[High] The role prompt map describes a channel surface that does not exist as stated and is already drifting into a tool manual.**

   **Claim.** All three proposed prompts say there is one "connected channel's own server" with "reply and routing" tools (draft:39-40,52,59). In reality, Core creates one `channel-<configured-id>` delegate for every configured Channel whose provider supplies MCP, and supplies none for a provider without MCP (`packages/dreamux/src/service/channel-service/mcp-delegates.ts:40-59`, `packages/dreamux/src/service/channel-service/mcp-delegate.ts:104-112`). The built-in Feishu Dispatcher catalog includes reply, reaction, peer-bot discovery, binding, and collaboration-space policy; the TeamLeader catalog includes reply, reaction, peer-bot discovery, and self-scoped binding (`packages/channel/feishu-channel/src/tools/registry.ts:46-64`). "Reply and routing" therefore omits advertised families, while the singular/unconditional wording invents a server in some configurations.

   Enumerating every operation in long parentheticals and embedding Team/workspace/cron semantics also exceeds the requested family map. Prompt Shape says prompts route and state role boundaries rather than becoming manuals (`.agents/domains/model-facing-writing.md:94-97,124-130`). "The description and parameter descriptions are the tool's contract" is also too broad: schemas, annotations, results, and runtime outcomes remain authoritative parts of the contract (`model-facing-writing.md:132-163`).

   **Recommended draft change.** Replace the inventories with four compact, engine-neutral family entries: `teammate` (individual delegates and scoped workflows), `team` (Dispatcher Team management or the leader's own dissolve), `cron` (scheduled prompts for this role), and zero or more provider-defined `channel-*` servers when configured. Describe Channel capabilities generically rather than promising reply/routing specifically. Keep only the instruction to load the selected tool's definition/schema before calling it; remove the claim that two prose fields are the complete contract.

4. **[High] `cron_create.recurring` promises a fire that the service does not guarantee.**

   **Claim.** "false fires once and then disables the job" (draft:199) is false when the one-shot becomes due while the scheduler is stopped: startup disables it without submitting the prompt (`packages/dreamux/src/service/scheduler/service.ts:154-167`). It is also disabled after an unsuccessful due submission through the missed-fire path (`service.ts:287-289,323-346`). Only an accepted or ambiguous submission follows the stated fire-then-disable sequence (`service.ts:297-307`). The `true` default is correct (`service.ts:349-369`).

   **Recommended draft change.** Describe `false` as one-shot scheduling that disables after its scheduled opportunity, including a concise missed-while-stopped caveat, rather than promising exactly one fire. Use the same semantics for `cron_update.recurring`.

5. **[High] The proposed `reply.text` caution turns a broad/public-reply rule into a ban on every Feishu reply.**

   **Claim.** The current TeamLeader rule is scoped to "broad channel replies and public artifacts" and includes private context from other sources (`packages/dreamux/skills/team-leader/team-workflow/SKILL.md:84-87`). The Dispatcher prompt similarly scopes the restriction to broad/public delivery and includes private identifiers (`packages/dreamux/src/service/dispatcher-service/base-prompt.ts:29-32`). Draft D/T18 instead says to keep the listed values "out of it" for every `reply.text` (`draft.md:120,226`). That would incorrectly prevent an explicitly requested, appropriately targeted troubleshooting reply from containing a machine-local path, while also losing "private context from other sources" and private identifiers.

   **Recommended draft change.** Preserve the original audience boundary in the property/tool wording and retain all protected categories. Do not convert a broad/public disclosure caution into an unconditional content prohibition.

6. **[High] Marking the TeamLeader `bind_channel` description as an existing owner preserves wording explicitly banned by the writing rules.**

   **Claim.** T16 says the current descriptor already owns "ask the Dispatcher to move another Team's" (draft:119). The current descriptor does say that (`packages/channel/feishu-channel/src/tools/routing-tools.ts:181-190`), but the governing writing page explicitly says not to invent "ask the Dispatcher" or a reporting path when no such tool/runtime delivery mechanism exists (`.agents/domains/model-facing-writing.md:39-41`). "Exists" is therefore not evidence of correctness.

   **Recommended draft change.** Include this descriptor in the edit set and state only the positive authority boundary: a TeamLeader can bind a free or own conversation; moving another Team's route is outside this caller's surface. Remove the invented communication instruction from both the descriptor and the rewritten skill.

7. **[Medium] Several property descriptions are inaccurate or incomplete against their codecs and readers.**

   **Claim and evidence.**

   - `last.limit` says "newest page first" (draft:150), while the advertised result orders records oldest first (`packages/dreamux/src/service/teammate-collection/mcp-tool-descriptors.ts:121-128`). The limit default/max themselves are correct (`packages/dreamux/src/service/agent-entity/read-helpers.ts:147-157`).
   - Team `history.grep` is described as covering team name, repo, and intent only (draft:186), but it also searches leader name and close note (`packages/dreamux/src/service/team-collection/read-helpers.ts:64-73`). "as teammate.history" is additionally unsafe shorthand because Team and TeamMate status vocabularies differ (`team-collection/mcp-delegate.ts:333-344`, `teammate-collection/mcp-tool-descriptors.ts:67-82`).
   - `repo.base_ref` is used only when the requested branch does not already exist, and `repo.slug` supplies the default branch only when `branch` is omitted (`packages/dreamux/src/service/worktree/manager.ts:137-160`). Draft:140-142 states both effects unconditionally.
   - The existing `spawn.agent_runtime` description retained by draft:134 begins "Spawnable agents[].id" even though the actual output is `agent_runtimes[]` (`packages/dreamux/src/service/teammate-collection/mcp-tool-descriptors.ts:153-166,174-178`). Calling it "exists" leaves a malformed identifier path in the new all-properties contract.

   **Recommended draft change.** Give `last.limit` a limit/pagination meaning without contradicting result order; spell out Team history fields and its own status vocabulary; make the `base_ref` and `slug` effects conditional; and replace the malformed runtime-id description. Avoid cross-tool "as ..." descriptions where the contracts are not identical.

8. **[Medium] Both proposed frontmatter descriptions still contain an imperative load mandate.**

   **Claim.** "Load when you are about to ..." (draft:242-246,278-282) is a mandate, just narrower than the one being removed. The requirement asks the frontmatter to say when the skill is worth loading without a load-before-tools mandate (`requirement.md:178-184`), and the review question specifically requires avoiding a load mandate.

   **Recommended draft change.** Use descriptive trigger wording such as "Useful when ..." or "Guidance for ... especially when ...". Keep the explicit statement that tool calls do not depend on the skill, but do not phrase the new trigger as an imperative.

9. **[Medium] The catalog test is the right structural shape, but the prompt/skill negative coverage is incomplete.**

   **Claim.** Driving `describe()` for live Dispatcher/TeamLeader delegates and recursively asserting non-empty descriptions protects a schema contract rather than prose, and follows the existing live-catalog construction pattern (`packages/dreamux/tests/mcp-public-failures.test.ts:126-145,381-417`). `repoInputSchema()` is one closed object selected by `mode`, not a schema union (`packages/dreamux/src/service/worktree/repo-request.ts:21-40`), so the proposed test should simply recurse through every `properties` object rather than special-case a "repo union".

   The planned negative gate checks only the two Dispatcher constants (draft:327-329). It leaves the TeamLeader generated prompt and both skill descriptions unprotected even though the acceptance contract covers all four surfaces (`requirement.md:232-248`). Negative gates on stable banned coupling names are allowed; exact-sentence prose mirrors are not (`.agents/domains/model-facing-writing.md:194-214`).

   **Recommended draft change.** Keep the recursive catalog assertion and run it over both caller projections. Add a behavior-level observation of the generated TeamLeader system prompt (without exporting a private helper merely for testing) and a frontmatter-description check that bans the role-skill-as-tool-precondition coupling, using stable names/patterns rather than a full sentence. The existing bundled-skill test can remain unchanged; it only locks names, roots, files, and documentation mentions (`packages/dreamux/tests/bundled-skill-sources.test.ts:23-49,61-80`). I found no existing Feishu or prompt test with an exact description sentence that these edits would break.

10. **[Medium] One `dev-workflow` reference the draft says can stay would point at a skill that no longer contains the procedure.**

    **Claim.** The draft keeps all five step-scoped references (draft:308-313), but `references/team-dissolution.md` says to load and follow `team-workflow` before inspecting the worktree (`.agents/skills/dev-workflow/references/team-dissolution.md:14-15`). After this change, the skill intentionally contains no dissolve/tool facts, so that instruction becomes a false owner pointer. The implementation, solution-consultation, and implementation-review references do hand work to TeamMates and remain aligned with the new methodology purpose.

    **Recommended draft change.** Update the team-dissolution reference to follow the dissolve tool definition/worktree check directly, without loading `team-workflow`. The full non-archive grep otherwise found the owner/name references already considered by the draft: `dispatcher-skill.md`, `model-facing-writing.md`, `provider-runtime.md`, `dev-workflow` plus its four reference files/five occurrences, the package README, and the name-protection proposal. Historical changelogs need no edit.

11. **[Low] The `react` edit is unpaid scope, and the Feishu change-file bump should be `patch`, not `minor`.**

    **Claim.** No current role skill contains a `react` instruction. Correcting its "dispatcher channel" wording (draft:219-223,342-343) is useful cleanup, but it is neither relocated content nor a property-description requirement. The whitepaper requires every addition to be paid for (`.agents/skills/engineering-whitepaper/SKILL.md:29-37`), and requirement scope names Channel edits where a skill statement belongs (`requirement.md:190-200`).

    A Feishu Rush change file is necessary because `reply` and Dispatcher `bind_channel` model-facing package source does change (`requirement.md:228-230`; `.agents/domains/repository-operations-and-release.md:176-184`). However, `@excitedjs/feishu-channel` is already 5.0.0 (`packages/channel/feishu-channel/package.json:1-9`), and the requirement explicitly leaves tool names, schema types/constraints, results, annotations, and runtime behavior unchanged (`requirement.md:202-211`). These are compatible description corrections, so `minor` overstates the release surface.

    **Recommended draft change.** Remove the `react` edit from this task or explicitly obtain scope for the adjacent cleanup. Keep the Feishu change file for the required `reply`/binding description changes, but type it `patch` and describe it as model-facing guidance correction.

## Verified as correct

- The main ownership split is correct: prompts provide pre-schema routing, descriptors own operation/parameter facts, and the two role skills remain bundled as optional methodology.
- The existing descriptions do already cover concrete-name usage, `send` reopening, `last` cold/in-progress reads, recovery history, runtime-id discovery, workflow `{ run_id }` plus terminal delivery, Team submission receipts, dirty-worktree refusal, and caller-scoped binding. The draft is right not to duplicate those facts elsewhere once the wording issues above are fixed.
- The proposed `tz` default matches `Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'` (`packages/dreamux/src/service/scheduler/service.ts:349-369,504-505`), and workflow concurrency really defaults to 16 with range 1..16 (`packages/dreamux/src/service/workflow-service/limits.ts:3-24`). TeamMate/Team history limits default to 20 and cap at 100 (`agent-entity/read-helpers.ts:107-113`, `team-collection/read-helpers.ts:29-35`).
- The skill outline does cover the operator's three named methodological topics and distinguishes the Dispatcher choice (TeamMate versus Team) from TeamLeader shared-workspace coordination; the defects are the operational duplication and unstable subagent claims, not the overall outline.
- `packages/dreamux/README.md:27-35`, the role-root/name-protection assertions, and `BUNDLED_SKILL_NAMES` remain accurate and need no product-text change.
