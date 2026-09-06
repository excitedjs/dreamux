# Technical design (final): refine the model-facing surfaces

State: final, adjudicated by the TeamLeader on 2026-09-06 from
[`draft.md`](draft.md) (commit `d709c9ab`), the Codex reviewer's file
[`reviews/reviewer-codex.md`](reviews/reviewer-codex.md) (with its
reconsideration under R21), and the Seed reviewer's file
[`reviews/reviewer-seed.md`](reviews/reviewer-seed.md). The requirement
(`../requirement.md`, R1–R21) is the authority. This file is self-contained:
where it repeats the draft it states the final text; where it differs, §4
says which finding moved it. Every reviewer claim adopted here was re-read in
source by the TeamLeader; §4 marks the ones rejected and why.

## 1. Outcome and acceptance

Outcome: a TeamLeader's or Dispatcher's context carries only its identity and
its MCP server map from Dreamux; every consequence the model cannot see is
stated once, by its owner, at the action; skills load only when the model is
about to use the MCP they are about; a TeamLeader's brief to a TeamMate is
context, not control; the channel is model-visible by provider, not by id.

Accepted when:

- the four Rush gates, `.agents/scripts/check.sh`, and `rush change --verify`
  are green on the delivery branch (structure and text);
- after release, the operator's Codex TeamLeader, on a turn that only answers
  a channel message, reports no skill load, and can find the Feishu channel's
  tools when asked; a Claude Code TeamLeader after upgrade lists
  `mcp__channel-feishu__reply` among its tools and loads `teamwork` only on a
  spawn/send turn (behavior; engine-dependent, §8).

## 2. Baseline and confirmed facts

- Baseline: `origin/pr-369` (head `5e1a3464`, merge-base `d74142c3`) merged
  onto `origin/next` (`0d8098f1`). `git merge-tree --write-tree --name-only
  origin/next origin/pr-369` exits 0 with no conflicted path (re-run
  2026-09-06 after the Seed reviewer reported one; §4 Seed F4).
- R17 has no target on this baseline (#369 already replaced both Dispatcher
  load sentences); its purpose is met by that removal plus §3.5. Reported to
  the operator on 2026-09-06 before the draft. R19/R20 bullets are
  byte-identical between `d74142c3` and `5e1a3464`.
- Claude Code skill cache (Codex F1, verified): the adapter root is
  `<cache>/claude-code/skills/<key>` where `skillAdapterKey` hashes only each
  source root's name and absolute path (`skill-adapter.ts`); the validator
  compares that manifest and returns true without reading child skills; the
  materializer returns before rebuilding symlinks. `npm install --global`
  upgrades in place at an unchanged path, so after this PR an existing
  installation's Claude TeamLeaders would keep the old `team-workflow` /
  `workflow` links and never see `teamwork` / `dynamic-workflow`. Codex reads
  its extra roots live (`skills/extraRoots/set`) and has no such cache.
- `AgentEntityIdentity` carries `team_id`, not `teamId` (Codex F4).
- `last` reads an in-progress turn (its description, and the product catalog:
  "`last` is the mid-turn progress window").
- `team.create`'s `prompt` is optional; the Team dispatch reminder is attached
  only by `team.send` today (`team-collection/mcp-delegate.ts`); the
  requirement's Evidence sentence that counts `team.create` among the
  attachment points is wrong and is corrected in this PR (Codex F6).
- A Team can be created with `repo.mode: reuse-cwd`, so a Team's workspace can
  overlap other writers (Codex F5).
- `ChannelProviderCatalog.resolve` has five callers:
  `channel-service/mcp-delegates.ts`, `channel-service/index.ts`,
  `provider-diagnostics.ts`, `onboard/wizard.ts`, and the structural
  `ChannelProviderResolver` in `dispatcher-service/runnable-channel.ts`, whose
  result is discarded (Seed F3, corrected at implementation on 2026-09-06: the
  four named before are the sites that use the catalog Core injects, whose
  receivers are `channelProviders` and `catalogs.channel`; the onboard wizard
  constructs its own `ChannelProviderCatalog` over a locally built registry,
  outside the running service, and calls it `channelCatalog`).
- The ask-card settlement envelope is built inline in
  `feishu-session-ops.ts` `deliverAskUserSettlement` and submitted through
  the same path as inbound messages (Seed J9).
