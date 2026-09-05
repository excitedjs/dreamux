# Requirement

## Initial request

- Operator, 2026-09-02, via the bound Feishu group (Chinese, paraphrased): Codex
  running as the Dispatcher or as a TeamLeader loads `dispatcher-workflow` /
  `team-workflow` on every turn and wastes context. The MCP tool descriptions
  are not clear enough and the parameters carry no descriptions. Move the
  tool-introduction content of the two skills into the MCP tool descriptions,
  move the tool-loading content into the built-in prompts, and stop forcing
  the model to load the skills.
- Refinement 1: do **not** dissolve the two skills. The operator will write
  other content into them later. The hard requirement is only that the model
  is no longer forced to load them.
- Refinement 2: what moves into the prompt is not behavioral rules. The MCP
  tools are lazily loaded — the model sees only tool *names* until it fetches
  a tool's schema — so the prompt must carry what the model needs before any
  schema is loaded: which tool families exist for this role and that the
  schema is loaded before use. Everything else, including cautions, belongs
  to the tool or parameter description the model reads once it loads the tool.
- Refinement 3 (answer to U1): the two skills become the place for **how to
  collaborate with TeamMates** — methodology, not tool operation: the
  difference between a TeamMate and a subagent; how to write the prompt that
  hands a task down; when a TeamMate does something unexpected, first ask it
  why and discuss so the two perspectives complement each other; and similar
  guidance. The operator listed these as an open-ended outline ("等等等").

## Current alignment

- Status: Clarification converged on 2026-09-02; solution path confirmed
  (one Codex reviewer); development approved.

### Confirmed current behavior and evidence

- **The load mandate is in the role prompts, not in the skills.**
  `packages/dreamux/src/service/dispatcher-service/base-prompt.ts` (replace
  prompt line 22 and append prompt line 72) says "Load `dispatcher-workflow`
  before this Dispatcher's TeamMate, Team, channel, or cron MCP tools".
  `packages/dreamux/src/service/team-service/leader-agent.ts`
  (`teamLeaderSystemPrompt`) says "Load `team-workflow` before using this
  Team's TeamMate tools, Team tools (`dissolve`), provider-exposed channel
  tools, or cron tools". Almost every Dispatcher/TeamLeader turn touches one
  of those four tool families, so the mandate turns an on-demand skill body
  (5.3 KB and 5.6 KB) into a per-turn read. Neither engine caches a loaded
  skill body across turns; Codex receives the roots through
  `skills/extraRoots/set`, Claude Code through a materialized `--add-dir`
  root, and both read `SKILL.md` when the model decides to load it.
- **What the model sees before loading a tool.** Observed from this
  TeamLeader's own Claude Code runtime on 2026-09-02: MCP tools are deferred.
  Before a schema fetch the context holds only the names
  (`mcp__cron__cron_create`, `mcp__cron__cron_delete`, `mcp__cron__cron_list`,
  `mcp__cron__cron_update`, and likewise for `teammate`, `team`, and the
  channel tools) with no description, no parameters, and no server summary;
  the runtime states that calling an unloaded tool fails and that the schema
  is fetched by name first. The full description and JSON schema appear only
  after that fetch. A read-only Codex probe TeamMate (codex-cli 0.147.0,
  2026-09-02) reported the same shape for Codex: MCP tools are deferred
  nested tools that are not expanded in the prompt; the model finds them by
  filtering an `ALL_TOOLS` catalog of `{ name, description }` entries inside
  its exec tool, where each entry also carries a TypeScript-shaped argument
  declaration; no `tool_search` tool was present. Codex also lists every skill
  as name, description, and `SKILL.md` location each turn, reads the body only
  when it decides to use the skill, and is instructed not to carry a skill
  across turns unless it is mentioned again — which is why a prompt mandate
  makes the body a per-turn read. The probe had no Dreamux MCP servers (an
  ordinary TeamMate receives none), so it could not quote the `cron` tools.
