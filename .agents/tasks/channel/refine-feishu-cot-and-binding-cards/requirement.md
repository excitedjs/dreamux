# Requirement

## Initial request

- Operator request, 2026-09-07:
  - "COT 的 toolresult 截断策略改一下，增加超过 10行截断（已经识别成 json 的不做截断）".
  - "feishu 的绑定卡片增加显示 agent runtime 和 cwd（这是上次重构丢掉的功能）".
  - "飞书COT换锚点的时候，老卡的关闭状态改成成功，而不是现在这个任务中断".
  - "解绑卡片也需要设计一下 这个地方分为解绑和团队解散。如果飞书Channel通过MCP触发了解绑的话，就发解绑卡片。如果是收到团队解散通知，被动触发解绑，就发团队解散卡片。"
- The operator chose to create a new task rather than reopen the existing
  Feishu COT conversation-cards task.

## Current alignment

- Status: Final. The operator selected notification-card set 2, required all
  visible copy to be English, and extended that set's full-width detail-panel
  treatment to the route-bound card's runtime-cwd section.
- Confirmed current behavior and evidence:
  - `toolResultOutput` parses the complete result before choosing its Feishu
    segment. A JSON object or array becomes pretty-printed JSON; every other
    non-empty value becomes plain text. Both are currently cut only when the
    assembled event would exceed Feishu's 4,096-byte content limit.
  - A route-bound card currently shows target, binding kind, Team, and optional
    collaboration-space name. Commit `2ed5f5ea` removed the TeamLeader name,
    Agent Runtime, and runtime cwd that the prior Core binding-event projection
    supplied. The current product catalog still says a route-bound card names
    the TeamLeader, runtime, and runtime cwd.
  - Manual binding already invokes `team.status` before a route is persisted.
    Its canonical answer includes the Team's `leader_agent_runtime` and the
    TeamLeader's `repo.path` (the runtime cwd), but the current binding path
    discards that detail after checking status. Automatic provisioning owns the
    successful `team.create` receipt, so that receipt must carry the same two
    facts instead of forcing an immediate second Core query.
  - Replacing an anchor currently detaches its open card with the
    `interrupted` terminal. Runtime-reported interruption, route release, Team
    closure, and Channel-session close also use interruption through distinct
    lifecycle paths.
  - Manual/MCP unbind and passive route removal after Team closure currently
    both call `bindingUnboundCard`, so the conversation cannot tell whether an
    operator removed only this route or the Team itself ended. The source paths
    are already distinct: `unbindChannel` owns the former, while
    `announceTeamClosed` owns the latter.
  - A Seed UI consultation checked the official Feishu Card 2.0 structure,
    component-level localization, layout, table, and collapsible-panel
    documentation, then successfully sent and read back six private rendered
    candidates. Card 2.0 requires Feishu client 7.20 or newer; older clients
    show only the title and an upgrade prompt. The table candidate cannot
    localize its labels because Card 2.0 tables expose raw strings and Card 2.0
    has no global localization envelope.
- Desired outcome: Keep routine COT output compact, restore the requested Team
  runtime context on route-bound cards, and make only anchor replacement close
  the superseded card successfully.
