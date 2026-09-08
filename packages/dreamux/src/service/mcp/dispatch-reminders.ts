/**
 * The reminders Core attaches to a successful hand-off.
 *
 * Each one states the consequence the caller cannot see in what it just read:
 * the call answered with a receipt, and the work's own result arrives later, as
 * a separate message, from something this call never waited for. A model
 * holding only the receipt otherwise reports or predicts an outcome nobody has
 * yet, or polls a read tool until one appears.
 *
 * The wording matches Claude Code's own phrasing for its dispatch results,
 * including its "do not edit the files it is working on" sentence.
 *
 * They are not read on every engine. Claude Code drops an MCP result's
 * `content` text when `structuredContent` is present, and every hand-off tool
 * here publishes an output schema, so on that engine the tool description's own
 * receipt sentence is the only carrier of this fact.
 *
 * They live with the delegate infrastructure rather than in a transport module
 * because it is the delegate — the layer that knows an operation was a
 * hand-off — that decides whether one applies.
 */

export const TEAM_DISPATCH_SUCCESS_REMINDER =
  'Submitted. The Team is working; Dreamux will notify you automatically when its TeamLeader finishes, whether it completed, failed, or was stopped. You know nothing about its result until that notification arrives, so do not report or predict it; continue other work or answer the user in the meantime. Do not edit the files it is working on.';

export const TEAMMATE_DISPATCH_SUCCESS_REMINDER =
  'Submitted. The TeamMate is working; Dreamux will notify you automatically when it finishes, whether it completed, failed, or was stopped. You know nothing about its result until that notification arrives, so do not report or predict it; continue other work or answer the user in the meantime. Do not edit the files it is working on.';

export const WORKFLOW_RUN_SUCCESS_REMINDER =
  'Submitted. The workflow is running; Dreamux will notify you automatically when it finishes, whether it completed, failed, or was stopped. You know nothing about its result until that notification arrives, so do not report or predict it; continue other work or answer the user in the meantime. Do not edit the files its agents are working on.';
