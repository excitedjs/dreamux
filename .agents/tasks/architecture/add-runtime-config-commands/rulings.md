# Operator rulings

The rulings ledger for this multi-stage refactor. Every operator ruling is
recorded here in the turn it is given, with the operator's words verbatim and
the object it applies to. Later rulings supersede earlier ones where they
conflict; the superseded ones are named. TeamLeader inferences are labeled and
are not rulings until confirmed.

- Confirmed operator decisions (2026-09-17):
  - Record this as its own task, separate from the Dispatcher Command task.
  - Entry, asked "谁、从哪里触发配置修改？": "只暴露给Channel。现在会有web端通过
    Channel 修改配置的需求，如果不能只暴露给 Channel，还必须暴露给 CLI 的话，那也可以。
    以代码量最小的方式来做"
  - Scope, asked "第一版要能改 config.json 的哪些部分？": "整个文件都能改" — the
    offered option included adding and removing `agents`, `dispatchers`, and
    `channels`, and Feishu `app_id` / `app_secret`.
  - "立即生效", asked with A (write, then restart the whole daemon) against B
    (apply in process; restart only an affected Dispatcher, reversing the
    #350 decision that single-Dispatcher restart is not a product
    capability): "B 进程内热更新".
  - Authorization: "由 Channel 自己鉴权" — Core adds no caller identity or
    permission check.
  - Reading: "读取这个机制,密钥就不返回.调用方表现为input 是空的，但是可以写入".
  - The Channel serving the web front end: "不在，只做 Core Command".
  - Write contract: "整份写回，空=保留原值" — a write carries the whole
    configuration; an empty secret keeps the stored value, a non-empty one
    replaces it.
  - A changed `agents[]` entry: "下次拉起时生效" — running runtimes are not
    restarted.
  - Fields that apply only when a Dispatcher starts (asked with Feishu
    credentials, the Dispatcher's own runtime and cwd, and `enabled` as
    examples): "不自动重启。重启这个东西应该做一个新的command。不在本期需求范围内"
  - Removing an `agents[]` id still used by an existing entity: "允许写入".
  - Adding a Dispatcher, asked whether `dispatcher.start` should reach it at
    once: "不要，等进程重启".
  - Removing a running Dispatcher, answered with a design direction: "这个场景有点
    多呀,我觉得可以系统性地解决一下这个问题.有些配置如果必须重启才能生效，那就让它始终只从
    内存中读值。然后改配置就只去改文件，就可以实现重启后生效了。有些需要立即生效的情况，我感觉你
    需要类似 TeamMate 的 Identity 机制。修改内存值之后，异步去落盘。我有点忘记了，但最开始确实
    是希望设计成这样。"
  - Listing the changes that wait for a restart: "这个也系统性地解决一下吧：Config 有一个
    专门的 Config Service 吧。。是不是就比较好解决这个问题了"
  - Persistence failure: "短期也不要考虑什么落盘失败之类的了。落盘失败了就写日志，到时候再
    排查。"
  - Code check on the cited model: the agent identity store
    (`packages/dreamux/src/service/agent-entity/runtime-state.ts`) serializes
    mutations and writes the identity file durably before it replaces the
    in-memory snapshot; each update resolves only after the write. The
    direction above asks for the in-memory value first and an asynchronous
    write, which is the reverse order.
  - Field classification, asked with a finer per-field split: "简单区分，agents
    全都立即生效，dispathcers 全都重启生效。"
  - Listing the changes that wait for a restart: "列出".
  - Hand edits while the daemon runs: "运行中以 Config Service 为准" — the
    offered option said a hand edit is not read, the next write overwrites it,
    and the maintenance skill says to use the Commands while running and to
    stop the daemon before editing by hand.
  - Storage infrastructure, raised after the requirement above converged:
    "那我感觉这里可以来一波大重构，单独拆分出一套存储基建来，一个是事务性存储，就是现在
    team identity 这种的，先确保落盘，再改内存值的，一个是易失性存储，就是先改内存值，
    然后再落盘的。" The solution-path card sent before this message was
    dismissed in favor of discussion.
  - Sequencing: "先把需求1 做了。需求1 改动看起来比较可控。然后需求2 你先记录到 task
    记录里，1 合入后我们再推进2".
- Confirmed operator decision (2026-09-19), after the TeamLeader recommended
  splitting the storage infrastructure into its own prerequisite task:
  "不拆了，不管怎么样都会是顺着做。" — the storage infrastructure refactor
  belongs to this task, and the work runs in order: the infrastructure first,
  then the Config Service on top of it.
- Confirmed operator decision (2026-09-19), on a card after the store
  inventory above was played back. Asked "③ 那四个每次读文件的存储（Team 记录、
  cron、access.json、chat-bots.json），这次也改成内存为准，迁到事务性存储吗？", the
  operator chose "一起迁（推荐）". The option said: afterwards only the
  transactional and volatile kinds remain, and the `chat-bots.json`
  overwrite race goes with it; the costs are a larger change, the Team
  record's guarantee against resurrecting a dissolved Team moving from a
  merge against disk to a single in-memory owner, and a file damaged or
  deleted by hand while the daemon runs no longer failing loud but being
  overwritten by the next write. The rejected option moved only the stores
  that already hold authoritative memory.
  - Consequence recorded by the TeamLeader, not a ruling: the Feishu routing
    store moves under either option, so the store infrastructure lives in
    `@excitedjs/dreamux-utils`.
  - Product catalog entry this touches: "The Team record is the only
    existence fact" (Team lifecycle). While the daemon runs, a Team record
    deleted or damaged by hand no longer frees the name before a restart.
