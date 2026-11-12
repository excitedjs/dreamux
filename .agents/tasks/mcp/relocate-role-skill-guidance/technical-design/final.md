# Technical solution (final)

Input: [requirement.md](../requirement.md) as of the operator's path ruling on
2026-09-02. Author: TeamLeader. Reviewed by one Codex reviewer
([reviews/codex-review.md](reviews/codex-review.md)); adjudication in §10.

## 1. Shape of the change

Three model-facing surfaces change owners; nothing structural moves.

| Surface | Today | After |
| --- | --- | --- |
| Role prompts (`base-prompt.ts` ×2, `leader-agent.ts`) | "Load `<role>-workflow` before TeamMate/Team/channel/cron tools" | A compact tool map: which MCP servers this role has and what each is for, and "load a tool's definition before calling it". |
| MCP catalogs (`teammate`, `team`, `cron`; Feishu `reply`, both `bind_channel`) | Tool descriptions carry most facts; 2 of ~45 input properties have a description | Every input property has a one-sentence description; the facts and cautions that only the skills carried join the tool or property they are about. |
| `dispatcher-workflow` / `team-workflow` | MCP operation notes, mandated per turn | TeamMate-collaboration methodology, loaded on demand; the frontmatter says when it is useful and that tool calls do not depend on it. |

Entropy accounting:

- Removed: the load mandate at three prompt sites and in two frontmatter
  descriptions; ~10 KB of skill body that restated tool contracts; one KB
  claim that the skills own "tool cautions"; the invented "ask the
  Dispatcher" instruction on the TeamLeader `bind_channel`.
- Added: a 2-line tool map per role prompt (operator requirement for lazily
  loaded tools); ~45 property descriptions (operator requirement); short
  relocated cautions on `spawn`/`send`, TeamLeader `dissolve`, `force`,
  `note`, `cron_create`/`cron_update`, `reply`, `reply.message_id`,
  `reply.text`, Dispatcher `bind_channel.team_name`; two methodology skill
  bodies (operator-requested content); one structural test.
- Unchanged: skill names, roots, `BUNDLED_SKILL_NAMES`, required-source
  normalization, engine injection, tool names, schema types and constraints,
  results, annotations, the `workflow` and `dreamux-maintenance` skills, the
  `workflow_*` "load the bundled `workflow` skill" sentences.

## 2. Role prompts

The map names servers and their purpose. It does not enumerate operations or
explain semantics: both engines defer MCP definitions and find a tool by
server/name (Claude Code fetches by name; Codex filters an `ALL_TOOLS`
catalog by name and description), so the server names are what the model
needs before any definition is loaded, and the definition itself carries the
rest.

### 2.1 Dispatcher, replace prompt (`DREAMUX_DISPATCHER_BASE_INSTRUCTIONS`, `# Dispatcher Role`)

Replace the "Load `dispatcher-workflow` …" bullet with:

```
- Your Dreamux MCP servers: `teammate` (TeamMates you run directly, and scripted workflows), `team` (Teams: a TeamLeader with its own workspace and members), `cron` (scheduled prompts that wake this Dispatcher), and one `channel-<id>` server per configured channel that provides tools (that channel's own reply, routing, and policy tools; its schema is the authority).
- Load a tool's definition before calling it.
```

Every other bullet stays, including the `dreamux-maintenance` one.

### 2.2 Dispatcher, append prompt (`DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS`)

Opening sentence becomes:

```
You are running as a Dreamux Dispatcher. Your Dreamux MCP servers are `teammate` (TeamMates and scripted workflows), `team` (Teams), `cron` (scheduled prompts for this Dispatcher), and one `channel-<id>` server per configured channel that provides tools; load a tool's definition before calling it. Load `dreamux-maintenance` before Dreamux server operation, host diagnosis, daemon/service/config/log work, or missing-reply investigations.
```

### 2.3 TeamLeader (`teamLeaderSystemPrompt`)

