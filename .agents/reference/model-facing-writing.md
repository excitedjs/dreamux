# Reference: model-facing writing

Model-facing text is any text that can shape what an agent believes it can do.
In Dreamux that includes bundled skills, system prompts, MCP tool descriptions,
MCP error text, structured MCP result field names, README current guidance, and
current KB reference pages. Treat tests that assert this text as part of the
product contract too.

Current source owners:

- `/packages/dreamux/skills/`
- `/packages/dreamux/src/service/dispatcher-service/base-prompt.ts`
- `/packages/dreamux/src/service/team-service/index.ts`
- `/packages/dreamux/src/mcp/teammate-mcp.ts`
- `/packages/dreamux/src/mcp/team-mcp.ts`
- `/packages/dreamux/src/mcp/cron-mcp.ts`
- `/packages/dreamux/src/admin/methods.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`

## Reader First

Role-gated injection already chooses the reader. A Dispatcher-only skill should
not spend body text explaining that only Dispatchers should read it; it should
tell the current Dispatcher when to load it and how to use the visible tools.
The same applies to TeamLeader skills and caller-specific MCP descriptions.

Before adding a rule, verify the real tool projection in source:

- Dispatcher-visible tools are not automatically visible to TeamLeaders.
- TeamLeader-visible `team` MCP exposes only `transfer_back`.
- Ordinary TeamMates and team members receive no bundled Dreamux skill by
  default.
- Channel reply tools exist only when the active Channel provider exposes them.

Do not invent a communication path. If there is no tool or runtime delivery
mechanism for "ask the Dispatcher" or "send a report to the Dispatcher", do not
write those phrases.

## Current Contract, Not History

Write product behavior in present-tense positive terms. Avoid migration and
roadmap prose in model-facing text:

- avoid "legacy fallback", "old symlink", "removed verb", "this milestone", and
  "there is no separate tool" wording;
- describe the current surface the model should use;
- put package-surface removals, upgrade notes, and historical comparisons in
  Rush change files or clearly historical decision records.

Examples:

- Prefer: "Cron jobs inject prompts back into this agent."
- Avoid: "This milestone supports only internal prompt-agent jobs."
- Prefer: "`send` can reattach to a resumable closed TeamMate from the recorded
  runtime session."
- Avoid: "There is no separate resume tool."

## Provider Neutrality

Core Dreamux text must keep channel provider data opaque. Generic skills,
prompts, MCP descriptions, and current reference docs can say that `meta` is
provider-defined and that the active provider's tool schema/result is authority.
They must not use Feishu `chat_id`, `list_chat_bots`, or group-chat examples as
the generic Dreamux contract.

Provider-specific examples belong in provider docs or explicitly labeled
examples, such as a "Built-In Feishu Example" README section. Core structured MCP
results should also avoid provider field names; expose normalized target facts
such as `target_key`, `target_type`, `channel_id`, and `provider` instead of
projecting provider selectors like `chat_id` as top-level fields.

## Prompt Shape

System prompts should route to the right skills and state durable role
boundaries. They should not become tool manuals or repo-development policies.

Dispatcher replacement prompts replace the runtime's model-selected base
instructions. For Codex, the current source of truth is the model catalog entry
(`models-manager/models.json`) and the selected model entry's
`base_instructions` / `model_messages`, not older per-version prompt markdown
files. Dreamux should track the selected Codex model's non-coding contract
(currently GPT-5.5 when that is selected or default): personality/tone, simple
terminal requests, planning-tool use, review-answer shape, progress updates,
safe handling of unexpected local changes, destructive-command caution, and
concise final-answer behavior. Remove code-editing and frontend-production
guidance unless the Dispatcher role itself needs it.

Dispatcher prompt content should still be compact and role-specific:

- identify the Dreamux Dispatcher role;
- load `dispatcher-workflow` before TeamMate, Team, channel, or cron MCP work;
- load `dreamux-maintenance` before Dreamux host/server diagnosis;
- state that repository implementation, debugging, and review work should be
  delegated to TeamMate/Team MCP by default;
- forbid reading or editing repository code files under the dispatcher working
  directory unless the user explicitly asks the Dispatcher to do that local
  inspection or edit;
- treat MCP tool results as authority for Dreamux state;
- use provider-exposed reply tools for visible channel delivery when available;
- keep provider `meta` opaque and protect secrets/private identifiers.

Append prompts layer onto an already-capable runtime prompt, so they should be
short role deltas rather than a full reintroduction.

Do not copy repository contributor guidance into product prompts. `AGENTS.md`,
`apply_patch`, PR review rituals, citation-marker cleanup, frontend-production
style rules, and Dreamux open-source publication rules belong to repo work, not
to every Dispatcher user.

## MCP Descriptions And Results

MCP descriptions are model-facing. Keep them short and operational:

- what the tool does;
- which identifier the caller must use;
- what result or side effect is authoritative;
- important non-obvious cautions, such as shared-workspace write coordination.

Avoid internal architecture adjectives and implementation layouts in tool
descriptions: "core-owned", "hidden tool", `.workspace/work/<name>`, and
package/release milestone language are not useful operating instructions.

For caller-specific surfaces, split descriptions by caller when needed. A
TeamLeader-facing `transfer_back` description should say it is a routing-only
state change with no channel-message side effect; it should not describe
dispatcher routing or imply message delivery.

Structured result names are also model-facing. If a field names a provider shape
or an old concept, fix the projection rather than documenting around it.

## Tests

Tests should protect contracts, not prose preferences. Prefer:

- role-to-skill mapping assertions;
- schema/field whitelists;
- tool-surface visibility assertions;
- negative gates for banned coupling or history text, such as `Feishu`,
  `chat_id`, `legacy`, `.codex/skills`, `tm spawn`, `apply_patch`, `AGENTS.md`,
  `this milestone`, or invented Dispatcher communication phrases.

Use exact positive strings only for stable public names and command surfaces,
such as skill names, MCP tool names, CLI commands, and daemon subcommands.
Avoid exact-sentence `toContain` assertions for skill prose, prompt prose, or MCP
descriptions. Those tests make incidental wording harder to fix than behavior.

## Review Checklist

Before landing model-facing changes:

- list every touched model-facing surface, including tests;
- verify each capability claim against source, not against older docs;
- check the text from the current reader's role and visible tool projection;
- remove provider-specific examples from core guidance;
- remove migration/history/meta prose from runtime-facing text;
- make progress-report guidance conditional on an available provider reply tool;
- run the focused text/contract tests, the relevant source tests, `.agents`
  validation, skill validation, `rush test`, and `rush lint`.
