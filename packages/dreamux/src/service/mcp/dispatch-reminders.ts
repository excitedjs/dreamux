/**
 * The reminders Core attaches to a successful hand-off.
 *
 * They exist because the three dispatch tools all have the same failure mode in
 * a model's hands: the work was accepted, the answer comes back later as a
 * pushed completion, and a model that does not know that polls a read tool in a
 * loop. The sentence is what stops the loop.
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