```
You are the TeamLeader of Dreamux Team "<id>".
Your Dreamux MCP servers: `teammate` (this Team's members, who share the Team workspace, and scripted workflows), `team` (dissolve this Team), `cron` (scheduled prompts that wake this TeamLeader), and one `channel-<id>` server per configured channel that provides tools (that channel's own tools; its schema is the authority). Load a tool's definition before calling it.
When a prompt-submitting TeamMate tool returns success, … (existing no-poll sentence, unchanged)
<identity prompt, unchanged>
```

Neither prompt names the role skill: both engines list bundled skills by
name and description every turn, and the skill's own description says when
it is useful (§4).

## 3. Catalog changes

### 3.1 Relocation table

Every statement of the two current skills and its owner after this change.
"exists" means the owner already says it today and the skill line is
deleted. "dropped" rows state the reason; none removes a capability.

| # | Skill statement | Owner after |
| --- | --- | --- |
| F1 | Frontmatter: "Load before using TeamMate, Team, workflow, channel, or cron tools" (both skills) | replaced by the §4 descriptions; the prompt map §2 owns "what exists before loading" |
| D1 | Use `dreamux-maintenance` for server operation … | Dispatcher prompts, exists |
| D2/T1 | TeamMate verbs; scope (this Dispatcher's / this Team's) | prompt map §2; `get_capabilities.verbs` |
| D3/T2 | `name_prefix` is a label; use the returned concrete name | `spawn` description exists; new `name_prefix` and `name` property descriptions |
| D4/T5 | `send` reopens a closed TeamMate | `send` description exists |
| D5/T6 | Wait for the pushed completion; every settled turn is reported, including failed or stopped; `status`/`last`/`history` for explicit checks, recovery, delivery doubt | prompt no-poll sentence exists; receipt reminder exists; **new** clause on `spawn`/`send`: "Dreamux pushes the turn's completion back into your context whether it finished, failed, or was stopped."; `status` description gains "for an explicit check"; `last`/`history` exist |
| D6/T7 | `history` compact recovery; `last` reads without starting, shows a running turn | exist |
| D7/T8 | `get_capabilities.agent_runtimes[].id` for `agent_runtime` | exists; the property description is corrected (§3.2) |
| D8 | `spawn.repo` optional; omitted → per-TeamMate work dir; managed → git worktree; reuse-cwd → existing path | `spawn` description exists; new property descriptions inside `repoInputSchema()` (shared with `team.create`) |
| D9/T9 | Workflow tools on the same server; load `workflow` skill; `{ run_id }` and pushed terminal completion | exist |
| D10 | Team verbs; where a Team is reachable is a channel fact | prompt map; `team.list` description exists |
| D11 | `create.name_prefix` label; concrete never-reused `team_name` | exists; new property description |
| D12 | `create` starts a TeamLeader; `send` reaches the leader only, not members, not a channel | exist |
| D13 | `create.prompt` optional; idle until routed inbound or a later `send` | exists; new property description |
| D14/T14 | `dissolve` is a submission; never reports the outcome; `note` records why | exist; new `note` description |
| D15 | Dirty worktree leaves the Team open; read `status` afterwards; do not report dissolved on the receipt | Dispatcher `dissolve` exists |
| D16/T11 | `force` discards local work; never the branch, commits, reused dir, source repo | exists; new `force` property description |
| T13 | Branch deletion is a separate destructive capability; never inferred from `delete-on-close` | **new** clause on both `dissolve` descriptions after "never deletes the branch …": "deleting them is a separate decision that is the user's" |
| T14b | Eligible worktree deletion may continue in the background after the Team is closed | dropped: the TeamLeader is stopped behind the receipt and cannot act on this; the Dispatcher `dissolve` already says to read the Team's status afterwards |
| D17/T15 | Channel tools come from the channel's own server; read its schema | prompt map ("its schema is the authority") |
| D18 | Routing is a channel operation; Feishu bind/unbind/list_bindings and collaboration-space tools; rebind reports the previous Team; "there is no separate transfer tool" | each Feishu descriptor's own description exists (`routing-tools.ts`, `space-tools.ts`); the "no separate tool" sentence is history prose, dropped |
| D19 | A bind names an existing, open Team; missing or closed is refused, routing unchanged | **new** Dispatcher `bind_channel.team_name` property description |
| D20/T17 | Reply tool for meaningful progress, blockers, final status; assistant text is not delivery | Dispatcher prompt exists; per-message `CHANNEL_REMINDER` exists; **new** `reply` description sentence so a TeamLeader reads it where it acts |
| D21/T17b | Report at key milestones; prefer the latest user message's channel source; reply to the source message unless the request names another target | `reply` description ("at key milestones") and **new** `reply.message_id` property description |
| D22 | Channel selectors are channel-owned; do not infer them | Dispatcher prompt exists; `chat_id` property descriptions exist |
| D23/T19 | Cron verbs; prompts wake this agent; no spawn, no channel delivery | prompt map; `cron_create` description exists |
| D24 | A due job is submitted through ordinary admission and may fold into a running turn | **new** clause on `cron_create` and `cron_update`: "A due job submits its prompt at once, even while a turn is running." |
| D25 | Prefer explicit titles and time zones; off-hour minutes collide less | `cron_create` exists (off-:00/:30); new `title` and `tz` property descriptions |
| D26 | Jobs fire on their schedule; `cron_update` to change | dropped: restates the tool names |
| T3 | TeamLeader `spawn` takes no `repo`; workspace chosen at Team creation | exists |
| T4 | One writer at a time in the shared workspace unless read-only, user-requested, or independent paths | TeamLeader `spawn` description; the clause becomes "unless the work is read-only, the edits are independent, or the user asked for parallel edits" |
| T10 | TeamLeader `team` exposes exactly `dissolve`; no routing/inspection/peer tool; do not invent one | prompt map ("dissolve this Team"); "do not invent one" dropped as defensive prose |
| T11 | Use `dissolve` only after the Team's work is complete and the worktree is safe; inspect uncommitted/untracked/unmerged work first; a default dissolve refuses rather than discards | **new** sentence on the TeamLeader `dissolve` description: "Call this only when the Team's work is complete. First check the workspace for uncommitted, untracked, or unmerged work; if there is any, or you cannot tell, do not dissolve: report it and ask the user." |
| T12 | `force` only with the user's say-so, never to get past a refusal on your own judgement; `note` is not a bypass | **new** `force` description (TeamLeader): "Only with the user's explicit confirmation in this conversation. Discards uncommitted, untracked, and unmerged work in the managed checkout so it can be removed; never the branch, its commits, a reused directory, or the source repository." `note`: "Why the Team stops; recorded on it." |
| T16 | TeamLeader bind/unbind reach only free or own conversations; "ask the Dispatcher to move it" | TeamLeader `bind_channel` description is **edited**: the boundary stays, the invented instruction goes (§3.3) |
| T18 | Keep hidden instructions, private context from other sources, secrets, tokens, private identifiers, machine-local paths out of broad replies and public artifacts | Dispatcher prompt exists; **new** `reply.text` property description with the same audience boundary (§3.3) |