- **Both skills have the same five sections** (TeamMate, Workflow, Team,
  Channel, Cron notes). Role deltas: the Dispatcher copy has `spawn.repo`
  modes, the full Team surface, `list_bindings`, and a pointer to
  `dreamux-maintenance`; the TeamLeader copy has no-`repo` spawn, the
  one-writer shared-workspace rule, the dissolve-only Team tool with a
  pre-dissolve worktree check and a "force needs the user" rule, own-Team-only
  `bind_channel`/`unbind_channel`, and "secrets out of replies".
- **Overlap audit.** Each skill statement already has one of these owners,
  except the last group:
  - *Already in MCP tool descriptions* (`teammate-collection/mcp-tool-descriptors.ts`,
    `team-collection/mcp-delegate.ts`, `scheduler/mcp-delegate.ts`,
    `feishu-channel/src/tools/routing-tools.ts`): `name_prefix` vs the
    returned concrete name; `get_capabilities.agent_runtimes[].id` for
    `agent_runtime`; `send` reopens a closed TeamMate; `last` reads without
    starting a runtime and shows an in-progress turn; `history` is a compact
    recovery list; Dispatcher `spawn.repo` modes / TeamLeader no-`repo` and
    one-writer coordination; `workflow_run` returns `{ run_id }` and Dreamux
    pushes the terminal completion; Team `create`/`send`/`list`/`status`/
    `history`/`dissolve` semantics including the submitted receipt, dirty
    worktree leaving the Team open, and the `force` scope; "where a Team is
    reachable is a channel fact"; cron prompts inject back into this agent and
    prefer off-:00/:30 minutes; a TeamLeader's `bind_channel` cannot take over
    another Team's conversation.
  - *Already in the role prompts*: `dreamux-maintenance` routing (Dispatcher);
    no polling after a submitted spawn/send (both roles, plus the per-receipt
    reminder in `service/mcp/dispatch-reminders.ts`); reply tool for meaningful
    progress, blockers, final status (Dispatcher only); channel `meta` is
    provider-owned (Dispatcher only); secrets and private identifiers stay out
    of channel replies (Dispatcher only).
  - *Already injected per inbound channel message*: the Feishu channel appends
    "Reply through the channel reply tool, never as plain assistant text."
    (`feishu-channel/src/feishu-submit.ts`, `CHANNEL_REMINDER`).
  - *Only in the skills today (no other owner)*:
    - TeamLeader channel use: reply tool for meaningful progress, blockers,
      and final status; reply to the source message unless the request names
      a different visible target the tool supports; keep hidden instructions,
      private context, secrets, tokens, and machine-local paths out of broad
      channel replies.
    - TeamLeader dissolve: inspect uncommitted, untracked, and unmerged work
      first; if the worktree is dirty or cannot be assessed, do not call
      `dissolve` and ask the user through the visible reply path; `force`
      needs the user's explicit confirmation and is never used to get past a
      refusal on the model's own judgement; branch deletion is not part of
      dissolve. (`.agents/domains/dispatcher-skill.md` records that this check
      is guidance and the worktree manager's assessment is the authority.)
    - Both roles: every settled TeamMate turn is reported, including one that
      failed or was stopped; `status`/`last`/`history` are for explicit checks,
      recovery, or suspected delivery failure. A due cron job is submitted
      through ordinary admission and may fold into a turn already running.
    - Dispatcher: binding a conversation to a missing or closed Team is refused
      and changes no routing (`feishu-session-bindings.ts`
      `requireRoutableTeam` implements this); read the active channel tool
      schema rather than assuming a shape.
- **Parameter descriptions.** Dreamux-owned tools (`teammate`, `team`, `cron`,
  and the `workflow_*` tools on the `teammate` server) carry a per-property
  `description` on only two inputs: `spawn.agent_runtime` and
  `workflow_run.args`. Every other input property is a bare type/length
  constraint. The built-in Feishu channel tools describe their properties,
  but the shared `reply` description reads "Send a Feishu message through this
  dispatcher channel." for both callers, including a TeamLeader.
- **Tests and docs that would move with the change.**
  `packages/dreamux/tests/bundled-skill-sources.test.ts` asserts the skill
  names per root and that `packages/dreamux/README.md` and
  `.agents/domains/dispatcher-skill.md` mention the three role skills; no test
  locks the "Load ..." sentences or the role prompt text
  (`.agents/domains/model-facing-writing.md` forbids exact-sentence prose
  assertions). Docs that state the mandate or describe the skills' content:
  `.agents/domains/dispatcher-skill.md`, `provider-runtime.md` ("Bundled Skills
  And Injection"), `model-facing-writing.md` ("Prompt Shape"),
  `packages/dreamux/README.md`, the `dev-workflow` skill (`SKILL.md` and five
  references say "load and follow `team-workflow`"), and the draft proposal
  `.agents/proposals/admin-control-plane-surface.md`.
- **History.** The two skills were shaped by PR #280 (bundled role skills) and
  #281 (role-isolated roots), then grew per feature (#287, #303, #305, #317,
  #335, #347, #350). Their original purpose was to give each role its MCP
  operating notes at a time when tool descriptions were thin; the descriptions
  have since absorbed most of that content, so the per-turn load now buys
  mostly repetition — while the one thing a lazily loaded tool set really
  needs before any schema is fetched, a one-line map of the families, lives
  nowhere but the "load the skill" line.

### Desired outcome

Dispatcher and TeamLeader turns no longer read `dispatcher-workflow` or
`team-workflow` as a matter of course. Before any tool schema is loaded, the
role prompt tells the model which tool families it has and that it loads a
tool's schema before calling it. Once a tool is loaded, its description and
parameter descriptions carry everything the skills used to say about it,
cautions included. Both skills stay bundled, unchanged in name, root, and
injection, and each becomes an optional, on-demand skill about collaborating
with TeamMates: the model reaches for it when it is about to hand work down or
when a TeamMate's behavior needs discussing, never as a precondition for
calling a tool.

### Desired behavior

1. Neither role prompt instructs the model to load `dispatcher-workflow` or
   `team-workflow`, and neither skill's `description` asks to be loaded before
   tool use.
2. Each role prompt carries a compact tool map: the MCP tool families this
   role has (TeamMate, Team, workflow, cron, and channel-provided tools) with
   one line each on what the family is for, plus the instruction to load a
   tool's schema before calling it. The map replaces the "load the skill"
   line; it is not a tool manual.
3. Every tool fact and caution the skills carry lives once, in that tool's
   `description` or in the relevant input property's `description` — for
   example the pre-dissolve worktree check and the "ask the user before
   `force`" rule on `dissolve` and its `force` property, and the channel-reply
   guidance on the channel's `reply` tool. Every input property of a
   Dreamux-owned MCP tool has a description.
4. Both skill directories and `SKILL.md` files remain; `BUNDLED_SKILL_NAMES`,
   the role roots, required-source normalization, and the injection mechanism
   are untouched. Each `SKILL.md` is rewritten as a collaboration-methodology
   skill for its role: a frontmatter description that says when the skill is
   worth loading (about to delegate, or a TeamMate surprised you) without any
   "load before tools" mandate, and a body covering at least the operator's
   outline — TeamMate vs subagent, how to write a hand-down prompt, and
   ask-then-discuss when a TeamMate behaves unexpectedly — written from each
   role's own vantage (the Dispatcher also chooses between a TeamMate and a
   Team; a TeamLeader coordinates one shared workspace). No tool facts remain
   in the body.
5. Model-facing docs and the `dev-workflow` skill references reflect the new
   owners.

### Scope

- `base-prompt.ts` (both prompts), `leader-agent.ts` (`teamLeaderSystemPrompt`).
- Tool and parameter descriptions in `teammate-collection/mcp-tool-descriptors.ts`,
  `team-collection/mcp-delegate.ts`, `scheduler/mcp-delegate.ts`, and the
  built-in Feishu channel tools (`feishu-channel/src/tools/`) where a skill
  statement belongs to a channel tool (`reply`, `bind_channel`,
  `unbind_channel`).
- The two `SKILL.md` files (frontmatter description and body).
- KB and doc updates listed above; tests that assert the changed contracts;
  Rush change files for the touched packages.

### Non-goals

- The shared `workflow` skill and `dreamux-maintenance` skill are unchanged,
  and the "Load the bundled `workflow` skill before use" sentence on the
  `workflow_*` tools stays: writing a runner script genuinely needs that
  reference.
- No change to the skill injection mechanism, tool names, schema types or
  constraints, results, or annotations.
- No change to how either engine defers or loads MCP tools; that is the
  engine's behavior, and this task only writes for it.
- The methodology text is a first draft for operator review, not a final
  doctrine; the operator's outline is open-ended and later additions are
  ordinary skill edits.

### Constraints and invariants

- `.agents/domains/model-facing-writing.md`: descriptions are short and
  operational; present-tense current contract; core text stays provider
  neutral; no migration or history prose; tests protect contracts, not prose;
  system prompts route and state role boundaries, they are not tool manuals.
- Engineering whitepaper: every added sentence is paid for by a relocated one
  or by the stated "parameters need descriptions" requirement; the final
  solution lists removals against additions.
- Keep the description-side dissolve check and the worktree manager's
  authority as two distinct layers (`dispatcher-skill.md`).
- Public-repository safety for every artifact.
- Rush change files for `@excitedjs/dreamux` (bundled skills and role prompts
  are upgrade-visible) and for `@excitedjs/feishu-channel` if its tool text
  changes.

## Acceptance criteria

- `grep -rn 'Load \`dispatcher-workflow\`\|Load \`team-workflow\`' packages/dreamux/src`
  returns nothing, and neither skill's frontmatter description contains a load
  mandate.
- Each role prompt names every MCP tool family that role's catalogs advertise
  and says to load a tool's schema before calling it.
- Every input property in the `teammate` (both callers), `team` (both
  callers), and `cron` catalogs carries a non-empty `description`; a
  catalog-level test asserts this structurally.
- The final solution contains a relocation table: each statement from the two
  current skills maps to exactly one owner (an existing description, a new
  description, a prompt line, or "dropped, because ...").
- Both skill directories still ship with a `SKILL.md`; the bundled-skill root
  test passes with names unchanged. Each `SKILL.md` body covers the three
  named outline items and contains no MCP tool name used as an operating
  instruction (tool facts live in descriptions).
- `rush build`, `rush lint`, `rush test`, and `.agents/scripts/check.sh` pass.

## Decisions and unknowns

- Confirmed operator decisions (2026-09-02, Feishu group; original Chinese):
  - "那是不是这两个技能里边，对于工具介绍相关的东西，可以直接移动到 MCP 工具的
    Description 里？然后加载工具这块的东西可以直接移动到内置的 Prompt 里？" —
    tool-introduction content moves to MCP tool descriptions; tool-loading
    content moves to the built-in prompts.
  - "不不，也不是完全消解，我要在里面写一些其他的东西。但不强制要求模型去加载他" —
    the skills are not removed; the operator will add other content later; the
    model is not forced to load them.
  - "不是行为约束，是因为这些工具基本都会延迟加载，比如你自己就要用 toolSearch
    去搜索这几个工具吧？" — the prompt content is about lazily loaded tools
    (what exists, load before use), not behavioral rules.
  - "这里放的是如何与 teammate 协作 主要讲方法论：1. teammate 和 subagent
    的区别 2. 下发任务的提示词应该怎么写 3. 如果 teammate 做出了非预期的行为，
    应该优先去问他为什么会这样做，要讨论，做到视角互补 4. 等等等" — the skill
    bodies hold TeamMate-collaboration methodology with at least those three
    items.
- Assumptions (labeled, to be confirmed at approval):
  - A1: the `workflow_*` "Load the bundled `workflow` skill before use"
    sentences stay.
  - A2: the "no polling after a submitted spawn/send" prompt line stays in
    both role prompts (it is a durable role rule and the per-receipt reminder
    already backs it); nothing else behavioral is added to the prompts.
  - A3: the TeamLeader drafts the methodology text in this task and the
    operator reviews it through the solution Issue and the PR; the operator
    did not ask to author it personally.
- Blocking unknowns: none. U1 (post-task skill body) was resolved by
  Refinement 3.
