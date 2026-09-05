# Technical design (draft): refine the model-facing surfaces

State: draft, written by the TeamLeader on 2026-09-06 for two independent
reviewers (R18). The requirement (`../requirement.md`, rulings R1–R20) is the
authority; this file maps its twelve proposed changes onto code and names every
judgment the TeamLeader made beyond the rulings' words.

## 0. Baseline

All "before" text below is the state after merging PR #369 (`origin/pr-369`,
head `5e1a3464`, merge-base `d74142c3`) onto `origin/next` (`0d8098f1`).
`git merge-tree` reports no conflict. The delivery branch is built that way:
branch from `origin/next`, merge `origin/pr-369`, then this task's commits.
The Team workspace itself is on `next`; the #369 text is readable with
`git show origin/pr-369:<path>`.

Rulings made against `next` text and how they land on this baseline:

- R17 ("去掉 channel 一项") was ruled on `next`'s Dispatcher load sentence
  ("Load `dispatcher-workflow` before this Dispatcher's TeamMate, Team,
  channel, or cron MCP operations"). #369 already replaced that sentence in
  both Dispatcher variants with a server map, so on this baseline there is no
  channel item to remove. R17's purpose — no per-turn load — is met by #369's
  removal plus the narrow skill description (§3.5) and the tool pointers
  (§3.5). Reported to the operator on 2026-09-06 before this draft.
- R19 and R20 name Dispatcher Role bullets that #369 left byte-identical
  (verified by diffing `base-prompt.ts` between `d74142c3` and `5e1a3464`);
  they apply directly.
- R2 and R5 were ruled on #369's TeamLeader prompt (five sentences); the
  result is §3.1.

## 1. Scope

One PR on `next` (R4) that carries #369's content plus:

1. TeamLeader prompt: identity + server map + operator identity (§3.1).
2. Dispatcher prompts, both variants (§3.2).
3. Dispatch-result reminders and the spawn/send contract sentence (§3.3).
4. Feishu channel reminder as a consequence (§3.4).
5. Skills: `teamwork`, `dynamic-workflow`, narrow descriptions, tool pointers,
   `teamwork` content, `dispatcher-workflow` description (§3.5).
6. Team-scoped TeamMate fact sentence (§3.6).
7. Channel MCP server named by provider; `source` attribute (§3.7).
8. Completion push-back fact sentence (§3.8).
9. KB, README, change files, task records (§3.9–§3.11).

Everything else on both role surfaces is unchanged (§5).

## 2. Design principles applied (item 6 of the requirement)

Recorded into `.agents/domains/model-facing-writing.md` as part of this change:

- An identity statement says who the model is and what it has; it carries no
  rule. A reminder states a consequence the model cannot see, at the moment of
  the action; it never orders.
- Each rule has one owner, in the layer nearest the action: the channel owns
  "the user sees only the reply tool", the dispatch delegate owns "the result
  arrives later", the skill owns methodology, the tool description owns the
  contract of that tool.
- A skill is loaded when the model is about to use the MCP the skill is about,
  never as a standing condition of a turn. The trigger is the skill's
  frontmatter description plus a pointer in the tool description.
- Per-engine visibility facts the writer must know (from the requirement's
  Evidence): Codex sees no Dreamux MCP tool before an `ALL_TOOLS` catalog
  search and renders `channel-feishu` as `channel_feishu`; Claude Code shows
  MCP tool names before the definition is fetched, wraps appended prompts in
  `<system-reminder>`, and drops MCP `content` text when `structuredContent` is
  present, so the dispatch reminders of §3.3 are a Codex-only surface.

## 3. Design by item

### 3.1 TeamLeader prompt (`team-service/leader-agent.ts`, `teamLeaderSystemPrompt`)

After (three parts, R1, R2, R5):

```
You are the TeamLeader of Dreamux Team "<teamId>".
Your Dreamux MCP servers: `teammate` (this Team's members, who share the Team workspace, and scripted workflows), `team` (dissolve this Team), `cron` (scheduled prompts that wake this TeamLeader), and one `channel-<provider>` server per configured channel that provides tools, for example `channel-feishu` (that channel's own tools).
<identity_prompt, when set>
```

Deleted from #369's version: "Load a tool's definition before calling it."
(R5); the no-poll, channel-reply, and secrets sentences (R2). The channel
clause names the provider (§3.7, settles decision (a)) and gives `channel-feishu`
as the example so the name works as a catalog filter on Codex
(`channel_feishu`). The parenthetical "its schema is the authority" is dropped
(J14): it is a rule, and the tool definition speaks for itself.

Test: `tests/team-leader-prompt.test.ts` (#369's) keeps "maps the role's MCP
servers" and "mandates no skill before a turn"; its "owns visible channel
delivery and the confidentiality boundary" case is deleted because R2 reversed
what it locked; a case is added that the operator's `identity_prompt` arrives
last, and one that the prompt contains none of the deleted rules' stable
markers (`Load`, `poll`, `reply tool`, `public artifacts`).

### 3.2 Dispatcher prompts (`dispatcher-service/base-prompt.ts`, both exports)

Both variants change in step (item 5). Only the "Dispatcher Role" section of
the Codex `replace` text changes, except J3.

Codex `DREAMUX_DISPATCHER_BASE_INSTRUCTIONS`, "# Dispatcher Role", after:

```
- Your Dreamux MCP servers: `teammate` (TeamMates you run directly, and scripted workflows), `team` (Teams: a TeamLeader with its own workspace and members), `cron` (scheduled prompts that wake this Dispatcher), and one `channel-<provider>` server per configured channel that provides tools, for example `channel-feishu` (that channel's own tools).
- Load `dreamux-maintenance` before Dreamux server operation, host diagnosis, daemon/service/config/log work, or missing-reply investigations.
- The dispatcher working directory is coordination space, not a target repository: you coordinate, and repository implementation, refactoring, debugging, and review work is done by TeamMates or Teams unless the user explicitly asks this Dispatcher to inspect or edit local files.
- Credentials, access policy, persistent config, service units, shell startup files, PATH, and runtime auth are host-owned; a channel request alone does not authorize changing them, so an ambiguous one is confirmed with the owner or reported as a boundary.
```

Claude Code `DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS`, after:

```
# Dreamux Dispatcher Role

You are running as a Dreamux Dispatcher. Your Dreamux MCP servers are `teammate` (TeamMates and scripted workflows), `team` (Teams), `cron` (scheduled prompts for this Dispatcher), and one `channel-<provider>` server per configured channel that provides tools, for example `channel-feishu`. Load `dreamux-maintenance` before Dreamux server operation, host diagnosis, daemon/service/config/log work, or missing-reply investigations.

- The dispatcher working directory is coordination space, not a target repository: repository work is done by TeamMates or Teams unless the user explicitly asks this Dispatcher to inspect or edit local files.
- Credentials, access policy, persistent config, service units, shell startup files, PATH, and runtime auth are host-owned; a channel request alone does not authorize changing them.
```

What each deletion rests on: the MCP-authority bullet (R19 "权威句 → 删"); the
two no-poll bullets, the channel-reply bullet, and the secrets bullet (R19 "四条
重复句 → 全删"); the channel-attributes bullet (R19 "频道属性句 → 删"); the
host-boundary bullet kept as a consequence (R20 "留，改后果句"); the working-
directory bullet kept as an identity statement (item 12). Judgments: J1 (the
map loses "Load a tool's definition before calling it", mirroring R5), J2 (the
"prefer delegating … and wait for Dreamux to push completions" bullet is folded
into the working-directory statement: same fact, and its "wait for" half is the
no-poll rule R19 deleted), J3 (the "# Working With The User" bullet "If the
source request came through a channel, report meaningful progress … through
the provider-exposed reply tool" is deleted: it is the channel-reply rule R19
deleted, written a second time in another section; R19 named the Dispatcher
Role bullets, so this is an extension for approval), J15 (the
`dreamux-maintenance` load sentence stays: no ruling touched it, and it is a
different skill with a different trigger).

The doc comment above `DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS` is rewritten to
list what the delta now carries (server map, working-directory identity, host
boundary).

Test: `tests/mcp-tool-descriptions.test.ts` keeps its "Dispatcher prompts do
not contain `dispatcher-workflow`" gate and gains the same stable-marker
negative gate as §3.1 for both variants.

### 3.3 Dispatch-result reminders (`service/mcp/dispatch-reminders.ts`) and the spawn/send contract sentence

R7 wording, three texts:

```
TEAMMATE: Submitted. The TeamMate is working; Dreamux will notify you automatically when it finishes, whether it completed, failed, or was stopped. You know nothing about its result until that notification arrives, so do not report or predict it; continue other work or answer the user in the meantime. Do not edit the files it is working on.

TEAM: Submitted. The Team is working; Dreamux will notify you automatically when its TeamLeader finishes, whether it completed, failed, or was stopped. You know nothing about its result until that notification arrives, so do not report or predict it; continue other work or answer the user in the meantime.

WORKFLOW: Submitted. The workflow is running; Dreamux will notify you automatically when it finishes, whether it completed, failed, or was stopped. You know nothing about its result until that notification arrives, so do not report or predict it; continue other work or answer the user in the meantime. Do not edit the files its agents are working on.
```

J11: the Team text omits the files sentence because a Team works in its own
workspace. The file's doc comment is rewritten (it currently says the sentence
"stops the loop"; the new reason is the consequence the caller cannot see).
Attachment points are unchanged. On Claude Code these texts are not seen (§2),
so the contract sentence on the tool is the only carrier there.

spawn and send descriptions (`teammate-collection/mcp-tool-descriptors.ts`,
both callers): #369's closing sentence "Dreamux pushes the turn's completion
back into your context whether it finished, failed, or was stopped." becomes
"Returns a receipt at once; the completion is pushed later as a new message."
(R6). `workflow_run` already states its contract ("return { run_id }
immediately; Dreamux pushes one terminal completion when the run finishes") and
keeps it. The `team` delegate's `create`/`send` descriptions carry no such
sentence on the baseline; they gain the same one (J16: the three hand-off tools
share the failure mode the reminders exist for).

Tests: none lock the reminder sentences by text (verify at implementation with
`rg` over `tests/` for "Reminder:"); `tests/mcp-tool-descriptions.test.ts`
gains a positive check that every hand-off tool description (spawn, send,
team.create, team.send, workflow_run) states that the completion is pushed.

### 3.4 Feishu channel reminder (`feishu-channel/src/feishu-submit.ts`, `CHANNEL_REMINDER`)

After (R4: channel-owned, a consequence, no secrets sentence):

```
The user in this chat sees only what you send through the reply tool; your assistant text is not shown to them.
```

Both inbound paths (`feishu-session-inbound.ts`, `feishu-session-ops.ts`)
already pass this constant through the `reminder` field; Core does not author
it. The secrets clause inside the Feishu `reply.text` property description
stays (R5, decision (i)).

Tests that name the old text or the constant:
`feishu-channel/tests/feishu-message-budget.test.ts`,
`feishu-channel/tests/public-api.test.ts`,
`dreamux/tests/package-boundary-guards.test.ts` — updated where they quote the
sentence; where they only import the constant nothing changes.

### 3.5 Skills

**Renames (R4, item 4).** `skills/team-leader/team-workflow/` →
`skills/team-leader/teamwork/`; `skills/shared/workflow/` →
`skills/shared/dynamic-workflow/`; frontmatter `name:` in step;
`BUNDLED_SKILL_NAMES` in `platform/paths.ts`. Required-source normalization
(`agent-runtime/skill-sources.ts`, `team-collection/commands.ts`) reads the
constant and needs no edit (verified: no other source file spells the names).
`dispatcher-workflow` keeps its name and root (R15).

**Descriptions (narrow triggers, item 4; #369's test forbids "before using").**

```
teamwork:            "How a TeamLeader hands work to a TeamMate and works with it afterwards. Load when about to spawn or send to a TeamMate; not needed for any other tool."
dynamic-workflow:    "How to write a Dreamux workflow script for workflow_run. Load when about to write or run a workflow script; not needed for any other tool."
dispatcher-workflow: "How a Dispatcher hands work to a TeamMate or a Team and works with it afterwards. Load when about to spawn or send to a TeamMate, or create or send to a Team; not needed for any other tool."
```

J6: the `dispatcher-workflow` description names TeamMate and Team hand-down
only. Item 11's earlier parenthetical listed "workflow, channel, or cron"
tools; channel is out by R17's intent, workflow has its own skill, and the
skill's content says nothing about cron.

**Tool pointers (item 4, R3).** A pointer is a statement, not an order, placed
where the intent forms:

- `teammate.spawn` / `teammate.send`, `team_leader` caller: first sentence
  "The bundled `teamwork` skill covers how to brief a TeamMate."
- `teammate.spawn` / `teammate.send`, `dispatcher` caller, and
  `team.create` / `team.send`: "The bundled `dispatcher-workflow` skill covers
  how to brief a TeamMate or a Team."
- `workflow_run`: "The bundled `dynamic-workflow` skill covers the script API."
  replaces "Load the bundled `workflow` skill before use."
- `workflow_status` / `workflow_stop` / `workflow_list`: the load sentence is
  removed and not replaced (J4: they take a `run_id` and need no skill).

**`teamwork` content (R8, R10, item 7).** Rewritten from #369's
`team-workflow`. Sections and what each carries:

1. *Yourself, a subagent, or a TeamMate* — #369's section kept, plus one
   paragraph on runtimes (R10): query `get_capabilities` for the runtimes this
   Team can spawn and use the strengths of heterogeneous models; the skill
   names no runtime and maps no model to a role.
2. *The hand-down: context, not control* — replaces #369's "Writing the
   Hand-Down Prompt". What the brief carries: the user's goal and why they
   want it; the full requirement context from your conversation with the
   user, pointed at by path where it is recorded; the user's own constraints
   verbatim; your guesses marked as guesses; what "done" means and what you
   need to read back; the known unknowns. What it does not carry: file
   lists, edit steps, or prohibitions without a reason. It grants
   exploration, and it says that stopping to report a conflict with reality
   or a blocker is the correct result, not a failure. `identity` holds the
   role and the stop-when-blocked posture for every turn; `prompt` holds the
   task of this turn; the same split applies to `send`. #369's "keep the
   roles disjoint" bullet stays; its "name the paths it owns" bullet is
   dropped (J13: the `spawn` description already carries the shared-workspace
   rule).
3. *When a TeamMate reports it cannot* — new (R8). A "cannot" is a finding:
   read what it found; convene other TeamMates for options, or take the
   decision to the user through the channel's question tool; never rewrite
   the requirement on the user's behalf, and never re-send the same task with
   firmer wording.
4. *When a TeamMate does something you did not expect* — #369's section kept.
5. *Keeping the thread* — #369's section kept.

**`dispatcher-workflow` content (R15).** #369's body kept. Its "Writing the
Hand-Down Prompt" section gains one paragraph stating context-not-control and
that a delegate's "cannot" is a finding (J5: R15 says to follow the earlier
decisions and not to make it complex; one paragraph keeps the two skills on
one philosophy without a rewrite).

**Structural tests.** `tests/bundled-skill-sources.test.ts`: the names per
root become `teamwork` and `dynamic-workflow`; its README regexes
(`/both[\s\S]{0,100}(?:shared )?\`workflow\`…/` and the required-source
regex) change to the new names. `tests/mcp-tool-descriptions.test.ts`:
`SKILL_DESCRIPTION_SOURCES` points at the renamed roots; the "no `before
using`" gate stays. `tests/feishu-cot-tool-rows.test.ts` uses `team-workflow`
only as sample text and is untouched.

### 3.6 Team-scoped TeamMate fact sentence (`teammate-collection/index.ts`, `teammateSystemPromptOptions`)

R9. The function takes the entity's `AgentEntityIdentity` instead of the bare
`identity_prompt`; when `identity.teamId !== null` it prepends:

```
You are TeamMate "<name>" of Dreamux Team "<teamId>". Your TeamLeader sees nothing of your turn until it ends; what you output when it ends is all that comes back.
```

Order of the appended prompt: this sentence, then the operation's own append
(today only `WORKFLOW_AGENT_SYSTEM_PROMPT`), then the operator's `identity`.
The concrete name and the Team are facts the collection already holds at
`buildEntity`; no new option and no new owner.

J8: workflow agents spawned from a TeamLeader's `workflow_run` are Team-scoped
entities of the same collection and receive the sentence too; its second half
holds for them (their turn's output is what the workflow consumes). J7:
dispatcher-scoped TeamMates receive nothing, as R9 was ruled in the Team
context; the alternative — one sentence for every entity with "Dispatcher"
in place of "Team" — is simpler code and is listed for the reviewers.

Test: a new case in the collection tests (or `tests/teammate-system-prompt.
test.ts`, built like `team-leader-prompt.test.ts` through the construction
boundary) asserts the order and that a dispatcher-scoped spawn gets only its
identity.

### 3.7 Channel MCP server named by provider; `source` attribute

**Server name (R12, R13, item 9).** `ChannelProviderCatalog.resolve(ref)`
returns `{ id: descriptor.id, implementation }` instead of the bare
`ChannelProvider` (the shape its agent-runtime twin already returns). The
three callers (`channel-service/index.ts`, `channel-service/mcp-delegates.ts`,
and any other found at implementation) destructure it. `createChannelMcpDelegate`
receives `providerId` and names the server `channel-<providerId>` and its
identity `dreamux-channel-<providerId>` (J10: one public name). `channelId`
stays for `sessionMcp` lookups, logs, and core events. `channels[].id` keeps
its meaning everywhere else; no config change, no state change, no migration
(the server name is not persisted; routing state is keyed by channel id).

Naming is total for builtin providers: `BUILTIN_PROVIDER_ID_PATTERN` is
`/^[a-z][a-z0-9-]*$/`, so `channel-feishu` is legal on both engines (Codex
renders it `channel_feishu`). For external (`npm:`) providers the loader seeds
`descriptor.id` from the raw ref (`provider-loader.ts`, `seedDescriptorId`),
which is not a legal server-name segment. No external channel provider exists,
so this design adds no sanitizer (no named scenario); it records the
constraint in `provider-runtime.md` as the gap to close when the first one
ships. Open question Q1 for the reviewers.

Config already refuses the same provider twice per dispatcher
(`config/config.ts`: "each provider may appear at most once per dispatcher"),
so two channels cannot produce one server name.

**`source` attribute (R13).** `feishu-message.ts` appends `['source',
'feishu']` first; Core's envelope renderer then emits
`<channel source="feishu" chat_id=… >` unchanged. J9: every other
Feishu-authored `<channel>` envelope (the ask-card settlement, located at
implementation) carries the same attribute so a model can always tell the
provider from the envelope. The three tool descriptions that already say
`<channel source="feishu">` become accurate without edits.

Tests that change knowingly: `tests/channel-input-format.test.ts` (seven
attrs, `source` first; its "no `<channel` in the body" assertion still holds);
`tests/channel-service.test.ts`, `tests/mcp-delegate-catalog.test.ts`,
`tests/mcp-public-failures.test.ts`, and `tests/codex-live.test.ts` (the
`status.data.find(entry => entry.name === 'channel-primary')` lookup) assert
the provider-named server.

Runtime adapters need no change: Claude Code's `args.ts` builds
`--disallowedTools` from feature names, not server names, and Codex's
`mcp-config.ts` renders whatever name it is handed.

### 3.8 Completion push-back fact sentence (`teammate-service/completion-renderer.ts`)

R14. `buildCompletionTurnText` emits, for both TeamMate and workflow
completions and both inline and spilled bodies:

```
<status line> This is an automated notification from Dreamux, not a message from the user. Output below:

<body>
```

The status lines themselves do not change. The sentence is not added to
`<cron>` or `<system>` submissions (R14 named the completion push-back).

Tests: `tests/completion-renderer.test.ts` and
`tests/completion-delivery.test.ts` assert the new sentence next to the status
line where they match the full text.

### 3.9 Knowledge base and README

- `.agents/domains/model-facing-writing.md`: the principles in §2; the server
  map example changes from `channel-<id>` to `channel-<provider>`.
- `.agents/domains/dispatcher-skill.md`: skill names and roots; trigger design
  (narrow description + tool pointer); required-source names.
- `.agents/domains/provider-runtime.md`: reserved names `teamwork` and
  `dynamic-workflow`; the external-provider naming constraint (§3.7).
- `.agents/domains/channel.md`: server naming by provider; the `source`
  attribute; the reminder as the channel's consequence sentence.
- `.agents/skills/dev-workflow/SKILL.md` and its references
  (`solution-consultation.md`, `implementation.md`,
  `implementation-review.md`, `team-dissolution.md`): `team-workflow` →
  `teamwork`. Archived proposals and research notes keep their historical
  names.
- `packages/dreamux/README.md`: the bundled-skills paragraph names the new
  skills (the structural test reads it).
- `.agents/scripts/check.sh` runs green.
- `dreamux-maintenance` is untouched: no config or state file changes shape,
  default, ownership, or meaning.

### 3.10 Change files

#369's two change files are added files in this PR and are replaced by one
per package under new names (`refine-model-facing-surfaces_<timestamp>.json`):

- `@excitedjs/dreamux`, `minor`, not breaking: role prompts reduced to
  identity and server map; reminders reworded as consequences; skills renamed
  `teamwork` and `dynamic-workflow` with narrow triggers; the channel MCP
  server is named after the provider (`channel-feishu`; Codex tool names
  change from `channel_<id>__…` to `channel_feishu__…`); Team-scoped
  TeamMates receive an identity sentence; completions carry the notification
  sentence; #369's tool-description work.
- `@excitedjs/feishu-channel`, `minor` (J12: a new envelope attribute is a
  feature on a >1.0 package): `source="feishu"` attribute; the reminder as a
  consequence; #369's description rewrites.

### 3.11 Task records

- `.agents/tasks/mcp/relocate-role-skill-guidance/README.md` (#369's record,
  in this PR after the merge): Delivery gains one line — PR #369 not merged
  by operator ruling of 2026-09-05; its content delivered through this task's
  PR. This task's README lineage sentence ("This task does not change that
  PR's record") is corrected in the same commit.
- This task's README: draft, reviews, final, approval, delivery, as the
  dev-workflow states.

## 4. Judgments beyond the rulings' words (for approval)

| # | Judgment | Rests on |
|---|----------|----------|
| J1 | Dispatcher map drops "Load a tool's definition before calling it" | R5 named the TeamLeader sentence; same rule, same owner (the engine) |
| J2 | "Prefer delegating … wait for Dreamux to push" folded into the working-directory identity statement | item 12 keeps that bullet as identity; the "wait" half is R19's deleted rule |
| J3 | "# Working With The User" channel-reply bullet deleted | the rule R19 deleted, written twice |
| J4 | workflow_status/stop/list lose the skill pointer | they need no skill |
| J5 | `dispatcher-workflow` gets one paragraph, not a rewrite | R15 "follow 前面所有决策" and "不需要搞那么复杂" |
| J6 | `dispatcher-workflow` description covers TeamMate/Team only | R17's intent; workflow has its own skill |
| J7 | Fact sentence for Team-scoped TeamMates only | R9 ruled in the Team context; alternative listed in §3.6 |
| J8 | Workflow agents of a TeamLeader receive the fact sentence | same collection, wording holds |
| J9 | Ask-card settlement envelope also carries `source` | one provider mark for every Feishu envelope |
| J10 | MCP identity name follows the provider too | one public name |
| J11 | Team reminder omits the files sentence | Teams have their own workspace |
| J12 | feishu-channel change type `minor` | new attribute on a >1.0 package |
| J13 | `teamwork` drops "name the paths it owns" | spawn's description carries it |
| J14 | "(its schema is the authority)" dropped from the map | a rule inside an identity line |
| J15 | `dreamux-maintenance` load sentence stays in both Dispatcher prompts | no ruling touched it |
| J16 | `team.create`/`team.send` gain the contract sentence | same hand-off failure mode |

## 5. Non-goals

- `<system-reminder>` wrapping on Claude Code (decision (h), optional, untouched).
- The six Codex-style sections of the Dispatcher base prompt, except J3.
- Tool names, input schemas, results, and behavior of every Dreamux MCP tool.
- `channels[].id` semantics, config schema, routing state, core event shapes.
- `<cron>` and `<system>` submissions.
- The agent-runtime packages (Codex, Claude Code) and the Codex MCP envelope
  line ruled "先不修" in the earlier task.
- The `dreamux-maintenance` skill.

## 6. Tests that change knowingly

| Test | What moves | Why |
|------|-----------|-----|
| `tests/team-leader-prompt.test.ts` | drops 'reply tool' / 'public artifacts'; adds identity-last and no-rule gates | R2, R5 |
| `tests/mcp-tool-descriptions.test.ts` | skill roots renamed; no-rule gate on both Dispatcher prompts; hand-off contract sentence check | §3.2, §3.3, §3.5 |
| `tests/bundled-skill-sources.test.ts` | names per root; README regexes | §3.5 |
| `tests/channel-input-format.test.ts` | seven attrs with `source` first | R13 |
| `tests/channel-service.test.ts`, `tests/mcp-delegate-catalog.test.ts`, `tests/mcp-public-failures.test.ts`, `tests/codex-live.test.ts` | `channel-primary` → provider-named server | R12 |
| `tests/completion-renderer.test.ts`, `tests/completion-delivery.test.ts` | notification sentence | R14 |
| feishu-channel `feishu-message-budget.test.ts`, `public-api.test.ts`; dreamux `package-boundary-guards.test.ts` | reminder text where quoted | R4 |
| new: TeamMate system-prompt order | §3.6 | R9 |

Every edit above is reviewed against the ruling it cites, not against a green
run.

## 7. Verification

Gates: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`,
`.agents/scripts/check.sh`, `rush change --verify`, gitleaks pre-commit.

What the gates prove: the texts, names, attribute lists, and prompt order are
what this design says. What they cannot prove:

- that a Codex TeamLeader no longer loads a skill on a plain channel-message
  turn (the description-driven trigger is the engine's heuristic);
- that a model associates a message with its provider from the
  `source` attribute and the `channel_feishu` tool name;
- that the reworded reminders change behavior.

Acceptance after release (the trigger goal): ask the operator's Codex
TeamLeader, on a turn that only answers a channel message, which skills it
loaded and why, and whether it can name the provider of the message it
answered. Ask the same of a Claude Code TeamLeader after upgrade. Residual
risk: description-triggered loads remain engine-dependent; on Claude Code the
spawn/send contract sentence is the only carrier of the "pushed later" fact.

## 8. Implementation boundary (for the approval playback)

Source: `service/team-service/leader-agent.ts`;
`service/dispatcher-service/base-prompt.ts`; `service/mcp/dispatch-reminders.ts`;
`service/teammate-collection/mcp-tool-descriptors.ts` and `index.ts`;
`service/team-collection/mcp-delegate.ts` (descriptions only);
`service/teammate-service/completion-renderer.ts`; `channel/catalog.ts`;
`service/channel-service/index.ts`, `mcp-delegates.ts`, `mcp-delegate.ts`;
`platform/paths.ts`; feishu-channel `feishu-submit.ts`, `feishu-message.ts`,
and the settlement envelope builder. Skills: the two renamed roots and three
`SKILL.md` files. Tests: §6. KB and README: §3.9. Change files: §3.10. Task
records: §3.11. Unchanged: everything in §5.

## 9. Open questions for the reviewers

- Q1 (§3.7): is "record the external-provider naming constraint, add no code"
  the right call, or does the naming rule need to be total now?
- Q2 (§3.6): J7 versus one sentence for every collection entity.
- Q3 (§3.5): does the `teamwork` content as outlined carry anything that is
  control rather than context, or miss a context item the requirement's R8
  states?
- Q4 (§3.2): J3 — delete the second channel-reply sentence, or read R19
  narrowly and leave it?
- Q5 (§3.8): the sentence's placement between the status line and
  "Output below:"; any test or consumer that parses the status line?