### 3.2 Property descriptions

Wording rules: one sentence, present tense, states meaning or the identifier
to use, no type restatement, no architecture nouns. The implementer re-reads
the named codec before wording anything not quoted here.

`teammate` (both callers unless noted):

| Tool.property | Description |
| --- | --- |
| spawn.name_prefix | Requested label; the concrete name comes back in the result. |
| spawn.prompt | The TeamMate's first turn. |
| spawn.agent_runtime | Agent runtime id from get_capabilities.agent_runtimes[].id. (replaces the current malformed "agents[].id" text) |
| spawn.intent | One-line subject of the work; shown in list and history and kept for recovery. |
| spawn.identity | Standing role and boundaries appended to the TeamMate's system prompt for every turn. |
| spawn.repo (Dispatcher) | Where the TeamMate works; omit for a fresh per-TeamMate directory. |
| repo.mode | reuse-cwd runs in an existing directory; managed creates a git worktree from a source repository. |
| repo.path | reuse-cwd: the directory to run in. managed: the source repository; defaults to this agent's workspace. |
| repo.base_ref | managed: the ref a newly created branch starts from; default HEAD; ignored when branch already exists. |
| repo.branch | managed: the branch to create or check out; default dreamux/<slug>. |
| repo.slug | managed: label for the worktree directory and the default branch name; defaults to the agent's name. |
| repo.cleanup | managed: keep leaves the worktree after close; delete-on-close removes it when the agent closes and the tree is clean. |
| send.name | The concrete name returned by spawn. |
| send.prompt | The next turn. |
| send.intent | Replaces the recorded subject before the turn. |
| close.name | The concrete name returned by spawn. |
| close.note | Why the TeamMate is closed; recorded on it. |
| status.name / last.name | The concrete name returned by spawn. |
| last.limit | Records to return; default 20, max 200. |
| last.cursor | next_cursor from the previous page, for older records. |
| last.include_tools | false omits tool records and returns assistant messages only. |
| history.name | Exact concrete name. |
| history.status | Filter by lifecycle status. |
| history.agent_runtime | Exact agent runtime id. |
| history.repo | Case-insensitive substring of the source repository path. |
| history.grep | Case-insensitive substring over name, agent runtime, source repository, intent, and close note. |
| history.since / until | Epoch milliseconds compared with each record's last update. |
| history.limit | Rows per page; default 20, max 100. |
| history.cursor | next_cursor from the previous page. |
| workflow_run.script | Inline workflow module source. |
| workflow_run.scriptPath | Path to a workflow module file readable by the Dreamux server. |
| workflow_run.args | (exists) |
| workflow_run.max_concurrency | Agents allowed to run at once; default 16, range 1..16. |
| workflow_status.run_id / workflow_stop.run_id | The run_id returned by workflow_run. |

