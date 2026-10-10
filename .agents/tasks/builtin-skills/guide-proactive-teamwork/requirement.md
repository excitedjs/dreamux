# Requirement

## Outcome and scope

Encourage proactive TeamMate collaboration when delegation can save time or
improve quality, using Codex Ultra's delegation direction without changing the
runtime's effort setting. Keep one concise collaboration route in the TeamLeader
launch prompt. Teamwork owns collaboration methods and practical tool usage;
MCP descriptions retain calling contracts.

## Confirmed operator decisions

Operator, 2026-10-10, verbatim:

> 这块的提示词可以尽量往Ultra Mode上去靠。让 gpt 认为teammate 是一个更强大的subagent 系统就够了

> 我觉得 teammate 系列的 mcp 工具介绍可以放回 teamwork 技能里了。
> 我希望主动增加模型调用 teammate 的倾向性，就像 codex 默认打开了 ultra 模式一样。
> team leader 的identity 应该简单一句话引导agent，主动加载 teamwork 技能，学习 teammate 协同工作方式

The operator narrowed the loading condition, verbatim:

> 如果 提示词写的过强的话，他会每一 turn 都去加载 teamwork 技能，我不想要这样。

The approved proposal encourages collaboration continuously but consults the
skill only when needed guidance is missing from current context. A new turn or
handoff alone is not a reload trigger. Frontmatter and launch guidance must agree.

The operator required standing identity consequences, verbatim:

> 如果他在 identity 里写了: 只允许修改 a目录下的文件，那没有任何办法让这个 teammate 突破这条限制去修改预期之外的内容了。
> 所以需要把这个后果在  teamwork 技能里写清楚。

The skill must explain that identity lasts across turns and close/reopen,
`send` cannot update it, and task prompts cannot override conflicting standing
instructions. Temporary task and directory assignments belong in `prompt`;
a changed standing role requires an appropriately briefed new member, subject
to any continuing user and repository constraints. Explain instruction precedence
without promising filesystem permission enforcement.

## Acceptance and limits

The operator requested the skill-creator guidance and then authorized the
focused rewrite on 2026-10-10, verbatim: "先修一下". Preserve the approved
collaboration and lifetime-identity behavior while reducing generic repetition
and replacing absolute judgments with evidence-based decision criteria.

- The real launch fixture receives the teamwork route; only one collaboration sentence is added before plugin and operator identity instructions.
- Skills and tool descriptions impose no per-turn or per-handoff skill reload requirement.
- Teamwork covers independent briefs, shared-workspace writes, tool use, lifetime identity consequences, and evidence-based integration.
- MCP schemas, async receipts and pushed completion, lifecycle behavior, and persisted formats retain their existing contracts.
- Independent reviews use the two requested runtimes: trae-seed and mimo.
- Runtime effort settings, recursive member spawning, and Dispatcher methodology changes are out of scope.
- Specialized post-training is the operator's hypothesis, not a source-verified fact. Actual model loading frequency and instruction adherence remain unmeasured; these prompts are guidance rather than runtime deduplication.
