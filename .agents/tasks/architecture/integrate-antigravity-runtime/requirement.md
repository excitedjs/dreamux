# Requirement

## Initial request

- Research whether Dreamux can integrate Google Antigravity CLI (`agy`), then
  implement the approved integration.
- The operator's current dual-transport ruling is verbatim:

  > acp 也要支持，一个 provider 里支持两种模式，通过 provide 的 config 来切换

- The default remains the operator's earlier explicit ruling:

  > 我想把两套都搬过来。tmux 和 acp 都支持，默认 tmux

- The operator's reason for requiring the native TUI path is also retained:

  > 不啊，acp 有违反用户协议的风险，我们应该用 tmux ，符合 在 tui 里使用，只是 消息输入从直接从终端输入变成了从飞书上输入

  These are product decisions and their stated rationale, not independently
  verified legal conclusions.
- Authentication ownership is explicitly outside Dreamux. The operator's current
  ruling is verbatim:

  > 不使用 Antigravity OAuth，不实现登录/账号池/轮换，默认语义是用户自己负责 agy 的登录，dreamux 只使用登录好的 agy

  Thus Dreamux does not implement or automate Antigravity OAuth itself. The user
  authenticates the native `agy` installation through its own flow, and Dreamux
  only launches and uses that already-authenticated CLI. This ruling supersedes
  the earlier draft assumption that live use would be limited to API Key/ADC.

## Current alignment

- Status: Confirmed by the operator on 2026-11-23 through the requirement
  confirmation card, including dual transports and user-managed native `agy`
  authentication.
- Confirmed current behavior and evidence:
  - Dreamux has built-in Codex and Claude Code Agent Runtime providers and a
    generic `npm:` provider loader. Core has no Antigravity or tmux branch.
    `AgentRuntimeProvider` already owns creation, exact session recovery,
    submission admission and settlement, interruption, stopping, native events,
    and bounded recent-activity reads through the neutral seam
    (`packages/dreamux-types/src/agent-runtime.ts`).
  - The current botmux source contains an Antigravity TUI adapter at
    `src/adapters/cli/antigravity.ts`. It drives `agy` through tmux or a PTY,
    confirms input through `history.jsonl`, resumes an exact native conversation
    id, and reads the native JSONL brain transcript. Its active tmux backend is
    `src/adapters/backend/tmux-pipe-backend.ts`.
  - botmux also has an explicitly selected ACP adapter and runner. It performs
    ACP v1 initialize/new/load/prompt/cancel operations, but starts a new `agy
    acp` child per turn, injects MCP through global configuration, and does not
    implement Dreamux's resident-session or full neutral-event contracts. It is
    a functional reference, not code to copy wholesale.
  - Antigravity writes a compact `transcript.jsonl` and a full
    `transcript_full.jsonl` under the native conversation's
    `.system_generated/logs/` directory. The compact log can cut long content;
    the full log is the correct source for complete assistant output.
  - botmux is MIT-licensed. Dreamux's no-synchronous-IO rule, package boundaries,
    lifecycle contracts, and per-agent tool/prompt isolation govern any port.
- Desired outcome: One Dreamux Agent Runtime provider supports two native
  Antigravity execution modes selected by that provider's own `agents[].config`:
  the native TUI through tmux, or a resident ACP v1 session. Omitted transport
  configuration selects tmux. Both modes satisfy the same neutral runtime
  contract without Antigravity-specific Core code.
- Desired behavior common to both modes:
  - A fresh start uses the launcher-supplied `cwd`, obtains the native
    conversation/session id without guessing the latest conversation, and
    durably publishes that id before the runtime becomes ready.
  - A non-null prior session id restores that exact native conversation. A bad
    or unavailable id fails loudly and never silently becomes a fresh session.
  - Submission admission distinguishes proven pre-admission failure from an
    ambiguous write. An ambiguous input is never automatically replayed.
    Concurrent submissions retain native order and settle against the actual
    native results they produce; background native work is observed without
    inventing a host submission.
  - Interrupt ends the current native turn while preserving the native session
    for the next submission. Stop synchronously fences new input, converges
    started admissions, and cleans up only native resources owned by that
    runtime.
  - Live activity and native result events come from native evidence. A final
    content-only planner step is not treated as terminal while background work
    or subagents can still wake the conversation.
  - `readRecentActivity` reads both an actively growing and a closed native
    conversation, returns a bounded page, and uses the full transcript rather
    than silently returning compact-log truncations.
  - Core-supplied role instructions, skill roots, MCP server descriptors and
    lease environment, cwd, and disabled native features are applied on fresh
    start and exact resume. One agent must not inherit another agent's MCP
    servers or role skills through mutable global Antigravity configuration.
  - Session-bound `outputSchema` is either enforced natively for every turn or
    rejected with the neutral unsupported-feature error. Prompt text must not
    pretend to guarantee structured output.
  - Missing or unusable dependencies, unsupported host platforms, and unusable
    native configuration fail through provider diagnostics/start with an
    actionable error naming the selected mode. There is no automatic transport
    or other-runtime fallback.
