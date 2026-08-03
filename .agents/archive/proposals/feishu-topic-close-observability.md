# Feishu topic-close observability

- **Status:** Implemented; current behavior is documented in
  [Channel runtime](../../reference/channel-runtime.md)
- **Date:** 2026-08-03
- **Affects:** `@excitedjs/feishu-transport`, `@excitedjs/feishu-channel`,
  `@excitedjs/dreamux`

## Intent

Add enough structured observability to locate where collaboration-target and
Team close processing stops, without inferring a Feishu topic-close signal or
changing lifecycle behavior.

Live validation established that Feishu's public event/API surface exposes no
topic-close event or readable closed status. `im.message.recalled_v1` means a
message was recalled, while code `230019` is observed only after an outbound
reply attempts to use a missing thread. Neither fact is authoritative evidence
that Dreamux received a native topic-close notification.

## Scope

0. Revert the current feature-branch implementation that changes behavior:
   remove recall- and `230019`-driven `emitFeishuTargetClosed` calls, remove the
   Feishu session's new `targetLifecycle` capability threading, and delete
   target-resolution helpers/types/modules that existed only to infer closure.
   Restore `CollaborationTargetLifecycle.acceptTargetClosedForClose` and its
   tests exactly to the `origin/next` acceptance/retry semantics, including
   removal of the new in-flight `closing` suppression and `last_error` clearing.
   Replace the transport's error-wrapping path with a log-only bounded
   projection so send/reply callers receive the exact original thrown value.
   Remove or rewrite the feature tests, reference claims, archived proposal,
   and change-file text that describe automatic Feishu topic closure.
1. Register an observability-only `im.message.recalled_v1` route in the Feishu
   bot and log a bounded projection of event id, chat id, message id, recall
   type, and recall time. The handler must not resolve a collaboration target,
   emit `target_closed`, or enter the session lifecycle task set.
2. Log provider-neutral collaboration target lifecycle ingress in Dreamux core
   with dispatcher/channel, event kind, container identity, target identity,
   and whether the event was accepted or ignored. Do not add a provider special
   case in core.
3. Log collaboration target close execution at the authoritative close path:
   immediately before Team close starts, after it completes and the target is
   persisted `closed`, and on the existing failure path. Include bounded route
   identity and Team name, not message content or provider payloads.
4. Log Team dissolve phase boundaries at the authoritative `TeamService`
   cleanup path: dissolve start, worktree cleanup start, cleanup result, and
   dissolve completion. The result log may include the existing
   `cleanup_state` and bounded `cleanup_error` only.
5. Enrich the existing Feishu reply/card failure logs with safe, structured
   upstream `code`, `msg`, and `log_id` fields. SDK/Axios error-shape parsing
   belongs to `@excitedjs/feishu-transport`; expose a bounded log projection
   that retains no raw error, response, request config, body, headers,
   credentials, or cause. The Channel must rethrow the original error unchanged
   after logging it.
6. Update the Channel runtime reference and add patch Rush change files for the
   three affected packages.

## Hard constraints

- Do not emit or infer neutral `target_closed` from a Feishu recall or outbound
  error.
- No `FeishuTopicCloseSignal`, `emitFeishuTargetClosed`,
  `observedTopicMessage`, or `recalledTopicRoot` behavior may remain. Recall
  logging uses only the normalized recall projection and never consults target
  routing state.
- Do not change collaboration target acceptance, idempotency, retry, restart
  recovery, Team dissolve, worktree cleanup, retention, or timeout semantics.
- Do not poll Feishu or attempt a write as a topic-state probe.
- Do not log raw Feishu payloads, message content, request bodies, headers,
  credentials, or unbounded provider-controlled strings.
- Preserve existing session shutdown and issue #63 non-blocking inbound
  ordering.

## Acceptance

1. Dispatching `im.message.recalled_v1` produces one bounded observability log
   and no target lifecycle event or core state mutation.
2. Malformed recall input is ignored safely; no raw payload or message content
   appears in logs.
3. Core target lifecycle logs distinguish accepted and ignored events without
   changing the existing acceptance result or asynchronous close ownership.
4. Close execution logs prove the route from target close start through Team
   close and durable target completion; existing failure behavior remains
   unchanged.
5. Team dissolve logs expose cleanup start/result and final completion, including
   cleanup state/error, without changing cleanup ordering or retention.
6. A Feishu SDK-shaped send failure logs bounded upstream code/message/log id
   while the caller receives the exact original thrown value. Unknown errors
   preserve the existing generic message/stack logging behavior.
7. Tests assert that recall and code `230019` do not emit `target_closed`, that
   core lifecycle semantics are unchanged, and that no credential/body fields
   survive the structured error projection.
8. Focused tests, full Rush build/typecheck/lint/test, `git diff --check`, and
   `.agents/scripts/check.sh` pass. The resident reviewer panel approves the
   exact final head before the PR is returned to the operator.

## Out of scope

- Automatically closing a Team when a Feishu topic is closed.
- Treating root-message recall as topic close.
- Treating `230019` as lifecycle state rather than outbound diagnostics.
- Worktree cleanup performance, close-tool timeout behavior, or retention
  policy changes.
