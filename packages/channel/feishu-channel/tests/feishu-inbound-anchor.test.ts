/**
 * COT anchor correlation is entirely local to the invoking Channel session
 * (COVERAGE CELL F; TeamLeader failure ledger item 10). There is no
 * `ChannelOrigin`, no presentation correlation token, and no separate
 * `turnOrigin` crossing Core: the whole join key is the `turn_id` a session's
 * own `team.submit` call returned, matched against the
 * `teammate.turn.submitted` event every session observes on the shared
 * event stream.
 *
 * `FeishuSubmittedTurns` is where that claim lives. These tests prove the
 * concurrent case explicitly: two sessions (i.e. two independent instances,
 * since the class is process-local per session) both observe every submitted
 * event, but each may only claim the `turn_id` its own submit produced —
 * proving a session can never cross-bind another session's anchor even when
 * both are bound to the same Team.
 */
import { describe, expect, it } from 'vitest';

import type { TeammateTurnSubmittedEvent } from '@excitedjs/dreamux-types';

import { FeishuSubmittedTurns } from '../src/feishu-inbound-anchor.js';

function submitted(turnId: string, teamName: string): TeammateTurnSubmittedEvent {
  return {
    schema_version: 1,
    occurred_at: Date.now(),
    teammate_name: `${teamName}-leader`,
    role: 'team_leader',
    team_name: teamName,
    turn_id: turnId,
    kind: 'teammate.turn.submitted',
    turn_source: 'feishu',
  };
}

describe('FeishuSubmittedTurns — single-session correlation', () => {
  it('claims exactly the recorded event for its turn_id, once', () => {
    const turns = new FeishuSubmittedTurns();
    const event = submitted('turn-a', 'team-x');
    turns.record(event);

    expect(turns.claim('turn-a')).toBe(event);
    // A second claim of the same turn_id finds nothing: the proof of
    // ownership is consumed exactly once.
    expect(turns.claim('turn-a')).toBeNull();
  });

  it('an unclaimed, never-recorded turn_id claims nothing', () => {
    const turns = new FeishuSubmittedTurns();
    expect(turns.claim('never-submitted')).toBeNull();
  });

  it('ignores a submitted event with no turn_id', () => {
    const turns = new FeishuSubmittedTurns();
    const malformed = { ...submitted('', 'team-x'), turn_id: '' };
    turns.record(malformed);
    expect(turns.claim('')).toBeNull();
  });

  it('clear() drops every unclaimed submission, as session teardown requires', () => {
    const turns = new FeishuSubmittedTurns();
    turns.record(submitted('turn-b', 'team-x'));
    turns.clear();
    expect(turns.claim('turn-b')).toBeNull();
  });

  it('is bounded: the oldest unclaimed submission is evicted once the live set is full', () => {
    const turns = new FeishuSubmittedTurns();
    const max = 256;
    for (let i = 0; i < max; i += 1) {
      turns.record(submitted(`turn-${i}`, 'team-x'));
    }
    // One more push evicts the oldest (turn-0).
    turns.record(submitted('turn-overflow', 'team-x'));
    expect(turns.claim('turn-0')).toBeNull();
    expect(turns.claim('turn-overflow')).not.toBeNull();
  });
});

describe('FeishuSubmittedTurns — concurrent sessions bound to the same Team never cross-bind', () => {
  it('each session-local instance observes every submitted event but claims only its own turn_id', () => {
    const sessionA = new FeishuSubmittedTurns();
    const sessionB = new FeishuSubmittedTurns();

    // Both sessions are subscribed to the same Core event stream, so both
    // observe both submissions — including the other session's — exactly as
    // the shared, best-effort event source delivers them to every listener.
    const eventFromA = submitted('turn-from-a', 'shared-team');
    const eventFromB = submitted('turn-from-b', 'shared-team');
    sessionA.record(eventFromA);
    sessionA.record(eventFromB);
    sessionB.record(eventFromA);
    sessionB.record(eventFromB);

    // Session A's own `team.submit` call returned `turn-from-a`; it may claim
    // that one, but never the sibling session's turn_id.
    expect(sessionA.claim('turn-from-a')).toBe(eventFromA);
    expect(sessionA.claim('turn-from-b')).toBe(eventFromB);
    // Claiming is a per-instance ledger, not a shared one: A already claimed
    // both from its own copy, and that has no effect on B's independent copy.
    expect(sessionB.claim('turn-from-b')).toBe(eventFromB);
    expect(sessionB.claim('turn-from-a')).toBe(eventFromA);
  });
});
