/**
 * When the Team-level plugin hooks fire: `beforeTeamLeaderLaunch`'s lazy
 * materialization trigger, after a failed dissolve commit.
 *
 * The sibling "creation-failure cleanup adopting a durable leader" coverage
 * that used to live here was deleted as Stage 2a Item 2 collateral (its
 * hand-rolled `TeamServiceDeps` cast omits `conversationProjection` and
 * `coreEvents`, both made required this item) — see
 * `.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md`,
 * Stage 2a Item 2.
 */
import { describe, expect, it } from 'vitest';

import { bootDissolveTeam } from './helpers/dissolve-harness.js';

describe('beforeTeamLeaderLaunch: lazy TeamLeader materialization after a failed dissolve commit', () => {
  it('rematerializes the leader once, deduped across two concurrent status() callers', async () => {
    const team = await bootDissolveTeam();
    try {
      let tapCalls = 0;
      team.service.hooks.beforeTeamLeaderLaunch.tapPromise('alpha', async () => {
        tapCalls += 1;
      });

      team.setCommitFails(true);
      await team.service.dissolve({
        requester: 'dispatcher',
        force: true,
        note: 'exercise a failed final commit',
      });
      await team.waitDissolveFailed();

      // `closeLeaderForDissolve` already nulled the leader and closed it
      // before the failed commit; the Team is left open with no live leader.
      // Read the field directly (the harness's own accessor) rather than
      // through `status()`, which would itself rematerialize the leader and
      // fire the very hook this assertion is about to count.
      expect(team.leader()).toBeNull();
      expect(tapCalls).toBe(0);

      // Two concurrent callers dedupe to one `leaderForOpenTeam` build.
      const [first, second] = await Promise.all([
        team.service.status(),
        team.service.status(),
      ]);

      expect(first.status).toBe('running');
      expect(second.status).toBe('running');
      expect(tapCalls).toBe(1);
      expect(team.leader()).not.toBeNull();
    } finally {
      await team.cleanup();
    }
  });
});