`team` (Dispatcher):

| Tool.property | Description |
| --- | --- |
| create.name_prefix | Requested label; the concrete team_name comes back in the result. |
| create.repo | Where the Team works; omit for a fresh shared directory. (nested: the shared `repoInputSchema()` texts; "agent's name" reads as the Team's) |
| create.leader_agent_runtime | Agent runtime id for the TeamLeader, from get_capabilities.agent_runtimes[].id on the teammate server. |
| create.intent | One-line subject of the Team's work; shown in list and history and kept for recovery. |
| create.identity | Standing role and boundaries appended to the TeamLeader's system prompt for every turn. |
| create.prompt | The TeamLeader's first turn; omit to start it idle until a routed inbound or a later send. |
| send.team_name | The concrete team_name returned by create. |
| send.prompt | The next turn for the TeamLeader. |
| send.intent | Replaces the Team's recorded subject before the turn. |
| status.team_name | The concrete team_name returned by create. |
| history.team_name | Exact concrete team_name. |
| history.status | Filter by Team status: starting, running, or closed. |
| history.repo | Case-insensitive substring of the source repository path. |
| history.grep | Case-insensitive substring over team_name, intent, source repository, leader name, and close note. |
| history.since / until | Epoch milliseconds compared with each record's last update. |
| history.limit | Rows per page; default 20, max 100. |
| history.cursor | next_cursor from the previous page. |
| dissolve.team_name | The concrete team_name returned by create. |
| dissolve.note | Why the Team stops; recorded on it. |
| dissolve.force | Discards uncommitted, untracked, and unmerged work in the managed checkout so it can be removed; never the branch, its commits, a reused directory, or the source repository. |

`team` (TeamLeader): `dissolve.note` and `dissolve.force` as in §3.1 T12.

`cron`:

| Tool.property | Description |
| --- | --- |
| cron_create.cron | Standard 5-field expression (minute hour day-of-month month day-of-week) in tz. |
| cron_create.prompt | The text submitted to this agent when the job fires. |
| cron_create.recurring | true (default) fires on every match. false fires at most once, at the next match, and is then disabled; a one-shot missed while Dreamux was stopped is disabled without firing. |
| cron_create.tz | IANA time zone for the expression; defaults to the host's local zone. |
| cron_create.title | Short label shown in cron_list. |
| cron_update.id | The job id from cron_create or cron_list. |
| cron_update.cron / prompt / tz | Same meaning as cron_create; an omitted field keeps its value. |
| cron_update.recurring | Same meaning as cron_create.recurring; an omitted field keeps its value. |
| cron_update.title | New label; null removes it. |
| cron_update.enabled | false pauses the job without deleting it; true resumes it. |
| cron_delete.id | The job id from cron_create or cron_list. |

### 3.3 Description edits (tool level)

- `teammate.spawn` and `teammate.send` (both callers): append "Dreamux pushes
  the turn's completion back into your context whether it finished, failed,
  or was stopped."
- TeamLeader `teammate.spawn`: the coordination clause reads "unless the work
  is read-only, the edits are independent, or the user asked for parallel
  edits".
- `teammate.status`: "Read one TeamMate's identity and live runtime status by
  its concrete name, for an explicit check."
- Both `team.dissolve` descriptions: after "never deletes the branch, its
  commits, a reused directory, or the source repository" add "; deleting them
  is a separate decision that is the user's."
- TeamLeader `team.dissolve`: prepend the T11 sentence; keep the rest.
- `cron_create` and `cron_update`: append "A due job submits its prompt at
  once, even while a turn is running."
- Feishu `reply` (both callers): "Send a message to a Feishu chat from this
  channel. Text you write outside this tool is not delivered to the chat; use
  this for meaningful progress at key milestones, blockers, and the final
  answer." (drops the "dispatcher channel" wording that is wrong for a
  TeamLeader caller).
