# Codex Ultra delegation

Frozen source investigation, 2026-10-10. Snapshot: upstream `openai/codex` main
at `322bbf4d8486efd7dbbcf49598711a9e3fefc282`. This describes source behavior;
no live inference or Codex test suite was run for this investigation.

Ultra selects proactive multi-agent guidance as well as a model-owned inference
effort. The selected effort, collaboration role, and delegation mode are
separate inputs. It does not automatically spawn agents.

## From selected effort to model input

1. With multi-agent V2 active, `effective_multi_agent_mode` reads the selected
   effort before wire normalization. Without an overriding hint, `Ultra`
   selects `Proactive`; another effort selects `ExplicitRequestOnly`.
   This applies to both the root and spawned-thread agents.
2. `session/world_state.rs` adds separate role and mode sections. Both render
   developer messages. The mode body is wrapped in `<multi_agent_mode>`.
   Catalog-provided role bodies use `<multi_agent_role>`; bundled role fallbacks
   and configured role replacements have no such wrapper.
3. The mode section emits a new fragment when the mode or role hint changes;
   it emits nothing when both are unchanged. Leaving Ultra emits the explicit
   mode, which revokes earlier proactive guidance. This also survives cold
   resume through the world-state checkpoint.
4. `client.rs::build_reasoning` separately resolves the inference effort through
   `ModelInfo::resolve_reasoning_effort`. Ultra uses a supported, non-Ultra
   `multi_agent_reasoning_effort` from the model, otherwise supported `max`,
   otherwise the last advertised non-Ultra level, otherwise `medium`.

The snapshot's bundled catalog maps Ultra to `xhigh` for `gpt-6.1-sol` and
`gpt-6-astra`, even though they also advertise `max`. Other Ultra-capable rows
without that override use `max`. These are catalog facts at this revision,
not permanent model contracts or proof of a deployment's remote catalog.

Sources at the pinned revision:

- [Mode and role selection](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/core/src/session/multi_agents.rs#L14-L121).
- [World-state assembly](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/core/src/session/world_state.rs#L358-L366).
- [Mode developer fragment](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/core/src/context/multi_agent_mode_instructions.rs#L26-L52)
  and [mode transitions](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/core/src/context/world_state/multi_agent_mode.rs#L61-L89).
- [Request effort](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/core/src/client.rs#L929-L938),
  [normalization](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/protocol/src/openai_models/reasoning_effort.rs#L8-L39),
  and [bundled catalog](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/models-manager/models.json).

## Exact mode text

The bundled proactive body, rendered with its mode wrapper:

```text
<multi_agent_mode>
Proactive multi-agent delegation is active. Any earlier developer instruction requiring an explicit user request before spawning sub-agents no longer applies. This mode remains active until a later multi-agent mode developer message changes it. User requests override this hint.

If at any point you can parallelize work by delegating tasks to another agent (no matter if you are root or subagent), you should do so using collaboration tools if it could save time or improve quality.
</multi_agent_mode>
```

The bundled explicit body:

```text
Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.
```

Source: [resolved multi-agent messages](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/prompts/src/model_messages/multi_agent.rs#L7-L81).

## Role text is separate from Ultra

The root role begins:

```text
You are `/root`, the primary agent in a team of agents collaborating to fulfill the user's goals.

At the start of your turn, you are the active agent.
You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents.
All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.
```

The rest names `spawn_agent`, `followup_task`, `send_message`, context control,
and the parent/child message envelope. The child role likewise grants
delegation and explains that its final answer is delivered to its parent.
Catalog roles also remind agents to make human-visible messages legible.

Role assembly appends shared-filesystem facts, the runtime's concurrency count,
long-wait guidance when `wait_agent` is enabled, and model-override guidance
when that surface is exposed. Full-history forks inherit model and effort;
explicit overrides require `fork_turns = "none"`. The shared instructions also
explain that native collaboration tools are called directly, outside
`functions.exec`.

These role instructions are selected for V2 independently of Ultra. Switching
effort changes the mode; it does not add this entire role prompt for the first
time or itself create a collaborator.

Source: [role assembly](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/prompts/src/multi_agent_instructions.rs#L8-L83).

## Overrides and evidence limits

Mode precedence is configured `multi_agent_mode_hint_text`, catalog
`mode.hint_text`, then effort-selected catalog `mode.proactive` or
`mode.explicit`, then bundled text. An empty selected hint suppresses that
fragment. Role precedence is likewise configured role, catalog role, bundled
role. A configured role replaces the composition, including its appended
runtime guidance.

V1 does not receive these V2 role/mode fragments, even with Ultra selected;
effort normalization still applies. Existing integration tests capture request
developer messages and normalized effort, custom and empty hints, effort
switches, cold resume, and the V1 boundary. They were read, not executed here.

Source: [multi-agent mode integration tests](https://github.com/openai/codex/blob/322bbf4d8486efd7dbbcf49598711a9e3fefc282/codex-rs/core/tests/suite/multi_agent_mode.rs).

## Disposition

- **Promoted:** useful proactive delegation, capable collaborators, deliberate
  context, and shared-workspace coordination inform the bundled
  [teamwork skill](/packages/dreamux/skills/team-leader/teamwork/SKILL.md).
  Evidence-based integration remains the TeamLeader's responsibility.
- **Superseded wording:** the skill's claim that only a TeamMate has its own
  judgment is replaced by the more capable, durable subagent framing. Operator,
  2026-10-10, verbatim: "这块的提示词可以尽量往Ultra Mode上去靠。让 gpt 认为teammate 是一个更强大的subagent 系统就够了".
  In English: stay close to Ultra Mode's prompt wording and let GPT treat
  teammates as a more powerful subagent system.
  It supersedes treating the subagent analogy itself as undesirable; the
  requirement to let members challenge the leader's framing remains intact.
  [The original task](../tasks/builtin-skills/teamwork-teammates-are-not-subagents/README.md)
  remains historical evidence. The operator's rationale about specialized
  post-training is a hypothesis this source investigation cannot verify.
- **Out of scope:** changing Codex effort/catalog configuration, native tool
  contracts, Dreamux runtime prompts, or enabling recursive Dreamux TeamMate
  spawning. Codex's permission override is not copied into a skill as authority
  to override an active runtime or user restriction.