- Desired behavior:
  1. A non-empty plain-text tool result with at most 10 lines is unchanged. A
     plain-text result with an eleventh line is reduced to its first 10 lines
     and an explicit truncation marker. The existing Feishu byte-budget cut
     remains the final bound. A terminal LF or CRLF terminates the tenth line;
     it does not create an eleventh content line by itself.
  2. A result recognized as a JSON object or array is exempt from the 10-line
     rule, including when pretty-printing produces more than 10 lines; it remains
     subject to Feishu's byte limit. JSON scalars remain plain text and therefore
     use the line rule.
  3. A successful route bind shows the Team's Agent Runtime and actual runtime
     cwd in the confirmation card, using canonical data obtained from Core before
     the route becomes visible. This applies to manual and automatically
     provisioned route-bound cards; space-policy cards are not the lost route
     presentation and retain their current fields.
     The route-bound card keeps the selected Card 2.0 candidate 4 Team-focus
     hierarchy: the Team name is the primary heading and target, TeamLeader,
     and Agent Runtime are three compact facts below it. Its runtime-cwd area
     adopts the selected unbind set 2 treatment: one full-width tinted detail
     panel with a static label and a literal dynamic value. The Agent Runtime
     value is the configured runtime ID (for example `trae-gpt`), never a
     provider reference such as `builtin:codex`. Dynamic names and paths must
     remain literal text even when they contain Markdown-significant
     characters.
  4. When a new inbound replaces a recipient's current anchor, an open card on
     the old anchor closes with Feishu's successful `done` terminal. Activity
     continues on the new anchor as it does today.
  5. A route removed by the Feishu Channel MCP unbind path sends a distinct
     active-unbind card. A route removed passively because the Channel received
     a Team closed/dissolved notification sends a distinct Team-dissolution
     card. The cards communicate different causes; the passive card must not
     imply that only the individual conversation route was manually removed.
     Both use selected UI set 2: a Team-focused hero, a three-column
     target/binding/Team fact row, and a full-width reason panel. The active
     unbind card uses neutral grey treatment and says the Team remains active;
     the Team-dissolution card uses an orange warning accent and says Team
     closure caused all of that Team's routes to be removed automatically.
     The Team-dissolution wording is reserved for a final
     `team.state(status: 'closed')` fact. A route removed early after Core
     rejects an inbound with `TEAM_CLOSED` keeps a cause-neutral route-ended
     notification because the same code also means a dissolve is only in
     progress and may still be refused.
  6. All fixed user-visible copy in the route-bound, active-unbind, and
     Team-dissolution cards is English. Preview-only candidate/set labels are
     absent from production cards. Dynamic target, Team, TeamLeader, runtime ID,
     and cwd values are shown unchanged rather than translated.
- Scope: Feishu COT result presentation, Feishu route-bound notification cards,
  the canonical Core query used during manual route binding, the neutral
  `team.create` result consumed by automatic provisioning, and directly
  affected tests and current knowledge.
- Non-goals:
  - No Core-side truncation and no line cap for assistant text, tool arguments,
    item pills, or JSON object/array results.
  - No persisted routing/config/state format change.
  - No change to collaboration-space policy cards.
  - No change to runtime-reported `interrupted`, route release, Team closure, or
    session shutdown; those cards remain interrupted.
  - No change to the existing early removal and single Dispatcher fallback for
    a routed inbound rejected with `TEAM_CLOSED`; only its notification remains
    factually neutral until final Team closure is published.
- Constraints and invariants:
  - JSON recognition still happens before any output truncation.
  - Core owns Team and Agent runtime facts; the Feishu Channel may display the
    canonical answer but must not reconstruct those facts from paths or local
    state.
  - `team.status` reports a closed Team successfully with `team.status` equal to
    `closed`; only a nonexistent Team throws `TEAM_NOT_FOUND`. The Channel must
    not translate that Core failure or invent a thrown `TEAM_CLOSED` status
    path.
  - Binding validation, durable route mutation, COT fencing, and best-effort
    notification ordering must stay intact.
  - Existing per-event byte limiting remains authoritative after the new
    plain-text line limiting.
  - The selected route-bound card uses Card 2.0 and therefore requires Feishu
    client 7.20 or newer. Selecting candidate 4 after that limitation was
    presented accepts this client baseline for this notification. Selecting
    unbind set 2 applies the same Card 2.0 baseline to active-unbind and
    Team-dissolution notifications. Collaboration-space policy cards remain on
    their existing schema.

## Acceptance criteria

1. Plain-text results of 0-10 lines render without a line-count marker; an
   11-line result renders the first 10 lines followed by the existing English
   truncation marker, within the 4,096-byte event limit.
2. A JSON object or array whose pretty-printed form exceeds 10 lines is not cut
   at line 10, but an oversized JSON value is still cut to the event byte limit.
3. Every successful manual or provisioned route-bound card uses the selected
   Team-focus Card 2.0 layout, with its runtime cwd in the set-2 full-width
   tinted detail panel, and displays the bound Team's TeamLeader name,
   configured Agent Runtime ID, and runtime cwd from Core's canonical status
   result. It never substitutes the provider reference for the runtime ID.
4. Three consecutive inbound anchors leave the first two cards closed as
   `done` and the newest card open. Mid-native-turn replacement continues
   subsequent activity on the successor card.
5. A real runtime `interrupted` end, route release, Team closure, or session
   close still closes the affected open card as interrupted.
6. An MCP-triggered unbind renders the selected active-unbind card, while each
   route removed after a Team closed event renders the selected Team-dissolution
   card. A route removed on a pre-final `TEAM_CLOSED` admission rejection never
   claims that the Team dissolved. Each flow keeps its existing route mutation,
   COT fence, and single Dispatcher fallback behavior.
