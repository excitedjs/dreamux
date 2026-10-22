# Requirement

## Operator requests

The operator requested less distracting, repetitive MCP results and runtime
selection guidance on 2026-10-22. Original wording is quoted as evidence:

- Runtime configuration: "description 描述什么时候应该使用这个 runtime";
  "developerInstructions 追加到系统提示词后面"; tags can be arrays such as
  `["explorer", "fast"]` and `["architect", "very slow"]`.
- Capabilities: "verbs 感觉是废代码" and "agent_runtimes 的 spawn 可以去掉了，runtime_available、unsupported_reason、public_config 感觉也没啥用".
- Expanded scope: "可以，你把 TeamMate 和 Team 两套 MCP 的返回值，按照这个标准去过一遍" and "每个 MCP 工具的返回值之间，不要有太多的重复".
- Space identity: "identity 返回不要只写一个有没有".
- Historical evidence: "让 deepseek 去" and "特别是那些 MCP 工具没有返回、还需要写脚本去跑的其他属性，这部分属于返回值不足的场景，找到之后应该给我补充上".
- Reminder delivery: "我们返回了 Content 的那些工具，反而应该不再返回 Structured Content".
- Text refinement on 2026-10-23: "精简掉 Structured Content，就是需要把一些事实直接拼到文字里"; implementation authorization: "可以，按照这个模式来改一下".
- Separate activity question: "last 这边，你有什么建议的方案吗？" requests a
  recommendation; this follow-up does not implement a native log path contract.

## Desired behavior and boundary

Optional configured runtime metadata guides selection; standing developer
instructions append to the final system prompt. Capabilities return selection
metadata, never the instruction text or provider diagnostic scaffolding.

Receipts return actionable addresses and admission outcomes. Lists support
selection; details support investigation and recovery. Repeated full snapshots,
argument echoes and derivable counters are removed. Historical evidence guides
missing facts; a missing consumer in a sample does not prove a field useless.

Nonempty operation-owned text states the actionable facts and reminder as the
complete model-facing result, without a JSON copy or structuredContent. Absent
or empty text retains structured output. Admission/completion and member reply semantics
remain unchanged. Space details return the stored identity text or null.

Scope includes owner/member TeamMate, workflow, Team, space tools and the shared
wire adapter. Domain/Command DTOs keep facts needed by administration and routing.
Existing config files stay readable. No new version, migration, health probe,
output mode, native log path contract, or message-history database is introduced.
Live settings, deployment and merge are outside this authorization.

## Acceptance criteria

1. Optional metadata survives parsing/stringification, replacement and onboarding.
   Reconfiguring one runtime preserves its metadata and unrelated runtimes.
   Nonempty instructions
   appear once after existing instructions in each provider alternative at
   creation/resume across roles.
2. Capabilities contain runtime ids and supplied selection metadata only.
3. Independent expected MCP/Command results preserve domain/error semantics.
4. Real SDK calls forward authored facts and reminders verbatim without a JSON
   prefix or structuredContent. Absent/empty text, ordinary read schema
   validation, and conditional reminder branches still work.
5. Space get returns exact identity text and preserves null/not-found behavior.
6. TeamMate status exposes record timestamps, explicitly not activity timestamps;
   a Leader can read its own Team status without reading persisted files.
7. The reproduced Claude activity-reader defect is fixed: non-participant tail
   records must not turn an active conversation into a successful empty page.
8. Historical findings include coverage limits; sensitive source logs stay out of
   the repo. Build, lint, tests, test typechecking and the KB check must pass.

## Decisions and unknowns

- The requests above are confirmed operator direction. Concrete field projections
  and owner-bound self-status are implementation choices for that direction.
- Historical evidence supports retaining session ids in details. Replaying the
  historical in-progress snapshot against the current reader reproduced the empty
  page despite existing activity. The source fix belongs to the Claude provider;
  record timestamps do not solve activity visibility.
- A separately observed runtime-home configuration change can still make an old
  session unavailable under the newly configured home. This task does not add
  filesystem discovery or configuration migration.
