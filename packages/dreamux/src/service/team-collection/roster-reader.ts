/**
 * One Team's contained-Agent summary, read from the authoritative stores.
 *
 * The Team aggregate is republished on every durable record transition,
 * including transitions driven by recovery and dissolve on a Team nothing in
 * this process has materialized. Such a Team still has a leader and members on
 * disk, so the aggregate is read from the identity stores that own them rather
 * than reported as empty — in this event an empty array states that the Team
 * has no Agents, and there is no value for "unknown".
 *
 * The Team record decides who the leader is. An identity file at the Team root
 * is only this Team's TeamLeader while it is aligned with that record, which is
 * the same rule materialization applies before it restores a leader; a
 * misaligned one is an orphan that the next materialization replaces from the
 * record. So this read produces exactly the roster a materialized Team would
 * have seeded from the same directory.
 *
 * This is a read and nothing else: it materializes no Team, starts no runtime,
 * and writes nothing. A failed read yields `null`, and its caller publishes no
 * aggregate at all.
 */
import type {
  DreamuxLogger,
  TeamStateTeammateSummary,
} from '@excitedjs/dreamux-types';

import { errorInfo } from '../../platform/error-info.js';
import { teamMateCollectionDir } from '../../platform/paths.js';
import {
  AgentEntityCollectionStore,
  AgentIdentityStore,
} from '../agent-entity/identity-store.js';
import { alignedWithLeader } from '../team-service/leader-agent.js';
import type { TeamRecord } from './types.js';

export async function readTeamRoster(input: {
  /** This Team's own root directory, already resolved by its store. */
  teamRoot: string;
  /** The authority for this Team's identity, including its leader's name. */
  record: TeamRecord;
  log: DreamuxLogger;
}): Promise<readonly TeamStateTeammateSummary[] | null> {
  const record = input.record;
  try {
    const roster: TeamStateTeammateSummary[] = [];
    // Read under the stored name rather than the expected one: a name that
    // disagrees with the record has to be observable here to be left out, and
    // reading it as a mismatch would fail the whole roster instead.
    const leader = await new AgentIdentityStore({
      dir: input.teamRoot,
      dispatcherId: record.dispatcher_id,
      expectedName: null,
      log: input.log,
    }).read();
    // Omitted rather than published as something else: `teammates` states the
    // Agents this Team currently contains, and an unaligned identity is not
    // one of them. The Team's designated leader stays visible in the event's
    // own `leader_name`, which is read from this record.
    if (leader !== null && alignedWithLeader(leader, record)) {
      roster.push({
        teammate_name: leader.name,
        role: 'team_leader',
        status: leader.status,
      });
    }
    const members = await new AgentEntityCollectionStore({
      root: teamMateCollectionDir(input.teamRoot),
      dispatcherId: record.dispatcher_id,
      log: input.log,
    }).list();
    for (const member of members) {
      roster.push({
        teammate_name: member.name,
        role: 'teammate',
        status: member.status,
      });
    }
    return roster;
  } catch (error) {
    input.log.warn(
      {
        dispatcher_id: record.dispatcher_id,
        team_id: record.team_id,
        err: errorInfo(error),
      },
      'could not read the Team roster; skipping the Team aggregate event',
    );
    return null;
  }
}
