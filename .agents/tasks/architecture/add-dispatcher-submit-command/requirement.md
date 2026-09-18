# Requirement

## Initial request

Operator, 2026-09-17, after asking whether the Command layer can submit
directly to a Dispatcher:

> 我不打算加 cli，只给 channel 暴露一个 dispatcher.submit 就行了。如果现在
> Channel 发现没有绑定，或者团队已经解散的情况下，如果是 Channel 自己去换成
> Team.submit 不带 Team Name 进行重投的话，就给它改成调用 Dispatcher.submit。

## Current alignment

- Status: Converged; every blocking unknown below is decided.
- Confirmed current behavior and evidence:
  - The Core Command catalog has no `dispatcher.submit` and no
    `dispatcher.interrupt`. The Dispatcher Agent is reached through
    `team.submit` and `team.interrupt` with `team_name` omitted
    (`packages/dreamux/src/service/team-collection/commands.ts`), executing
    `DispatcherService.submitToAgent` under the `channel` provenance and
    `DispatcherService.interrupt(null)`. The addressing was settled in the
    Minimize Core Provider Boundaries task: "A Channel supplies `team_name` for
    TeamLeader delivery and omits it for the existing unmatched-input path to
    the Dispatcher Agent."
  - The target Dispatcher is the caller context's `dispatcher_id`, never a
    payload field. A Channel session's port binds its own dispatcher
    (`packages/dreamux/src/channel/core-port.ts`); `admin.sock` lifts it from
    the request and rejects a missing id with `BAD_REQUEST`.
  - The registry has no per-adapter exposure: every registered Command is
    callable through every adapter, including `admin.sock`
    (`packages/dreamux/src/command/registry.ts`).
  - The Feishu Channel reaches the Dispatcher Agent through one method,
    `FeishuChannel.submit(null, …)`, which invokes `team.submit` without
    `team_name`. It has four callers:
    1. a chat message whose routing plan is `dispatcher` — no binding and no
       Collaboration Space claims the conversation;
    2. the fallback after a bound Team rejected the delivery with
       `TEAM_NOT_FOUND` or `TEAM_CLOSED`;
    3. the fallback after Collaboration Space automatic provisioning did not
       deliver to its Team;
    4. a document-comment cold open: a trusted commenter mentions the bot in
       a document no subscription follows.
  - Call site 3 is only a failure branch. The normal path of a Collaboration
    Space topic provisions a Team in place (`team.create` → route bind →
    announce → `team.submit` to the new leader) and never reaches the
    Dispatcher. Every exit before that final `team.submit` answers
    `unsubmitted`, and `FeishuChannel.deliver` then submits to the Dispatcher
    Agent. The exits are: `team.create` throws (including an idempotency
    conflict when a redelivered message meets a changed space policy);
    `team.create` replays a closed Team for a redelivered message;
    `team.create` returns an empty Team name; the route bind fails; a
    concurrent message to the same topic finds that the shared run installed
    no route. A `rejected` submission to the just-provisioned Team takes the
    same fallback. The branch was introduced by #350 and is documented in
    `.agents/domains/channel.md` ("Failing to provision is not a reason to drop
    what somebody wrote").
  - Feishu `/stop` invokes `team.interrupt` without `team_name` in a
    conversation whose plan is `dispatcher`, and with the bound Team's name in
    a bound conversation (`feishu-slash-commands.ts`).
  - No other in-repository caller invokes `team.submit` or `team.interrupt`
    without `team_name`. Agent-facing Team MCP tools call `DispatcherService`
    directly, not these Commands.
- Desired outcome: The Dispatcher Agent has its own Commands — `dispatcher.submit`
  and `dispatcher.interrupt` — and the Team Commands address only Teams.
- Desired behavior:
  - `dispatcher.submit` submits one turn to the addressed Dispatcher's own
    Agent; `dispatcher.interrupt` interrupts it.
  - `team.submit` and `team.interrupt` require `team_name`; omitting it is a
    caller mistake.
  - Feishu call sites 1, 2, and 4 submit through `dispatcher.submit`; their
    recipient stays the Dispatcher Agent.
  - Feishu `/stop` in a conversation whose plan is `dispatcher` invokes
    `dispatcher.interrupt`; in a bound conversation it still invokes
    `team.interrupt` with the Team's name. What `/stop` answers is unchanged.
  - When Collaboration Space provisioning does not deliver the message to its
    Team (every exit listed under call site 3), the Channel no longer delivers
    the message to the Dispatcher Agent; it replies a failure notice in place,
    in the conversation of the triggering message.
  - The notice covers the chat inbound path only. A question-card answer
    reaches the same delivery entry point, so a card answered in a
    Collaboration Space topic with no binding also plans provisioning; when
    that run produces no recipient the answer is dropped with a log line and
    no notice, as that path already drops `failed`, `ambiguous`, and `error`.
- Scope: the Core Dispatcher and Team Command definitions, the Feishu Channel
  call sites above, their tests, the knowledge base and product catalog entries
  that describe these behaviors, and change notes.
- Non-goals:
  - No CLI entry ("我不打算加 cli").
  - No per-adapter exposure mechanism; `dispatcher.submit` is also reachable
    over `admin.sock`.
  - No change to the normal Collaboration Space provisioning path, to route
    reconciliation on a bound Team's rejection, or to document-comment
    subscription delivery.
- Constraints and invariants:
  - Addressing stays caller context: neither new Command reads `dispatcher_id`
    from its payload.
  - Changing Command contracts leaves every persisted file readable; the change
    notes are ordinary notes, not `BREAKING:`.

## Acceptance criteria

- The Core catalog registers `dispatcher.submit` and `dispatcher.interrupt`;
  invoking them through a Channel port or `admin.sock` with a configured
  `dispatcher_id` reaches that Dispatcher's own Agent.
- `team.submit` and `team.interrupt` without `team_name` are rejected as
  `BAD_REQUEST` and reach no Agent.
- No Feishu Channel source invokes `team.submit` or `team.interrupt` without
  `team_name`.
- An unbound conversation, a bound conversation whose Team is rejected, and a
  document-comment cold open still deliver the message to the Dispatcher Agent.
- `/stop` in an unbound conversation interrupts the Dispatcher Agent; in a
  bound conversation it interrupts the Team's leader.
- A Collaboration Space provisioning run that ends without delivering to its
  Team posts a failure notice under the triggering message and submits nothing
  to the Dispatcher Agent.
- Build, lint, test, and `typecheck:tests` pass.

## Decisions and unknowns

- Confirmed operator decisions (2026-09-17):
  - Record this as a new task in the `architecture` domain.
  - No CLI entry; expose `dispatcher.submit` for a Channel.
  - Call sites 1 and 2 move to `dispatcher.submit` (the initial request names
    "没有绑定" and "团队已经解散").
  - Call site 4: "4这个是要投递给Dispatcher的".
  - `admin.sock` also reaching `dispatcher.submit`: "接受".
  - Call site 3, first answer: "3，我没有预期要投递给 Dispatcher。我怀疑你看错了，
    3的行为是会在原地拉起一个新团队。" After the failure-only branch and its
    exits were laid out, the answer to "协作空间建 Team 失败时，这条消息怎么处理？"
    was "改成原地回失败提示".
  - `team.submit` `team_name` once no Channel caller omits it: "改必填".
  - `team.interrupt`, asked whether `/stop`'s Dispatcher-addressed interrupt
    changes too: "一起加 dispatcher.interrupt" — the offered option was to add
    `dispatcher.interrupt`, switch `/stop` to it, and make `team.interrupt`'s
    `team_name` required.
- Confirmed operator decision (2026-09-18), raised at TeamLeader pre-review
  after tracing that a question-card answer travels the same delivery entry
  point and so loses the Dispatcher fallback on a failed provisioning run:
  "保持现状：只记日志" — the offered option was a log line only, no in-place
  notice on that path, matching how it already drops other failures.
- Operator review of the pull request (2026-09-18), two comments:
  - On the shared base type: "这个继承名字很难理解，父类不应该包含dispatcher
    这个单词了，应该改成更中性的名字" — renamed `SubmitCommand`.
  - On `DispatcherService.interruptTeamLeader`: "这个玩意太蠢了。为什么一定要在
    dispatcherServices 里透传到 teamleader 的 teammate？" Traced and answered:
    the same pass-through shape covers every Team operation on
    `DispatcherService` (`createTeam`, `submitToTeamLeader`,
    `interruptTeamLeader`, `listTeams`, `getTeamStatus`, `getTeamHistory`,
    `dissolveTeam`, `dissolveTeamForLeader`). They exist because the Team
    Commands and the Dispatcher's Team MCP delegate hold only
    `DispatcherService` while `TeamCollection` is private, and because every
    Team operation runs inside the dispatcher admission gate — yet
    `TeamCollection` is already constructed with that gate and with the
    Dispatcher Agent as completion initiator, and TeamMates reach the same
    gate through one admitted `teammates` surface instead of per-operation
    methods. Asked whether to collapse the family in this pull request, in a
    separate task, or only for interrupt, the operator answered:
    "先改第一个命名问题然后合入吧。" The pass-through family is unchanged here;
    it is recorded as a cleanup finding, and no follow-up task has been
    created.
- Assumptions: None.
- Blocking unknowns: None. The failure notice's wording and delivery mechanism
  are solution choices, reviewed at the development-approval playback.
