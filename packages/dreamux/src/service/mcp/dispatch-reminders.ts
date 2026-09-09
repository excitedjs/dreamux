/**
 * The reminders Core attaches to a successful hand-off.
 *
 * Each one states the consequence the caller cannot see in what it just read:
 * the call answered with a receipt, and the work's own result arrives later, as
 * a separate message, from something this call never waited for. A model
 * holding only the receipt otherwise reports or predicts an outcome nobody has
 * yet, or polls a read tool until one appears.
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
  'Reminder: The Team task was submitted successfully. Dreamux core will automatically push the Team completion back when it finishes. Do not poll last or other read tools for completion; if you have no other work, you may end this turn naturally.';

export const TEAMMATE_DISPATCH_SUCCESS_REMINDER =
  'Reminder: The TeamMate task was submitted successfully. Dreamux core will automatically push the TeamMate completion back when it finishes. Do not poll last or other read tools for completion; if you have no other work, you may end this turn naturally.';

export const WORKFLOW_RUN_SUCCESS_REMINDER =
  'Reminder: The workflow runs in the background. When it finishes, Dreamux automatically pushes the terminal completion into the caller\'s current context. Unless the user explicitly asks for a status check, do not call or poll workflow_status or other status/read tools; wait for the system push. If there is no other work, the turn may end naturally.';
