/**
 * What `team.create` does with the identity it is handed.
 *
 * A channel that provisions a Team composes one string — the operator's
 * configured identity and the address the Team must reply to — and hands it to
 * `team.create` like any other caller. Core stores a string: this covers that
 * the whole composed text reaches both durable records intact, because the
 * leader's prompt is read back from them long after the creating message is
 * gone.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { teamCreatePayloadHash } from '../src/service/team-collection/create-request.js';

import {
  buildTeamCollectionHarness,
  type TeamCollectionHarness,
} from './helpers/team-harness.js';

let harness: TeamCollectionHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

const CONFIGURED = 'You are the release captain for this Team.';
const GUIDANCE = [
  'Reply in this Feishu conversation with the channel reply tool:',
  '- chat_id: oc_example',
  '- message_id: om_initial_message (the message that initially triggered Team creation)',
  'Never omit message_id.',
].join('\n');
const COMPOSED = `${CONFIGURED}\n\n${GUIDANCE}`;

describe('the identity a Team is created with', () => {
  it('stores the whole composed string in the Team record and the leader identity', async () => {
    harness = await buildTeamCollectionHarness();

    const created = await harness.collection.createFromRequest({
      requestId: 'req-composed-identity',
      payloadHash: teamCreatePayloadHash({ identity: COMPOSED }),
      options: {
        namePrefix: 'space',
        leaderAgentRuntime: 'fake',
        intent: 'reply in the chat this Team was created from',
        identity: COMPOSED,
      },
    });

    // The record a restart reads the leader back from.
    const record = await harness.seedStore.get(created.team_name);
    expect(record?.leader_identity_prompt).toBe(COMPOSED);

    // The leader's own identity file, which is what its prompt is built from.
    // It sits at the Team root beside the record.
    const identityFile = join(
      harness.teamCollectionRoot,
      created.team_name,
      'identity.json',
    );
    const stored = JSON.parse(await readFile(identityFile, 'utf8')) as {
      identity_prompt: string;
    };
    expect(stored.identity_prompt).toBe(COMPOSED);
  });
});