- Tmux mode:
  - Run one real Antigravity TUI per Dreamux agent in provider-owned tmux
    sessions. Feishu-originated and other Core submissions enter the same TUI a
    terminal user would type into.
  - Unicode, multiline text, whitespace, semicolons, paste-control characters,
    and command-looking text are delivered intentionally and exactly once;
    terminal input syntax must not change the model-facing message or execute an
    unintended TUI command.
  - Use native history/transcript/viewport evidence as needed for actual input
    admission, busy state, interruption, and terminal detection. Do not treat a
    tmux write acknowledgement as native submission.
  - Stop and restart leave unrelated tmux sessions untouched and restore the
    exact native conversation through a fresh native process resumed by its
    opaque id; v1 does not adopt a live TUI from an earlier Core generation.
- ACP mode:
  - Keep one resident `agy acp` JSON-RPC stdio session per Dreamux runtime. Do
    not copy botmux's new-process-per-turn model.
  - Negotiate ACP v1 capabilities and use native new/load/resume, prompt,
    steering where its semantics are verified, cancellation, and close.
    Native permission/client requests must not wedge unattended execution.
  - Pass Core-selected MCP servers through ACP session setup rather than botmux's
    mutable global MCP configuration file. Apply model/effort and role
    instructions through negotiated native capabilities, failing loudly when a
    required capability is absent.
  - Project native message/tool/usage/title/update events where available and
    define actual prompt-result membership for steered and queued submissions.
    Do not infer a terminal from the last assistant text.
- Scope:
  - One new provider package behind the existing external `npm:` Agent Runtime
    provider path, with provider-owned config selecting `tmux` (default) or
    `acp`.
  - Provider-owned asynchronous process/tmux/ACP, terminal-input, native event,
    transcript-reading, configuration, onboarding, and diagnostic code, plus
    focused shared-contract and transport-specific unit/live tests.
  - Authentication is user-managed. The user signs into the native `agy`
    installation before Dreamux starts it; Dreamux launches and uses the existing
    native login session without implementing or automating a login flow. The
    provider does not copy credentials or implement Antigravity OAuth, account
    pools, or account rotation. Authentication failures follow the same ordinary
    native-error/diagnostic boundary as the existing providers; Antigravity gets
    no bespoke login prompt or authentication subsystem.
  - Documentation and maintenance references required for provider-owned
    configuration and state, and the ordinary product/catalog and change-file
    updates for the new runtime capability.
- Non-goals:
  - Headless `stream-json`, one-shot `agy -p`, or a third transport.
  - Separate Antigravity provider packages/ids for tmux and ACP.
  - Antigravity OAuth onboarding, credential harvesting, account pooling, or
    rotation.
  - A generic tmux or ACP abstraction in Dreamux Core, a Channel-specific runtime
    branch, or a reusable botmux worker/daemon port.
  - A web terminal, native TUI adoption/fork UI, or feature parity with every
    botmux session-management command.
  - Automatic mid-session transport switching, fallback after ambiguous input,
    or promotion to an always-loaded builtin in this slice.
- Constraints and invariants:
  - Core stays behind `AgentRuntimeProvider`; the provider package never depends
    on `@excitedjs/dreamux` and uses asynchronous IO in package source.
  - Provider config is the only transport selector. It defaults to tmux, is
    validated once by the provider config reader, and does not create a second
    persisted transport mirror in Core.
  - The native conversation/session id remains opaque to Core and is the only
    durable provider recovery coordinate Core stores. A later configuration
    restart may select the other mode only through ordinary native exact
    resume; it must never silently start fresh.
  - Provider scratch/logs/volatile sockets use the neutral path contexts; native
    conversation recovery data remains in provider-owned durable state, not
    rebuildable cache.
  - Existing Codex, Claude Code, Channel, completion-routing, and load-bearing
    non-blocking-inbound behavior remains unchanged.
  - Live tests launch an independently authenticated native `agy` under an
    isolated test home or use deterministic fake peers. They never copy real
    credentials or private transcripts into repository fixtures and never
    automate a native login flow.

## Acceptance criteria

1. Provider config accepts exactly `tmux` and `acp`, defaults an omitted value to
   `tmux`, and rejects other values. The selected mode is visible to diagnostics;
   no failure path silently switches modes or retries input through the other.
2. For both modes, fresh start publishes a real native id and ready state;
   restart resumes that exact conversation with continuous model context. A
   missing or invalid requested id fails instead of starting fresh.
3. For both modes, rapid user messages, scheduled/news submissions, and
   background native work are not lost, duplicated, or associated with the wrong
   completion. Non-user input does not truncate an active answer or tool work;
   ambiguous admission is never automatically retried.
