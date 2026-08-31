/**
 * The scheduler's one definition of a valid cron schedule.
 *
 * A schedule reaches Dreamux twice: once when a caller asks for it, and again
 * when the store reloads it from disk. Those are the same rules — five fields,
 * a timezone the platform knows, a pattern the library can parse, at least one
 * future run, and a recurring gap no tighter than a minute — but they are not
 * the same kind of failure. A caller who sends a bad pattern made a mistake and
 * can fix it; a bad pattern already on disk is corrupt state and needs an
 * operator. So the rules live here once and the classification is the
 * parameter: each caller passes the `fail` that raises its own error type.
 *
 * The checks were previously written out twice, and the copies had already
 * drifted — the reload path checked the minimum interval, the command path did
 * so in a separate function, and the two reported an unknown timezone in
 * different words. One owner is what keeps them honest.
 */
import { Cron } from 'croner';

/** The tightest gap allowed between two runs of a recurring job. */
export const MIN_CRON_INTERVAL_MS = 60_000;

/**
 * Raise this context's error for a broken rule. It never returns, so the
 * validator can treat every check as terminal.
 */
export type CronRuleFailure = (message: string) => never;

/** Build a croner instance for a pattern that has not been validated yet. */
function parseCron(pattern: string, tz: string, fail: CronRuleFailure): Cron {
  try {
    return new Cron(pattern, { timezone: tz, mode: '5-part', paused: true });
  } catch {
    // The library's wording is its own vocabulary. A reader told about a parser
    // they never chose learns nothing about the field they actually sent.
    fail(`cron '${pattern}' is not a valid 5-field expression`);
  }
}

function assertKnownTimeZone(tz: string, fail: CronRuleFailure): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
  } catch (error) {
    // `Intl` reports an unknown zone as a `RangeError` and nothing else here
    // does, so that one type is the rule signal; any other failure is the
    // platform's, not the schedule's, and must not be reported as a bad rule.
    if (!(error instanceof RangeError)) throw error;
    fail(`invalid timezone '${tz}'`);
  }
}

/**
 * Check one schedule against every cron rule, reporting a break through `fail`.
 *
 * `recurring` selects the minimum-interval rule: a one-shot job has no second
 * run to be too close to.
 */
export function validateCronSchedule(
  schedule: { cron: string; tz: string; recurring: boolean },
  fail: CronRuleFailure,
): void {
  if (schedule.cron.trim().split(/\s+/).length !== 5) {
    fail('cron must be a standard 5-field expression');
  }
  assertKnownTimeZone(schedule.tz, fail);
  const cron = parseCron(schedule.cron, schedule.tz, fail);
  if (cron.nextRun(new Date()) === null) {
    fail('cron has no future run');
  }
  if (!schedule.recurring) return;
  const runs = cron.nextRuns(2, new Date());
  // Fewer than two remaining runs cannot violate a gap rule.
  if (runs.length < 2) return;
  if (runs[1]!.getTime() - runs[0]!.getTime() < MIN_CRON_INTERVAL_MS) {
    fail('cron interval must be at least one minute');
  }
}
