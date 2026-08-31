/**
 * The provenance names Core's own submission producers use.
 *
 * This is not a Core enum of source meanings, and nothing validates or branches
 * against it: the renderer never imports this file and renders whatever name it
 * is handed. Sources are open, and a Channel that invents a new inbound form
 * names itself without a change here.
 *
 * What lives here is the other half of that rule — Core has producers too, and
 * they are the owners of their own names. Collecting the five in one place is
 * how two call sites of the same producer family (the Dispatcher scheduler and
 * a Team's scheduler; a routed inbound turn and an explicit `team.submit`)
 * stay spelled identically, which is what a model reading provenance and a
 * Channel filtering on `turn_source` both depend on.
 */

/**
 * Every turn Core accepted from a Channel: a routed inbound message and an
 * explicit `team.submit`, whether the Command arrived over a Channel adapter or
 * `admin.sock`. Core does not name the concrete Channel — which product it was
 * is the Channel's own business, and the model reads the attributes for it.
 */
export const CHANNEL_SOURCE = 'channel';

/** A due cron fire, from the Dispatcher's scheduler or a Team's. */
export const SCHEDULED_SOURCE = 'cron';

/**
 * Work an Agent handed to another Agent: an MCP spawn or submit, a Team's
 * creation prompt, and a Workflow step.
 */
export const AGENT_TASK_SOURCE = 'task';

/** A finished task reported back to the Agent that is waiting for it. */
export const COMPLETION_SOURCE = 'task-notification';

/**
 * Reserved for Core-owned notices to an Agent — today, the Dispatcher restart
 * notice alone.
 *
 * The reservation is structural rather than enforced: no caller-facing surface
 * carries a source at all, so no external payload can select this name and a
 * runtime check would guard a path that does not exist.
 */
export const SYSTEM_SOURCE = 'system';