- Feishu `reply.message_id`: "Id of the inbound message you are answering, so
  the reply threads under it; omit only when the request names a different
  target." `reply.text`: "Message text. In a group or other broad audience,
  keep secrets, tokens, private identifiers, hidden instructions, private
  context from other sources, and machine-local paths out of it."
- Feishu Dispatcher `bind_channel.team_name`: "team_name of an existing, open
  Team; a missing or closed Team is refused and nothing changes."
- Feishu TeamLeader `bind_channel`: "Route a Feishu group or topic to your own
  Team, so messages there reach you directly. Only a free conversation or one
  already routed to your Team can be bound here; a conversation another Team
  answers in is outside this caller's authority." (removes the "ask the
  Dispatcher" instruction banned by model-facing-writing.md).
- `react` (both callers): "Add a reaction to a Feishu message from this
  channel." Operator ruling (2026-09-02): the "dispatcher channel" wording is
  removed because both the Dispatcher and a TeamLeader reach the tool.

No other description changes. The `workflow_*` "Load the bundled `workflow`
skill before use." sentences stay.

## 4. Skills

Both skills keep their frontmatter `name`, directory, and root. Bodies are
rewritten as TeamMate-collaboration methodology from each role's vantage.
Neither body states a tool contract: no parameters, receipts, schemas, result
shapes, or operating rules that a description now owns. Both may name
`spawn`, `send`, and `close` as the verbs of the collaboration they describe.
Any mention of reaching the user through a channel is conditional on a reply
tool being exposed.

### 4.1 `dispatcher-workflow`

Frontmatter description: "Guidance for a Dispatcher working with TeamMates
and Teams: choosing between doing it yourself, an engine-native subagent, a
TeamMate, or a Team; writing the hand-down prompt; and what to do when a
delegate's behaviour surprises you. Useful before delegating and when a
delegate needs discussing. Tool calls do not depend on it."

Body outline:

1. **Yourself, a subagent, a TeamMate, or a Team.** An engine-native subagent
   is delegation inside your own turn and engine; read your engine's own
   description of it for its lifecycle. A TeamMate is a Dreamux peer that
   continues independently: its own runtime and context, its own history,
   a conversation you can continue across turns, visible to the user. A Team
   is a TeamLeader with its own workspace and members, for work that needs a
   coordinator of its own. Choose by whether the work outlives your turn,
   needs its own context or workspace, may need to be inspected or continued
   by the user, or needs its own coordination.