- Operator, 2026-09-19, after the card above: "config service 重新想想。我觉得
  我那天想错了" — the Config Service requirement is reopened; which part is
  being reconsidered is not yet known.
- Operator, 2026-09-19, answering the TeamLeader's two Config Service
  problems (a volatile `agents` store loses a change silently when the write
  fails; "`agents` now, `dispatchers` after restart" keeps two copies of the
  configuration): "你说的很精准，就是这两个问题。agents 其实根本没必要搞成易失性的，
  就用那个事务性基建就够了。" On the second: "2 这个点其实我还没有想好，因为运行时
  去改这些配置，其实很危险，很有可能直接给系统搞得不可用了".
  - Inference, not yet confirmed: with every existing store and `agents`
    transactional, the volatile kind has no user and is not built.
- Confirmed operator decision (2026-09-19), in conversation after the
  failure trace above was played back with three directions — A: the
  Commands change only `agents`, and `dispatchers` stays a hand edit with
  the daemon stopped (this overturns "整个文件都能改"; memory always equals
  the file, so no change waits for a restart and the pending-restart list
  goes away); B: the whole file is writable and a write first runs every
  check the next start would run, marking what cannot be checked
  (credentials) as known only after a restart; C: B plus refusing a write
  that removes, disables, or changes the Channels of the caller's own
  Dispatcher. The TeamLeader recommended A. The operator: "那就 A 吧。问题就只有
  这个玩意比较割裂，一个配置文件只有一部分可以改。"
- Confirmed operator decisions (2026-09-19), on one card after A was played
  back — A narrows "整个文件都能改" to `agents`, retires the pending-restart
  list, keeps "运行中以 Config Service 为准", and reuses the `dreamux config
  show` secret rule:
  - Asked "Config Command 对外暴露什么？": "只管 agents（推荐）" — the option
    said read and write both carry only `agents`, and `dispatchers` is not
    exposed through a Command and changes only by hand in `config.json`. The
    rejected option read the whole file and wrote only `agents`. Moving
    `agents` into a file of its own was raised in the card text and advised
    against, because it changes the config file format.
  - Asked "现在所有存储和 agents 都用事务性存储，易失性存储已经没有使用方了。这次就
    不做了，对吗？": "不做（推荐）" — the storage infrastructure has the
    transactional kind only.
- Superseded by the 2026-09-19 decisions: "整个文件都能改", "列出", the
  asynchronous write and "落盘失败了就写日志" (a failed write now fails the
  Command), "不要，等进程重启" and "不自动重启…" (nothing written waits for a
  restart). "由 Channel 自己鉴权", the secret rule, "整份写回，空=保留原值"
  (now the whole `agents` section), "下次拉起时生效", and "运行中以 Config
  Service 为准" still hold. "允许写入" for ids used by entities is narrowed by
  a pending proposal under Desired behavior.
- Interpretations recorded without objection when they were played back on the
  2026-09-17 card:
  - The caller is a web front end reaching Core through a Channel's Core port.
  - The Commands are also reachable over `admin.sock`; no CLI verb is added.
- Confirmed operator decisions (2026-09-19), on the playback card of the
  rewritten requirement:
  - Asked "写入时是否按「下次启动会不会拒」来校验？" with the option "按下次启动的
    规则校验（推荐）" (a write the next start would reject is rejected; removing
    an `agents` id a Dispatcher's `agentRuntime` names is refused, narrowing
    the 2026-09-17 "允许写入" to ids only Teams or TeamMates use): "从产品形态上
    来说，我肯定希望 A，但是我感觉 A 要做到的话，可能要写一堆的代码。" The TeamLeader
    answered the cost concern with evidence — every check the next start makes
    on `config.json` lives in the loader's post-read path (parse, load the
    referenced providers, validate each section, including the `agentRuntime`
    reference), so write-time validation feeds the candidate through that
    path; the other start checks (Dispatcher `cwd`, legacy state) read nothing
    this Command can change — and recorded the option he prefers on product
    grounds. It is re-confirmed at the development-approval playback.
  - Asked how to handle an agent whose provider the process has not loaded:
    "写入时当场加载（推荐）" — loaded through the start's loader as part of
    validation; a provider that fails to load rejects the write.
  - Asked how the technical solution is produced: "三份独立方案（推荐）" — three
    independent proposals and a cross-review, merged by the TeamLeader, then
    reviewed by Devbox on a GitHub Issue.
- Confirmed operator decisions (2026-09-20), on a card after the three
  proposals and their cross-review were adjudicated (the TeamLeader's
  technical calls were listed in the card text):
  - Asked "没在运行的成员的 identity，和已经结束的 Workflow 记录，要不要一直留在
    内存里？（Team 记录按「一起迁」的裁定常驻，不在这题里。）": "只在有 owner 时留
    （推荐）" — the option said a live member's identity and a running
    Workflow's record are held in memory and authoritative; once the owner
    ends they are released and read from their file when next used, so a
    hand edit to a stopped member's or finished run's file made while the
    daemon runs is read. The rejected option kept every loaded record until
    the process exits, with unbounded memory. The card text also stated that
    reads of a live entity go through its live owner under either answer.
  - Asked "「先确保落盘」要不要包含 fsync，也就是断电也不丢？": "不加，维持现状
    （推荐）" — written first means a temporary file and an atomic rename, as
    the identity store the operator named does today; a process crash loses
    nothing, a power loss may lose the last write.
