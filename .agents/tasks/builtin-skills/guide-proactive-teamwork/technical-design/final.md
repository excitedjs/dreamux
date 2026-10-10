# Approved prompt and skill boundaries

The operator approved this three-layer proposal on 2026-10-10.

## TeamLeader launch prompt

Add one sentence, keeping plugin instructions followed by operator identity:

> Use TeamMates proactively when delegation can save time or improve quality, and consult the `teamwork` skill when you need collaboration guidance that is not already in your current context.

Source: `/packages/dreamux/src/service/team/leader.ts`. This explicitly supersedes
the TeamLeader portion of the historical role-only prompt rule. The Dispatcher
skill route is unchanged.

## Teamwork

The skill frontmatter uses the same missing-guidance condition. Its body explains
proactive delegation, capable collaborators, deliberate context and shared writes,
briefs, standing identity consequences, eight TeamMate tools, and result integration.
It explicitly reuses guidance already in context, including across handoffs.
Scripted workflows retain the separate dynamic-workflow guide.

Identity is a stored standing instruction, not a per-turn assignment. The member
prompt appends it after plugin instructions; Codex maps it to developer instructions
and Claude Code to appended system text. Reopening rebuilds from stored identity.
`send` updates tasks and optionally intent, with no identity parameter. Explain
the directory-a/directory-b conflict and use a new member when the standing role
must change, while preserving continuing user constraints.

Sources: `/packages/dreamux/skills/team-leader/teamwork/SKILL.md`,
`/packages/dreamux/src/service/agent/system-prompt.ts`,
`/packages/dreamux/src/service/agent/index.ts`,
`/packages/dreamux/src/service/agent/requests.ts`,
`/packages/agent-runtime/codex/src/system-prompt.ts`, and
`/packages/agent-runtime/claude-code/src/args.ts`.

## MCP calling contracts and knowledge

Shorten TeamLeader spawn/send descriptions, preserving their shared workspace,
concrete name, reopen, and async completion facts. Parameter descriptions carry
runtime selection, recovery intent, and lifetime identity semantics. Name-prefix
wording explicitly requires the concrete, never-reused returned name for later
calls. Tool schemas and handlers do not change.

Update current skill and model-facing KB owners and the product catalog. Keep the
Codex source investigation frozen with its disposition last; this task owns the
approved follow-up, not the research snapshot. One generated Rush patch note
covers the final behavior. No new runtime mechanism or persisted fact is added.