2. **Writing the hand-down prompt.** State the outcome and the evidence that
   would show it, not the steps. Give the context the TeamMate cannot see:
   the source request, constraints, files, what is already known or ruled
   out. Set the boundary: what not to touch, read-only or writing, one writer
   per workspace. Ask for a report shape: what changed, evidence, open
   questions. Standing role and boundaries belong with the TeamMate for every
   turn; the task belongs to the turn.
3. **When a TeamMate does something you did not expect.** Ask it why before
   overriding; read its reasoning. It may have seen something you did not;
   the goal is two perspectives, not one corrected one. Discuss until you
   converge; only then restate the boundary, or end the collaboration with a
   note that says what was learned.
4. **Keeping the thread.** Continue with the same TeamMate for follow-ups on
   the same work rather than starting another; a fresh TeamMate has none of
   the context the conversation built.

### 4.2 `team-workflow`

Frontmatter description: "Guidance for a TeamLeader working with this Team's
TeamMates: TeamMate versus engine-native subagent, writing the hand-down
prompt for a shared workspace, and what to do when a TeamMate's behaviour
surprises you. Useful before handing work down and when a TeamMate needs
discussing. Tool calls do not depend on it."

Body: the same four sections from the TeamLeader's vantage: no Team choice;
members share one workspace (one writer at a time, disjoint identities such
as developer and reviewer, task artefact paths in the prompt); the user is
reached through whatever visible reply path the connected channel exposes.

Both bodies are first drafts for operator review; the outline is the
operator's, and later additions are ordinary skill edits.

## 5. Knowledge and docs

- `.agents/domains/dispatcher-skill.md`: rewrite the two skill bullets
  (methodology, on demand); replace "The bundled `team-workflow` skill tells a
  TeamLeader to check … before dissolving" with "The TeamLeader `dissolve`
  description tells it to check …"; keep the guidance-vs-authority
  distinction; state in the MCP sections that every input property is
  described.
- `.agents/domains/model-facing-writing.md`: Prompt Shape bullets: replace
  "load `dispatcher-workflow` before …" with "map the role's MCP servers and
  say to load a tool's definition before calling it"; MCP Descriptions: add
  "every input property carries a one-sentence description".
- `.agents/domains/provider-runtime.md`: role-gate bullets stay (names
  unchanged); "the tool surfaces those skills describe" becomes "what each
  skill is for".
- `packages/dreamux/README.md`: no change.
- `.agents/skills/dev-workflow/SKILL.md` line 123: "Load and follow
  `team-workflow` before using TeamMate or Team tools" → "Load `team-workflow`
  when composing a hand-down prompt for a TeamMate".
  `references/team-dissolution.md`: drop "load and follow `team-workflow`,
  then"; the worktree inspection steps stay as written. The other four
  references ("Load and follow `team-workflow`, then start …") stay: they
  hand work down, which is what the skill is now about.
- `.agents/proposals/admin-control-plane-surface.md`: unchanged.
- Task record: `verification.md` when implementation starts; README delivery
  fields.

## 6. Tests

- New `packages/dreamux/tests/mcp-tool-descriptions.test.ts`: for the
  `teammate` catalog (`teammateToolDescriptors('dispatcher')` and
  `('team_leader')`), the `team` catalog (`createTeamMcpDelegate` for both
  callers, `describe()`), and the `cron` catalog (`createCronMcpDelegate`,
  `describe()`): walk every `inputSchema.properties` object recursively (the
  `repo` object included) and assert a non-empty string `description` on each
  property. Negative gates on stable names, not sentences: the two exported
  Dispatcher prompt constants do not contain "`dispatcher-workflow`"; the two
  bundled `SKILL.md` frontmatter descriptions do not contain "before using".
- The TeamLeader prompt builder is private and no existing test captures a
  TeamLeader launch context; the acceptance grep covers it. No test-only
  export.