- `.agents/domains/model-facing-writing.md` at #369 prescribes, under "Prompt
  Shape", the Dispatcher content this task deletes, says the no-polling rule
  "belongs in Dispatcher and TeamLeader role prompts", names the shared
  `workflow` skill, and gives `channel-<id>` in its server-map bullet (Seed F1,
  corrected: the `channel-<id>` bullet does exist at #369, line 116).
- The requirement's invariant (line 39–42): the two P1 scenarios of the
  2026-09-02 review "must still be covered somewhere once their prompt lines
  are gone" (Seed F2). Reconciled in §3.12.

## 3. Final design

### 3.1 TeamLeader prompt (`team-service/leader-agent.ts`)

```
You are the TeamLeader of Dreamux Team "<teamId>".
Your Dreamux MCP servers: `teammate` (this Team's members, who share the Team workspace, and scripted workflows), `team` (dissolve this Team), `cron` (scheduled prompts that wake this TeamLeader), and one `channel-<provider>` server per configured channel that provides tools, for example `channel-feishu` (that channel's own tools).
Your Team's workspace <path> is a managed git worktree that Dreamux removes when the Team dissolves; uncommitted, untracked, or unmerged work there blocks the dissolve.   ← or: … is a managed git worktree that is kept after the Team dissolves. / … is a reused directory that is kept after the Team dissolves.
<identity_prompt, when set>
```

R1, R2, R5, J14. The `channel-feishu` example is an existence pointer and a
substring filter on Codex, where the model sees `channel_feishu` (Seed F5).
The workspace sentence was added after the external review of #380 (R29): the
leader's own identity is always a reuse of the Team directory, so only the
Team record knows whether that directory is a managed worktree removed on
dissolve, and the `dissolve` description asks the leader to act on that fact
(§3.14). It is a fact about the leader's situation, not a rule, so R1 holds.

### 3.2 Dispatcher prompts (`dispatcher-service/base-prompt.ts`, both exports)

Codex `replace` text, "# Dispatcher Role" section:

```
- Your Dreamux MCP servers: `teammate` (TeamMates you run directly, and scripted workflows), `team` (Teams: a TeamLeader with its own workspace and members), `cron` (scheduled prompts that wake this Dispatcher), and one `channel-<provider>` server per configured channel that provides tools, for example `channel-feishu` (that channel's own tools).
- Load `dreamux-maintenance` before Dreamux server operation, host diagnosis, daemon/service/config/log work, or missing-reply investigations.
- The dispatcher working directory is coordination space, not a target repository: you coordinate, and repository implementation, refactoring, debugging, and review work is done by TeamMates or Teams unless the user explicitly asks this Dispatcher to inspect or edit local files.
- Credentials, access policy, persistent config, service units, shell startup files, PATH, and runtime auth are host-owned; an ambiguous channel request leaves changing them unauthorized until the owner confirms.
```

The "# Working With The User" bullet "If the source request came through a
channel, report meaningful progress … through the provider-exposed reply
tool …" is deleted (J3, an extension of R19 for approval). The other five
Codex-style sections are unchanged.

Claude Code `append` text:

```
# Dreamux Dispatcher Role

You are running as a Dreamux Dispatcher. Your Dreamux MCP servers are `teammate` (TeamMates and scripted workflows), `team` (Teams), `cron` (scheduled prompts for this Dispatcher), and one `channel-<provider>` server per configured channel that provides tools, for example `channel-feishu`. Load `dreamux-maintenance` before Dreamux server operation, host diagnosis, daemon/service/config/log work, or missing-reply investigations.

- The dispatcher working directory is coordination space, not a target repository: repository work is done by TeamMates or Teams unless the user explicitly asks this Dispatcher to inspect or edit local files.
- Credentials, access policy, persistent config, service units, shell startup files, PATH, and runtime auth are host-owned; an ambiguous channel request leaves changing them unauthorized until the owner confirms.
```

The host-boundary sentence keeps "ambiguous" (Codex F2: dropping it turned
R20's consequence into a wider authorization rule). The doc comment above the
append export lists what the delta carries: server map, `dreamux-maintenance`
trigger, working-directory identity, host boundary (Seed F8).

### 3.3 Dispatch-result reminders and hand-off descriptions

`service/mcp/dispatch-reminders.ts`, R7 wording, three texts:

```
TEAMMATE: Submitted. The TeamMate is working; Dreamux will notify you automatically when it finishes, whether it completed, failed, or was stopped. You know nothing about its result until that notification arrives, so do not report or predict it; continue other work or answer the user in the meantime. Do not edit the files it is working on.

TEAM: Submitted. The Team is working; Dreamux will notify you automatically when its TeamLeader finishes, whether it completed, failed, or was stopped. You know nothing about its result until that notification arrives, so do not report or predict it; continue other work or answer the user in the meantime. Do not edit the files it is working on.

WORKFLOW: Submitted. The workflow is running; Dreamux will notify you automatically when it finishes, whether it completed, failed, or was stopped. You know nothing about its result until that notification arrives, so do not report or predict it; continue other work or answer the user in the meantime. Do not edit the files its agents are working on.
```

The Team text keeps the files sentence (J11 withdrawn; Codex F5: `reuse-cwd`
Teams overlap other writers). The file's doc comment states the reason as the
consequence the caller cannot see. On Claude Code these texts are not seen
(the engine drops MCP `content` text when `structuredContent` is present), so
the description sentence below is the only carrier there.

Attachment: `teammate.spawn`, `teammate.send`, `workflow_run`, `team.send`
unchanged; `team.create` attaches the Team text when a `prompt` was given and
the result status is `created` (Codex F6; a hand-off that today gets no
reminder). Creating without a prompt attaches nothing.

Descriptions (`teammate-collection/mcp-tool-descriptors.ts`,
`team-collection/mcp-delegate.ts`): `spawn` and `send` (both callers) and
`team.send` end with "Returns a receipt at once; the completion is pushed
later as a new message." (R6, J16). `team.create` ends with "With `prompt`,
returns a receipt at once and the TeamLeader's completion is pushed later as
a new message; without it, the Team is created and nothing is submitted."
`workflow_run` keeps its existing contract sentence.

### 3.4 Feishu channel reminder (`feishu-channel/src/feishu-submit.ts`)

```
The user in this chat sees only what you send through the reply tool; your assistant text is not shown to them.
```

R4, R21 (Codex F7 withdrawn: the model needs to reach the user through
`reply`; the COT card is not information it needs). The `reply.text` secrets
clause stays (R5).

### 3.5 Skills

Renames: `skills/team-leader/team-workflow/` → `teamwork/`,
`skills/shared/workflow/` → `dynamic-workflow/`, frontmatter names,
`BUNDLED_SKILL_NAMES`. `dispatcher-workflow` keeps its name and root (R15).

Descriptions:

```
teamwork:            "How a TeamLeader hands work to a TeamMate and works with it afterwards. Load when about to spawn or send to a TeamMate; not needed for any other tool."
dynamic-workflow:    "How to write a Dreamux workflow script for workflow_run. Load when about to write or run a workflow script; not needed for any other tool."
dispatcher-workflow: "How a Dispatcher hands work to a TeamMate or a Team and works with it afterwards. Load when about to spawn or send to a TeamMate, or create or send to a Team; not needed for any other tool."
```

Tool pointers: `teammate.spawn`/`send` for the `team_leader` caller open
with "The bundled `teamwork` skill covers how to brief a TeamMate."; for the
`dispatcher` caller, and `team.create`/`team.send`, "The bundled
`dispatcher-workflow` skill covers how to brief a TeamMate or a Team.";
`workflow_run` opens with "The bundled `dynamic-workflow` skill covers the
script API."; `workflow_status`/`stop`/`list` carry no skill sentence (J4;
`workflow_list` takes no `run_id`, Codex's correction).

`teamwork` content (R8, R10; Codex F3 narrowed, Seed Q3):

1. *Yourself, a subagent, or a TeamMate* — #369's section, plus: query
   `get_capabilities` for the runtimes this Team can spawn and use the
   strengths of heterogeneous models; no runtime named, no model mapped to a
   role.
2. *The hand-down: context, not control.* The brief carries the user's goal
   and why; the requirement context from your conversation with the user —
   by path where it is recorded, written into the brief or the shared
   workspace when it is not; the user's own constraints verbatim; your
   guesses marked as guesses; what "done" means and what you need to read
   back; the known unknowns; and, when several members write in parallel,
   which paths each one owns and why. It does not carry an edit plan (which
   files to change and how) or a prohibition without a reason. It grants
   exploration and says that stopping to report a conflict with reality or a
   blocker is the correct result. `identity` holds the role and the
   stop-when-blocked posture; `prompt` holds this turn's task; the same
   applies to `send`. #369's "keep the roles disjoint" stays.
3. *When a TeamMate reports it cannot.* A "cannot" is a finding: read what
   it found; convene other TeamMates for options, or take the decision to the
   user through the channel's question tool; never rewrite the requirement on
   the user's behalf; never re-send the same task with firmer wording.
4. *When a TeamMate does something you did not expect* — #369's section.
5. *Keeping the thread* — #369's section.

`dispatcher-workflow` content: #369's body plus one paragraph in its
hand-down section stating context-not-control and that a delegate's "cannot"
is a finding (J5).

### 3.6 Team-scoped TeamMate identity sentence (`teammate-collection/index.ts`)

`teammateSystemPromptOptions` takes the `AgentEntityIdentity`; when
`identity.team_id !== null` it prepends:

```
You are TeamMate "<name>" of Dreamux Team "<team_id>". Your TeamLeader receives what you output when your turn ends.
```

then the operation's own append (`WORKFLOW_AGENT_SYSTEM_PROMPT` for workflow
agents), then the operator's `identity`. A workflow agent receives only the
first sentence (`You are TeamMate "<name>" of Dreamux Team "<team_id>".`):
its output is consumed by the workflow script, not delivered to the
TeamLeader, so the second sentence was false for it and competed with the
workflow contract that follows (external review of #380; R28 supersedes J8's
"workflow agents included"). Dispatcher-scoped TeamMates receive nothing (J7,
R9's scope). The draft's "sees nothing of your
turn until it ends" is dropped: `last` reads a running turn, and the model
does not need that fact (R21).

### 3.7 Channel MCP server named by provider; `source` attribute

`ChannelProviderCatalog.resolve(ref)` returns `{ id: descriptor.id,
implementation }`, the shape of its agent-runtime twin; the five callers in §2
adapt (`channel-service/mcp-delegates.ts`, `channel-service/index.ts` and
`provider-diagnostics.ts` destructure; `onboard/wizard.ts` hands the wrapper to
`onboardChannel`, which reads `id` and `implementation` from it instead of
resolving the same ref a second time through the registry — the twin of
`onboardAgentRuntime`, and the case the wrapper's doc comment names; the
structural resolver in `runnable-channel.ts` already declares `resolve(ref):
unknown`, so it is untouched). Corrected at implementation on 2026-09-06, with
§2, from "the four callers in §2 adapt (three destructure; the structural
resolver in `runnable-channel.ts` discards the result and changes only its
type)". `createChannelMcpDelegate` receives `providerId`, names the server
`channel-<providerId>` and its MCP identity `dreamux-channel-<providerId>`
(J10), and keeps `channelId` for `sessionMcp` lookups, logs, and events. The
comment block in `mcp-delegate.ts` that justifies id-based naming is rewritten
to say the name follows the provider because that is what the model can
associate with a channel's tools, and that config's one-provider-per-dispatcher
rule keeps it unique (Seed F3). `channels[].id` keeps its meaning; no config
change, no state change, no migration.

Naming is total for builtin providers (`BUILTIN_PROVIDER_ID_PATTERN`
`/^[a-z][a-z0-9-]*$/`). For `npm:` providers the loader seeds `descriptor.id`
from the raw ref, which no engine has been shown to accept as a server-name
segment; no external channel provider exists, and `descriptor.id` is a
registry key, so no sanitizer and no id change now. The constraint is recorded
where the next provider author looks (`channel/external-channel-provider.ts`
doc comment and `provider-runtime.md`) as the gap the first external channel
provider must settle (Q1: both reviewers agree; Seed's "fails loudly at
launch" is not adopted because it was not verified).

`feishu-message.ts` adds `source: 'feishu'` to the inbound attrs;
`deliverAskUserSettlement` adds the same attribute to the settlement envelope
(J9). The attribute's position is not a contract (R33): Core's renderer emits
attrs in insertion order and the Feishu channel happens to add `source` first,
but no test pins that and nothing may rely on it. The three tool descriptions
that already say `<channel source="feishu">` become accurate without edits.

Runtime adapters need no change for the rename: Claude Code's `args.ts`
builds `--disallowedTools` from feature names; Codex's `mcp-config.ts` quotes
any server name.

### 3.8 Completion push-back sentence (`teammate-service/completion-renderer.ts`)

The status line is followed once by "This is an automated notification from
Dreamux, not a message from the user." before either existing suffix
("Output below:" or the saved-to-file explanation); both branches and the
status lines themselves are unchanged (Q5, Codex). Not added to `<cron>` or
`<system>` submissions.

### 3.9 Claude Code skill adapter identity (`@excitedjs/agent-runtime-claude-code`)

Codex F1, reshaped after the external review of #380 (R30). The adapter root
stays keyed by the set of source roots (names and real paths, the version-1
key), so one set of roots always maps to one directory; the manifest
(`version: 2`) additionally records the child skill directories under each
root as they were when the view was built. Every start reads the inventory
from disk and compares it with the manifest: a mismatch — a renamed child
under an unchanged root after an in-place upgrade, a custom root that gained
or lost a skill, a manifest of the previous format — rebuilds the view beside
the root and swaps it into the same path, moving the stale tree aside and
removing it. The path a running child was given never changes and no earlier
view is left behind (the first shape of this fix opened a new directory per
inventory and never removed the old ones; the review named the unbounded
growth). Because the roots are read on every start, a custom root that was
deleted or moved fails the start with an error naming the source and its
path. The key is computed inside `materializeClaudeSkillAddDir`, which
returns the root; the runtime stores that root before spawning the child, and
`--add-dir` uses it. Owner: the Claude adapter (its cache, its native view).
No Core change, no provider ABI change, no old-name aliases. Tests: renaming a
child skill under an unchanged root refreshes the same root; a version-1 root
is refreshed in place; a malformed target left by a concurrent writer is
replaced; an unreadable root is named. Change file:
`@excitedjs/agent-runtime-claude-code`, `patch`.

### 3.10 Knowledge base and README

- `model-facing-writing.md` (Seed F1): add the §2-of-draft principles
  (identity carries no rule; a reminder states a consequence at the action,
  with R7's dispatch wording recorded as the operator's specific choice; one
  owner per rule in the nearest layer; skills load on intent via description
  plus tool pointer; per-engine visibility facts); rewrite the "Prompt Shape"
  Dispatcher bullets to the §3.2 content; re-point the no-polling ownership
  paragraph at `dispatch-reminders.ts` and the hand-off descriptions; rename
  the shared skill; `channel-<id>` → `channel-<provider>`.
- `dispatcher-skill.md`: names, roots, trigger design, required-source names.
- `provider-runtime.md`: reserved names; external-provider naming constraint.
- `channel.md`: server naming by provider; `source` attribute; reminder as the
  channel's consequence sentence.
- `dev-workflow/SKILL.md` and references (`solution-consultation.md`,
  `implementation.md`, `implementation-review.md`, `team-dissolution.md`):
  `team-workflow` → `teamwork`. Archived proposals and research notes keep
  historical names.
- `packages/dreamux/README.md`: the bundled-skills paragraph.
- `.agents/product/dynamic-workflow-usage.md`: its two references to the
  shared skill's path (found at implementation; the KB check fails on a dead
  path).
- `.agents/scripts/check.sh` green. `dreamux-maintenance` untouched (no
  config or state shape changes).

### 3.11 Change files

#369's two change files are replaced under new names
(`refine-model-facing-surfaces_<timestamp>.json`, via `rush change`):

- `@excitedjs/dreamux`, `minor`, not breaking: role prompts reduced to
  identity and server map; reminders as consequences; skills renamed
  `teamwork` and `dynamic-workflow` with narrow triggers; the channel MCP
  server named after the provider — fully qualified tool names change on both
  engines (`mcp__channel-<id>__reply` → `mcp__channel-feishu__reply`;
  `channel_<id>__…` → `channel_feishu__…` on Codex) while local tool names,
  schemas, results, config ids, and routing state do not; Team-scoped
  TeamMates receive an identity sentence; completions carry the notification
  sentence; #369's tool-description work.
- `@excitedjs/feishu-channel`, `minor`: `source="feishu"` attribute on both
  envelopes; the reminder as a consequence; #369's description rewrites.
- `@excitedjs/agent-runtime-claude-code`, `patch`: adapter identity includes
  the child skill inventory, so renamed bundled skills materialize after an
  in-place upgrade.

### 3.12 The P1 invariant, reconciled (Seed F2)

- Reply half ("an external ChannelProvider that exposes a reply tool without
  Feishu's inbound reminder"): by R4 each channel authors its own reminder;
  Core adds no fallback. An external provider that ships none has no
  Dreamux-authored sentence — a knowing consequence of R4.
- Public-artifact half ("a private channel task that leads to a public
  PR/Issue"): the TeamLeader secrets sentence (R2) and the Dispatcher secrets
  bullet (R19) are deleted; the Feishu `reply.text` clause covers replies only.
  After this PR no model-facing surface carries the public-artifact rule.
  Flagged for the operator at approval; if wanted, its home is the `teamwork`
  and `dispatcher-workflow` skills (the roles that write public artifacts),
  not a prompt.

### 3.13 Task records

`.agents/tasks/mcp/relocate-role-skill-guidance/README.md` (#369's record):
Delivery gains one line — #369 not merged by operator ruling of 2026-09-05;
content delivered through this task's PR. This task's README already states
that (Seed F6.3). `requirement.md` Evidence: the attachment-point sentence
drops `team.create` from today's list (Codex F6).

### 3.14 Corrections from the external review of #380

The reviewer (ryanxiang7) read the whole source change after the PR opened;
the operator ruled on the findings (R28–R33, requirement.md). Beyond §3.1,
§3.6, §3.7 and §3.9 above:

- The TeamLeader-facing `dissolve` description opens: "Your system prompt says
  whether Dreamux removes the Team's workspace on dissolve. If it does, first
  check the workspace for uncommitted, untracked, or unmerged work; if there
  is any, or you cannot tell, do not dissolve: report it and ask the user. A
  kept workspace never blocks the dissolve." The sentence #369 had moved from
  the old skill told every leader to check, while Core blocks a dissolve only
  for a managed delete-on-close worktree (R29).
- A managed worktree requested without `cleanup` defaults to `delete-on-close`
  (`worktree/manager.ts`; R31). `reuse-cwd` records `keep` and is never
  removed. The `cleanup` property description states the default, and the
  maintenance skill's service-lifecycle reference records what the Team
  record's `worktree.cleanup` is written from. The Team runtime registry's
  fallback request for a `repoCwd` without a worktree request (which pinned
  `keep`) is gone: both callers build the pair through `repoWorktree()`, which
  owns the managed-by-default policy.
- `team.create.prompt` carries `minLength: 1` like `teammate.spawn.prompt` and
  `team.send.prompt` (R32: an empty string submitted an empty first turn with
  the Team reminder attached).
- The `@excitedjs/dreamux` change note leads with `BREAKING:` and carries a
  `Rebuild:` line for the reserved skill names, the precedent of the workflow
  skill's own note; the `@excitedjs/agent-runtime-claude-code` note describes
  the in-place refresh and the named error for an unreadable root.
- `.agents/proposals/admin-control-plane-surface.md` names `teamwork`.

## 4. Adjudication of the reviewers' findings

Codex (its R21 reconsideration supersedes its first dispositions):

| Finding | Verdict | Effect |
|---|---|---|
| F1 Claude skill cache | Accepted, verified in source | §3.9 added; boundary widened to the Claude adapter; third change file |
| F2 host-boundary qualifier | Accepted | §3.2 keeps "ambiguous" |
| F3 file lists vs ownership (narrowed) | Accepted as narrowed | §3.5 item 2 carries reasoned write ownership and evidence paths; excludes edit plans |
| F4 (narrowed to `team_id`) | Accepted; the wording objection is moot because the sentence changed under R21 | §3.6 |
| F5 Team workspace overlap | Accepted | §3.3 Team text keeps the files sentence; J11 withdrawn |
| F6 `team.create` optional prompt, no reminder | Accepted | §3.3 create description qualified; reminder attached for prompt-bearing create; requirement Evidence corrected |
| F7 COT visibility | Withdrawn by Codex under R21; TeamLeader agrees | none |
| F8 negative tests | Accepted | §7: stable Dreamux-owned fragments, maintenance sentence asserted present, identity pass-through case |
| F9 "never orders" vs R7 | Withdrawn by Codex; TeamLeader agrees | §3.10 records R7 as the specific choice |
| Q1 | Agreed: gap recorded, no code | §3.7 |
| Q5 | Accepted | §3.8 keeps both suffix branches |

Seed:

| Finding | Verdict | Effect |
|---|---|---|
| F1 `model-facing-writing.md` plan | Accepted with one correction: the `channel-<id>` bullet exists at #369 (Seed read `next`) | §3.10 rewrite list |
| F2 P1 invariant unreconciled | Accepted | §3.12; operator flag at approval |
| F3 four `resolve` callers; comment; narrower alternative | Callers and comment accepted; the `{ id, implementation }` shape kept (one shape for both catalogs is fewer concepts than a second lookup for the same ref) | §3.7 |
| F4 merge-tree conflict | Rejected: `git merge-tree --write-tree --name-only origin/next origin/pr-369` exits 0 with no conflicted path; the implementation confirms at merge time | §2 |
| F5 catalog-filter overstatement | Accepted | §3.1, §8 probe wording |
| F6 test list (four corrections) | Accepted | §7 |
| F7 gate `dynamic-workflow`'s description | Accepted | §7 |
| F8 doc comment omits the maintenance sentence | Accepted | §3.2 |
| Q1 "fails loudly at launch" | Not adopted (unverified) | §3.7 |
| Q3 (a) no recorded path; (b) one ownership line | Accepted | §3.5 item 2 |

Judgments: J1–J10, J12, J14–J16 stand (both reviewers agree; J13 as narrowed
by Codex F3 and Seed Q3(b): the ownership *rule* lives in the `spawn`
description, the *assignment* lives in the brief). J11 withdrawn (Codex F5).
J3 stays an extension of R19 for the operator's approval (both reviewers
agree with deleting).

## 5. Scope and non-goals

In scope: §3.1–§3.13. Non-goals: `<system-reminder>` wrapping on Claude Code
(decision (h)); the other five Codex-style sections of the Dispatcher base
prompt; local tool names, schemas, results, and behavior of every Dreamux
MCP tool; `channels[].id` semantics, config schema, routing state, event
shapes; `<cron>` and `<system>` submissions; the Codex runtime package; the
Codex MCP envelope line ruled "先不修" earlier; the `dreamux-maintenance`
skill; Dispatcher-scoped TeamMate prompts.

## 6. Implementation boundary

`packages/dreamux/src`: `service/team-service/leader-agent.ts`;
`service/dispatcher-service/base-prompt.ts`;
`service/mcp/dispatch-reminders.ts`;
`service/teammate-collection/mcp-tool-descriptors.ts`, `index.ts`,
`system-prompt.ts` (new at implementation: `index.ts` sits at the shared
700-line lint cap, so the prompt join moved to its own module);
`service/team-collection/mcp-delegate.ts` (descriptions; create reminder);
`service/teammate-service/completion-renderer.ts`; `channel/catalog.ts`;
`channel/external-channel-provider.ts` (doc comment);
`service/channel-service/index.ts`, `mcp-delegates.ts`, `mcp-delegate.ts`;
`provider-diagnostics.ts`; `onboard/wizard.ts` (§3.7's fifth caller, type
only); `platform/paths.ts`. `service/dispatcher-service/runnable-channel.ts`
is not in the boundary: its structural resolver already returns `unknown`.
Both listings corrected at implementation on 2026-09-06 with §2 and §3.7.
`packages/channel/feishu-channel/src`: `feishu-submit.ts`,
`feishu-message.ts`, `feishu-session-ops.ts`.
`packages/agent-runtime/claude-code/src`: `skill-adapter.ts`,
`skill-materializer.ts`, `runtime.ts`.
Skills: the two renamed roots and three `SKILL.md` files. Tests: §7. KB and
README: §3.10. Change files: §3.11. Task records: §3.13.

## 7. Tests that change knowingly

| Test | What moves | Why |
|---|---|---|
| `dreamux/tests/team-leader-prompt.test.ts` | drop the 'reply tool' / 'public artifacts' case; add: identity arrives last; with `identityPrompt: null` the prompt contains none of `do not poll`, `reply tool`, `public artifacts`, `Load a tool`; the workspace sentence for a reused, a managed kept, and a managed delete-on-close workspace | R2, R5, Codex F8, R29 |
| `dreamux/tests/mcp-tool-descriptions.test.ts` | skill roots renamed; `dynamic-workflow` added to `SKILL_DESCRIPTION_SOURCES`; both Dispatcher prompts: contain `Load \`dreamux-maintenance\``, contain none of the four fragments above; hand-off descriptions (spawn, send, team.create, team.send, workflow_run) state the pushed completion | §3.2, §3.3, §3.5, Seed F7, Codex F8 |
| `dreamux/tests/bundled-skill-sources.test.ts` | names per root; README regexes | §3.5 |
| `dreamux/tests/channel-input-format.test.ts` | seven attrs including `source`; the position is not asserted | R13, R33 |
| `dreamux/tests/channel-service.test.ts`, `mcp-delegate-catalog.test.ts`, `codex-live.test.ts` | provider-named server and identity | R12 |
| `dreamux/tests/completion-renderer.test.ts` | the notification sentence in both branches | R14 |
| new `dreamux/tests/teammate-system-prompt.test.ts`: TeamMate system-prompt order (Team-scoped, dispatcher-scoped, workflow agent — the last without the TeamLeader sentence) | §3.6 | R9, R28 |
| new `dreamux/tests/team-create-reminder.test.ts`: Team delegate `create` with prompt carries the Team reminder; without prompt, or on an `existing` replay, carries none | §3.3 | Codex F6 |
| new `feishu-channel/tests/feishu-settlement-envelope.test.ts`: the settlement envelope carries `source` among its attrs and the same reminder | §3.7 | J9, R33 |
| feishu-channel `feishu-message-budget.test.ts` | reminder text where quoted (at implementation only this file had a word to change; `public-api.test.ts` and dreamux `package-boundary-guards.test.ts` name the export, not the text, and are untouched) | R4 |
| `claude-code/tests/skill-materializer.test.ts` | renamed child under an unchanged root → the same root refreshed in place; a version-1 root refreshed; a malformed concurrent target replaced; an unreadable root named | §3.9, R30 |

Untouched, by decision: `mcp-public-failures.test.ts` (`channel-x` is an
inline fixture), `completion-delivery.test.ts` (hand-built bodies),
`feishu-cot-tool-rows.test.ts`, `claude-code/tests/tool-display.test.ts`,
`claude-code/tests/runtime-submissions.test.ts` (`team-workflow` as sample
text only).

## 8. Verification

Gates: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`,
`.agents/scripts/check.sh`, `rush change --verify`, the gitleaks pre-commit.

Beyond the gates, before the PR is marked ready: start a Claude Code
TeamLeader from an existing adapter cache after the rename and confirm the
new skills are listed (§3.9); on both engines observe the tool list
(`channel-feishu` / `channel_feishu`) and one reply through it. After
release, the acceptance probes of §1 through the operator's Codex TeamLeader
and a Claude Code TeamLeader, worded as "which skills did you load on this
turn and why" and "can you find the Feishu channel's tools".

Residual risks: description-driven skill loading is the engine's heuristic;
whether a model associates `source="feishu"` with `channel_feishu` is
empirical; the dispatch reminders are invisible on Claude Code, so the
description sentence is the only carrier there; external-provider server
names remain unverified on both engines (no such provider exists).

## 9. For the operator at approval

- J3: delete the second channel-reply sentence in the Codex Dispatcher prompt
  ("# Working With The User"), beyond R19's named bullets.
- §3.12: after R2 and R19 no model-facing surface says to keep private chat
  content out of public PRs and Issues. Leave it out, or put it in the two
  hand-down skills?
- §3.9: the Claude adapter cache fix widens the PR into the Claude Code
  runtime package (third change file). Without it an in-place upgrade leaves
  existing Claude TeamLeaders unable to load the renamed skills.
- Everything else follows R1–R21 as recorded, with the extensions J1, J2, J4–J10,
  J12–J16 as named in the draft.