4. Tmux live input tests cover long UTF-8 multiline content, trailing semicolons,
   literal newlines, bracketed-paste boundaries, and terminal escape input. Core's
   ordinary XML provenance envelope already places user-authored leading slashes
   inside the body, so they are literal model text by construction; the provider
   adds no slash escaping, passthrough, or command-specific handling. The
   already-bound conversation's full transcript proves the complete `USER_INPUT`
   the TUI received; truncated global history previews are not native admission
   evidence.
5. ACP tests cover framed Unicode input, exact new/load/resume, actual negotiated
   capabilities, steered/queued prompt membership, native permission requests,
   cancellation, close, transport loss, and process cleanup.
6. For both modes, `/stop` interrupts the active native turn without destroying
   conversation continuity, reports the neutral interrupted behavior, and allows
   a subsequent submission. Confirmed interruption settles stopped and emits the
   neutral interrupt/end activities without a synthetic native result; a normal
   result racing cancellation remains normal. Runtime stop fences and converges
   admissions and leaves unrelated processes/tmux sessions untouched.
7. Assistant messages, tool calls, native failures, and terminals are projected
   from native evidence. Conversation-waking background commands and subagents
   delay final settlement until native evidence shows they can no longer continue
   the turn, including overlapping foreground activity; native non-blocking
   daemons do not hold a completed turn forever. Retryable native errors do not
   override a later successful terminal.
8. Recent-activity reads work during a turn and after close, expose complete
   full-log content within explicit decode bounds, honor the provider's page
   bounds/cursor contract, and do not start or mutate the native conversation.
   A native record containing several activities paginates by intra-record
   ordinal without duplication or loss; an oversized single record fails through
   a bounded provider/activity error instead of unbounded allocation or silent
   truncation.
9. Fresh and resumed Dispatcher/TeamLeader/TeamMate sessions in both modes
   receive only their Core-selected role instructions, skills, and MCP tools.
   MCP lease environment reaches the launched servers; an empty MCP list does
   not inherit ambient global servers. Normal stop retains the stable
   server-owned role required by agy exact resume and leaves other roles and
   shared native configuration untouched. Disabled native user-question and
   cron features cannot wedge unattended execution.
10. A requested `outputSchema` works natively on every turn including resume, or
    runtime creation fails loudly with `outputSchema` unsupported. No silent
    prompt-only emulation is used; any mode-specific limitation is explicit.
11. Diagnostics identify missing/incompatible `agy`, selected-mode tmux/ACP
    requirements, and unsupported host platforms. Native authentication errors
    require no Antigravity-specific prompt or login mechanism beyond existing
    provider parity. Clean stop and graceful restart do not leave provider-owned
    processes running and do not affect unrelated user processes. Failed partial
    start rolls back resources already created. Hard-crash containment follows
    the existing provider lifecycle; this task adds no new defensive scenario.
12. The same neutral contract suite runs against both modes with additional
    transport-specific regression coverage. Build, lint, test, and
    `typecheck:tests` pass. Any live scenario not actually run is recorded as a
    coverage limit rather than claimed green.

## Decisions and unknowns

- Confirmed operator decisions:
  - One provider supports both tmux and ACP, selected through provider config;
    the exact current ruling is quoted at the top of this record.
  - Omitted transport defaults to tmux, preserving the operator's earlier
    explicit default.
  - The user owns native `agy` authentication. Dreamux only uses an already
    authenticated CLI; it does not implement Antigravity OAuth, login, account
    pools, or rotation. The exact current ruling is quoted at the top.
  - Align the capability surface with the existing Claude Code/Codex providers
    rather than adding Antigravity-only authentication behavior:

    > 能力边界你和已有的 claude 、codex 对齐，只提示需要由用户先完成登录这个，cc 和 codex 有么？没有的话 agy 也不需要做
  - Reject architecture complexity from any designer, implementer, reviewer, or
    model unless it can be justified against existing boundaries:

    > 后面不管是谁，写代码的、Reviewer、写方案的 ，任何人跟我提到要把架构往复杂了做，你就直接跟我挑战他，问问他凭什么要这样设计
  - Do not introduce defensive scenarios absent from the current repository code:

    > 我不允许任何模型在我的仓库里引入现有代码中没有的新的防御场景。
  - On 2026-11-23 the operator approved creation of this independent task record
    through the intake card.
- Assumptions carried from the approved investigation direction:
  - Delivery begins as an external provider, not an always-loaded builtin.
  - Each mode supports only hosts where its native dependencies can run; an
    unsupported selected mode fails loudly rather than selecting the other.
- Technical unknowns for solution-stage source/live investigation, not silent
  product waivers:
  - The native configuration mechanism that can apply per-agent role
    instructions, exact MCP descriptors, role skill roots, and disabled tools in
    each mode without global cross-agent leakage.
  - The minimum reliable native transcript/viewport evidence for tmux terminal
    detection across foreground, background, subagent, error, and interruption.
  - Actual `agy acp` capability advertisement, steered-prompt response
    membership, background-turn terminals, session close, and system-prompt
    support.
  - Whether either selected mode can natively enforce session-bound structured
    output.
- Blocking product unknowns: None.