- `bundled-skill-sources.test.ts`, Feishu routing/messaging tests: unchanged.

## 7. Change files

- `@excitedjs/dreamux`, `minor`: Dispatcher and TeamLeader prompts no longer
  ask the model to load `dispatcher-workflow`/`team-workflow` before tool
  use; those bundled skills now hold TeamMate-collaboration methodology and
  are loaded on demand; every Dreamux MCP tool input property carries a
  description and tool descriptions carry the cautions the skills used to.
- `@excitedjs/feishu-channel`, `patch`: `reply`, `react`, and both
  `bind_channel` descriptions and property descriptions; no schema, name,
  result, or behavior change.

## 8. Verification

- `rush build`, `rush lint`, `rush test`, `.agents/scripts/check.sh`.
- Acceptance grep from the requirement returns nothing.
- Dump both callers' `teammate`/`team` catalogs and the `cron` catalog in a
  script and read every description once as the model would.
- Manual: start a Team on this branch, read the TeamLeader's system prompt in
  the runtime log, confirm the tool map and the absence of the load line.

## 9. Risks and rejected alternatives

- *One shared methodology skill instead of two role skills.* Rejected: the
  operator ruled the two skills stay; a third skill is a new entity. Two
  self-contained bodies with a shared outline are plain repetition.
- *Naming the optional skill in the prompt.* Rejected: the engine already
  lists skill name and description every turn.
- *Listing every tool name in the prompt map.* Rejected after review: both
  engines find deferred tools by server, and the operation list is what the
  definitions are for.
- *Description length.* Neither engine carries MCP definitions in the prompt,
  so description length is paid per load, not per turn.

## 10. Review adjudication

Findings from [reviews/codex-review.md](reviews/codex-review.md), each with
the TeamLeader's ruling after checking the cited code.

1. Relocation table incomplete — **accepted.** Rows F1, T13, T14b, T17b,
   D24 added; T4 keeps the user-request clause; D18 corrected to each Feishu
   descriptor. T14b is the one labeled drop (§3.1).
2. Skill bodies restate tool contracts; subagent claims are engine-owned —
   **accepted.** Bodies now describe what a TeamMate is without naming
   receipts, history tools, field mapping, polling, or close notes; the
   subagent comparison defers to the engine's own description; channel
   mention is conditional. The operator's item 1 (TeamMate vs subagent)
   stays, phrased that way.
3. Prompt map invents a single channel server and drifts into a manual —
   **accepted.** Verified `channel-<id>` per configured channel with an MCP
   capability (`channel-service/mcp-delegates.ts`). Map reduced to server
   names plus purpose; "the description and parameter descriptions are the
   contract" removed.
4. `recurring:false` promises a fire — **accepted.** Verified
   `scheduler/service.ts` `reconcile` and `rearmAfterMiss`; wording in §3.2.
5. `reply.text` caution overbroad — **accepted.** Audience boundary and all
   categories restored.
6. TeamLeader `bind_channel` "ask the Dispatcher" is banned wording —
   **accepted.** Descriptor edited (§3.3).
7. Property inaccuracies — **accepted.** Verified `worktree/manager.ts`
   (base_ref only for a new branch; slug default = agent name; branch default
   `dreamux/<slug>`), `team-collection/read-helpers.ts` (grep fields), result
   order of `last`; `agent_runtime` text replaced.
8. Frontmatter still imperative — **accepted.** Descriptive trigger wording.
9. Test coverage — **partially accepted.** Recursive walk over one closed
   `repo` object; frontmatter negative gate added. The TeamLeader prompt gate
   is not added: no existing test captures a TeamLeader launch context, and
   building one for a prose gate is not paid; the acceptance grep covers it.
10. `team-dissolution.md` reference — **accepted.**
11. `react` unpaid; Feishu change type — **accepted on the change type**
    (`patch`, package is 5.0.0 and nothing but description text changes);
    `react` was kept as a labeled adjacent correction and the operator then
    ruled explicitly that the "dispatcher channel" wording goes (README,
    Development approval).