7. The three route notification cards contain English fixed copy only, have no
   preview labels, and render dynamic values literally even for Markdown
   punctuation and long cwd values.
8. Build, lint, tests, and test typechecking pass.

## Decisions and unknowns

- Confirmed operator decisions:
  - This is a new task rather than a continuation of the prior COT task.
  - JSON-recognized tool results are exempt from the 10-line truncation rule.
  - Anchor replacement closes the old card successfully rather than as
    interrupted. This ruling is intentionally narrower than other lifecycle
    terminals.
  - A Seed TeamMate must research official Feishu card documentation, design
    5-6 rendered UI candidates, and send them privately to the operator for a
    direct selection; the source group is not the preview surface.
  - "先选4吧。运行时填id而不是provider": candidate 4 is selected, and its
    runtime field is the configured Agent Runtime ID rather than a provider
    reference.
  - Active Feishu Channel MCP unbind and passive route removal after a Team
    dissolution are different user-visible causes and must render different
    cards.
  - "选套装2 吧": active-unbind and Team-dissolution cards use paired UI
    set 2.
  - "文案都改成英文。": all fixed copy in the selected production cards is
    English.
  - "给绑定卡片的那个工作区也改成解绑卡片套装2相同的风格": the
    route-bound card's runtime-cwd/workspace section uses the same full-width
    detail-panel visual treatment as unbind set 2.
  - "返回值这边增加一些字段，本来就可以避免去调用Status": automatic
    provisioning consumes runtime ID and cwd from `team.create`; it does not
    follow creation with `team.status`.
  - "closed 确实是正常状态，调用可以返回出这个 team 的status，调用并不会
    throw error，但是 TEAM_NOT_FOUND 是团队name 不存在，那接口就应该throw
    error": manual binding checks `closed` in the successful status response
    and preserves `TEAM_NOT_FOUND` as the Core-authored thrown failure.
- Assumptions:
  - "超过 10 行" means ten lines remain whole and the rule first triggers on
    line eleven.
  - "cwd" means the TeamLeader runtime working directory shown by the old
    route-bound card, not the collaboration-space repository policy.
- Blocking unknowns: None.

## Post-merge presentation correction

After PR #386 merged, the operator reported that the route-bound, active-unbind,
and Team-dissolution cards were visually too loose:

- "首先，团队名字的字体太大了。我预期这张卡片里，除了标题以外，其他
  字体全部都是正文字体大小"
- "其实卡片上下的行间距太长了"

The accepted correction is deliberately presentation-only:

1. In those three Card 2.0 notifications, only the header title keeps title
   typography. The Team name, subtitle, fact labels and values, and detail-panel
   label and value all render at normal body size. Color may still distinguish
   state; font size may not.
2. Reduce vertical whitespace throughout the body: compact the space between the
   Team line, subtitle, fact row, and detail panel, and reduce the body bottom,
   fact-cell, and detail-panel padding proportionally. The three cards share one
   spacing vocabulary rather than carrying separate constants.
3. Keep wording, field order, literal dynamic text, colors, icons, causes, and
   route behavior unchanged. The cause-neutral Card 1.0 `route ended` notification
   and Collaboration Space cards are not part of this correction.
4. Acceptance is structural and visual: card payload tests assert no
   `heading-*` text outside the header and the compact shared spacing values; a
   rendered preview confirms the cards no longer present the Team name as a
   second title or leave the original large vertical gaps.

After reviewing the first compact previews, the operator refined that correction:

- "team name 还是再大一点吧": the Team name is one modest display step
  above body copy, while all other body text remains normal size.
- "间距还能继续缩小吗？给他缩到0 ，或者不传间距。靠行高撑起来就够了":
  explicit vertical margins, vertical spacing, and top/bottom padding are zero
  or omitted. Text line height supplies the vertical rhythm; only horizontal
  padding remains.

The zero-spacing preview showed that line height alone collapsed the four body
groups into one visual stack. The operator therefore superseded only that
spacing choice: "完全堆在一起了。还是恢复吧". Restore the preceding compact
8px group rhythm while keeping the larger Team name. The operator also required
the Team-dissolution header to use the same orange family as its body rather
than grey: "解散的这个标题颜色给我换成和底下颜色差不多的色系，不要搞成
灰色的".
