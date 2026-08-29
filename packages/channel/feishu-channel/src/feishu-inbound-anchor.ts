/**
 * How a visible Feishu message finds the exact turn it became.
 *
 * Core carries no presentation origin, so the correlation is made here, and it
 * rests on one fact: Core publishes `teammate.turn.submitted` synchronously
 * while `team.submit` is still running, and `invoke` is an in-process call. So
 * by the time a submitted result hands this session a `turn_id`, the matching
 * event has already been recorded below.
 *
 * The join key is that `turn_id` and nothing else. Several Channel sessions
 * may submit to the same recipient at the same time, and every one of them
 * observes every submitted event; only the session whose own Command returned
 * a given `turn_id` can claim it, so an anchor can never land on another
 * session's turn. Recipient identity is read from the claimed event rather
 * than reconstructed, which is why the event is kept rather than a flag.
 */
import type { TeammateTurnSubmittedEvent } from '@excitedjs/dreamux-types';

/**
 * How many submissions may await a claim.
 *
 * A claim follows its own submission by one Command return, so the live set is
 * the number of turns being submitted at this instant across the whole
 * dispatcher. The bound exists only so an event stream nobody claims from — a
 * session that submits nothing — cannot grow without limit.
 */
const FEISHU_SUBMITTED_TURNS_MAX = 256;

export class FeishuSubmittedTurns {
  private readonly turns = new Map<string, TeammateTurnSubmittedEvent>();

  /** Every submitted turn, regardless of who submitted it or how. */
  record(event: TeammateTurnSubmittedEvent): void {
    if (typeof event.turn_id !== 'string' || event.turn_id === '') return;
    this.turns.delete(event.turn_id);
    if (this.turns.size >= FEISHU_SUBMITTED_TURNS_MAX) {
      const oldest = this.turns.keys().next();
      if (!oldest.done) this.turns.delete(oldest.value);
    }
    this.turns.set(event.turn_id, event);
  }

  /** The proof: this `turn_id` came from this session's own submit result. */
  claim(turnId: string): TeammateTurnSubmittedEvent | null {
    const event = this.turns.get(turnId);
    if (event === undefined) return null;
    this.turns.delete(turnId);
    return event;
  }

  clear(): void {
    this.turns.clear();
  }
}
