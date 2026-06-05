# Codex Turns In Dreamux

## What A Turn Is

A turn is one model round opened by user input and kept alive until the model
stops requesting tools. While a turn is active, additional input can be folded
into that same turn and processed at the next model step.

## Start Versus Steer

- `turn/start` is aggregate behavior: it starts a fresh turn when idle and can
  fold input into the currently active turn when busy.
- `turn/steer` targets an active turn and should fail when no active turn
  exists or the expected turn id does not match.

Operational rule: when you need deterministic injection, identify whether a
turn is active before choosing start or steer behavior.

## Why Steering Is Not Instant

Tool calls return control only at yield boundaries. If the active turn is
waiting inside a long-running command or poll, injected input is usually not
processed until that tool call yields and the model samples again.

## Background Work Does Not Wake An Idle Model

A background command completing is an event for the host, not new user input.
If the dispatcher starts background work and ends the turn without polling,
the model may not observe completion until another user input starts a turn.

## Compaction Can Repeat Replies

Long conversations can compact mid-turn. After compaction, the model may
re-sample and repeat a prior response. Diagnose this by checking whether there
was one inbound user message and a compaction marker between repeated assistant
messages. Do not infer duplicate external delivery from repeated text alone.

## Head-Of-Line Blocking

Modern Dreamux dispatcher inbound should submit accepted messages without
waiting for the previous turn to complete. If a later message waits behind a
long turn, check whether the running version still uses a serial turn
submission path or whether another gate rejected the later message.

## App-Server Readiness

Before business RPCs, the Codex app-server connection must complete the
initialize handshake. A daemon that exits before binding its socket, fails the
handshake, or cannot read workspace-local skills should be treated as a
startup readiness failure, not as a chat delivery bug.
