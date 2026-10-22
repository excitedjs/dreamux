# Requirement

## Operator request

The operator requested the following behavior on 2026-10-22 (original wording):

> 首先cot 输出这里只给 reasoning 改成 chunk 更新，从 provider 这一层直接往外抛 reasoning 事件。然后飞书COT渲染的时候，前面加一个Thinking...，cot 更新按照 500ms 节流。
> 另外给feishu channel 配置加一个 cot 配置，默认关 reasoning 上屏，可以手动打开。
> 然后 teammate 通过send 发送给 teamleader 的消息，现在会在 cot 上屏，看起来很难受，最好改成 TEAMMATE MESSAGE FROM xxxx

Earlier native-event probes established that this client displays native reasoning much like ordinary text. The operator requires native reasoning events; a text-message imitation is outside scope.

A subsequent operator ruling narrows the processing requirement:

> chunk 先不脱敏了，麻烦

This exempts only `assistant.reasoning` append fragments from redaction. It does not change ordinary assistant text, tool payload, input, or terminal-reason redaction.

## Desired behavior

1. Only reasoning becomes incremental. Codex and Claude Code providers publish explicit neutral reasoning activity while native chunks arrive. Ordinary assistant text retains completed-block behavior.
2. Feishu renders enabled reasoning through native reasoning events, with `Thinking...` preceding each visible block. The channel coalesces adjacent increments and starts COT append requests no more often than once per 500 milliseconds per presentation. The first append may run immediately; trailing content and terminal events respect the same cadence.
3. Optional channel configuration `cot.reasoning` defaults to false. Explicit true enables reasoning display; false hides reasoning and its prefix while other COT content continues normally. This configuration does not suppress the providers' native facts.
4. A member's explicit `send` to its TeamLeader displays `TEAMMATE MESSAGE FROM <sender>` in that leader's COT, using the authenticated member identity. The model still receives the complete original message. Existing completion callback labels and other send directions retain their behavior.

The field spelling, per-presentation cadence, and per-block prefix are implementation choices within the stated request, not additional operator quotations.

## Invariants and non-goals

- Core forwards reasoning append fragments unchanged, as explicitly requested. Existing redaction for other activity remains in force.
- Use native identities and explicit native part positions; do not concatenate invented provider IDs. Never display signatures or encrypted reasoning.
- Keep live activity separate from cold activity records. No transcript backfill, persisted streaming state, provider pacing, assistant-text streaming, config auto-enablement, or deployment is included.
- Keep existing anchor replacement, ordering, bounded outbox, and terminal behavior. A replacement card starts with newly arriving content; it does not replay the prior card.

## Acceptance

- Incremental provider activity arrives before completion; completed snapshots do not duplicate emitted parts. Parts without deltas retain their completed content.
- Native multi-part identities, interrupted/abandoned streams, subagent filtering, and ordinary text behavior are covered.
- Projection tests preserve raw reasoning fragments and keep ordinary text/tool redaction unchanged.
- Fake-clock channel tests assert actual request cadence, adjacent coalescing, interleaved text/tools, final flush, anchor replacement, and close/drain behavior.
- Old config, omitted/empty cot, false, true, and wrong types have explicit tests. Member-send display tests preserve model content and callback behavior.
- Build, lint, test, and test typechecking pass. Live metadata-only probes identify the actual delta and snapshot behavior without exposing reasoning content.
