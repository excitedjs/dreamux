/**
 * `FeishuRouting` is the Channel's sole external-route authority: which Team
 * (if any) an inbound target resolves to, and how bind/unbind/forgetTeam
 * mutate the one durable document behind it. Core holds none of this — no
 * binding store, no target resolver, no fallback rule (COVERAGE CELL F).
 *
 * These tests exercise the resolution and mutation contract directly against
 * a real `FeishuRoutingStore` backed by a temp dir, never against a mock of
 * the store, because the fallback-chain and ownership rules are meaningful
 * only in terms of what the document actually holds after a commit.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FeishuRouting } from '../src/routing/index.js';
import { FeishuRoutingStore, routingDocumentFilename } from '../src/routing/store.js';
import { spaceId as deriveSpaceId } from '../src/routing/naming.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-routing-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function makeRouting(channelId = 'chan-1'): Promise<FeishuRouting> {
  const store = new FeishuRoutingStore({
    dispatcherId: 'disp-1',
    channelId,
    stateDir: dir,
  });
  await store.load();
  return new FeishuRouting({ dispatcherId: 'disp-1', channelId, store });
}

describe('FeishuRouting — plan() resolution order', () => {
  it('an exact topic binding wins over its parent group binding', async () => {
    const routing = await makeRouting();
    const group = chatTarget('oc_group', 'group');
    const topic = topicTarget('oc_group', 'thread_1');
    await routing.bind({
      target: group,
      teamName: 'team-group',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    await routing.bind({
      target: topic,
      teamName: 'team-topic',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const plan = routing.plan(topic, 'oc_group');
    expect(plan).toEqual({
      kind: 'bound',
      teamName: 'team-topic',
      matched: topic,
    });
  });

  it('a topic with no binding of its own falls back to its parent group, one level', async () => {
    const routing = await makeRouting();
    const group = chatTarget('oc_group', 'group');
    await routing.bind({
      target: group,
      teamName: 'team-group',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const topic = topicTarget('oc_group', 'thread_9');
    const plan = routing.plan(topic, 'oc_group');
    expect(plan).toEqual({
      kind: 'bound',
      teamName: 'team-group',
      matched: group,
    });
  });

  it('a p2p direct chat is never bindable and reaches the Dispatcher for that reason', async () => {
    const routing = await makeRouting();
    const plan = routing.plan(chatTarget('oc_dm', 'p2p'), null);
    expect(plan).toEqual({ kind: 'dispatcher', reason: 'not_bindable' });
  });

  it('an unmatched bindable target with no registered space reaches the Dispatcher', async () => {
    const routing = await makeRouting();
    const plan = routing.plan(chatTarget('oc_unbound', 'group'), null);
    expect(plan).toEqual({ kind: 'dispatcher', reason: 'no_binding' });
  });

  it('an unmatched target inside a registered space provisions rather than falling to the Dispatcher', async () => {
    const routing = await makeRouting();
    const space = await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_container',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    const topic = topicTarget('oc_container', 'thread_new');
    const plan = routing.plan(topic, 'oc_container');
    expect(plan).toEqual({ kind: 'provision', space });
  });
});

describe('FeishuRouting — bind/unbind ownership', () => {
  it('binds two different targets to the same Team independently', async () => {
    const routing = await makeRouting();
    const targetA = chatTarget('oc_a', 'group');
    const targetB = chatTarget('oc_b', 'group');
    await routing.bind({
      target: targetA,
      teamName: 'shared-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    await routing.bind({
      target: targetB,
      teamName: 'shared-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const bindings = routing.listBindings();
    expect(bindings.map((row) => row.chat_id).sort()).toEqual([
      'oc_a',
      'oc_b',
    ]);
    expect(bindings.every((row) => row.team_name === 'shared-team')).toBe(
      true,
    );
  });

  it('unbinding one target leaves the Team\'s other binding live', async () => {
    const routing = await makeRouting();
    const targetA = chatTarget('oc_a', 'group');
    const targetB = chatTarget('oc_b', 'group');
    await routing.bind({
      target: targetA,
      teamName: 'shared-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    await routing.bind({
      target: targetB,
      teamName: 'shared-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const removedTeam = await routing.unbind(targetA);
    expect(removedTeam).toBe('shared-team');
    expect(routing.bindingFor(targetA)).toBeUndefined();
    expect(routing.bindingFor(targetB)?.team_name).toBe('shared-team');
  });

  it('unbinding a target nobody routes changes nothing and reports null', async () => {
    const routing = await makeRouting();
    const removed = await routing.unbind(chatTarget('oc_nobody', 'group'));
    expect(removed).toBeNull();
  });

  it('reports the previous owner when a bind moves a target to a different Team', async () => {
    const routing = await makeRouting();
    const target = chatTarget('oc_move', 'group');
    await routing.bind({
      target,
      teamName: 'team-old',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    const { previousTeamName } = await routing.bind({
      target,
      teamName: 'team-new',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    expect(previousTeamName).toBe('team-old');
    expect(routing.bindingFor(target)?.team_name).toBe('team-new');
  });

  it('requireOwner lets a Team claim a free route', async () => {
    const routing = await makeRouting();
    const target = chatTarget('oc_free', 'group');
    await routing.bind({
      target,
      teamName: 'team-self',
      display: null,
      origin: 'manual',
      spaceId: null,
      requireOwner: 'team-self',
    });
    expect(routing.bindingFor(target)?.team_name).toBe('team-self');
  });

  it('requireOwner lets a Team rebind a route it already owns (idempotent shape)', async () => {
    const routing = await makeRouting();
    const target = chatTarget('oc_own', 'group');
    await routing.bind({
      target,
      teamName: 'team-self',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    await expect(
      routing.bind({
        target,
        teamName: 'team-self',
        display: 'renamed',
        origin: 'manual',
        spaceId: null,
        requireOwner: 'team-self',
      }),
    ).resolves.toEqual({ previousTeamName: 'team-self' });
    expect(routing.bindingFor(target)?.display).toBe('renamed');
  });

  it('requireOwner refuses to move a route another Team currently holds', async () => {
    const routing = await makeRouting();
    const target = chatTarget('oc_taken', 'group');
    await routing.bind({
      target,
      teamName: 'team-a',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    await expect(
      routing.bind({
        target,
        teamName: 'team-b',
        display: null,
        origin: 'manual',
        spaceId: null,
        requireOwner: 'team-b',
      }),
    ).rejects.toThrow(/already routed to another Team/);
    // The refusal must not have mutated the document.
    expect(routing.bindingFor(target)?.team_name).toBe('team-a');
  });

  it('requireOwner refuses to unbind a route another Team currently holds', async () => {
    const routing = await makeRouting();
    const target = chatTarget('oc_taken2', 'group');
    await routing.bind({
      target,
      teamName: 'team-a',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    await expect(routing.unbind(target, 'team-b')).rejects.toThrow(
      /routed to another Team/,
    );
    expect(routing.bindingFor(target)?.team_name).toBe('team-a');
  });
});

describe('FeishuRouting — forgetTeam', () => {
  it('removes every route to a Team regardless of target kind, and reports what it removed', async () => {
    const routing = await makeRouting();
    const group = chatTarget('oc_g', 'group');
    const topic = topicTarget('oc_g', 'thread_1');
    const other = chatTarget('oc_other', 'group');
    await routing.bind({
      target: group,
      teamName: 'closing-team',
      display: 'Group display',
      origin: 'manual',
      spaceId: null,
    });
    await routing.bind({
      target: topic,
      teamName: 'closing-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    await routing.bind({
      target: other,
      teamName: 'other-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const { removed } = await routing.forgetTeam('closing-team');
    expect(removed).toHaveLength(2);
    expect(removed.map((r) => r.target.chatId).sort()).toEqual([
      'oc_g',
      'oc_g',
    ]);
    expect(routing.bindingFor(group)).toBeUndefined();
    expect(routing.bindingFor(topic)).toBeUndefined();
    // A different Team's route is untouched.
    expect(routing.bindingFor(other)?.team_name).toBe('other-team');
  });

  it('is idempotent: forgetting a Team with no rows left writes nothing new and returns empty', async () => {
    const routing = await makeRouting();
    const first = await routing.forgetTeam('never-bound-team');
    expect(first.removed).toEqual([]);
    const second = await routing.forgetTeam('never-bound-team');
    expect(second.removed).toEqual([]);
  });
});

describe('FeishuRouting — Collaboration Space policy', () => {
  it('rejects binding a space name already bound to a different container', async () => {
    const routing = await makeRouting();
    await routing.bindSpace({
      spaceName: 'dup',
      containerChatId: 'oc_first',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    await expect(
      routing.bindSpace({
        spaceName: 'dup',
        containerChatId: 'oc_second',
        display: null,
        leaderAgentRuntime: 'codex',
        identity: null,
        repo: null,
      }),
    ).rejects.toThrow(/already bound to another Feishu chat/);
  });

  /**
   * The container refusal is the whole of what keeps a Space provisioning.
   * A group row on the container answers `plan` for every topic under it —
   * a topic resolves to its parent group before `provision` is reached — so
   * without this the Space stops handing out Teams and says nothing. The
   * pair matters together: refusing the chat must not refuse a topic, because
   * a topic bind is exactly what provisioning installs.
   */
  it('refuses to bind the whole chat a space is registered on, and commits nothing', async () => {
    const routing = await makeRouting();
    await routing.bindSpace({
      spaceName: 'space',
      containerChatId: 'oc_space',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    await expect(
      routing.bind({
        target: chatTarget('oc_space', 'group'),
        teamName: 'team-a',
        display: null,
        origin: 'manual',
        spaceId: null,
      }),
    ).rejects.toThrow(/Collaboration Space/);
    expect(routing.listBindings()).toEqual([]);
    expect(routing.plan(topicTarget('oc_space', 'omt_new'), 'oc_space')).toMatchObject({
      kind: 'provision',
    });
  });

  it('still binds one topic inside a registered space, which is how provisioning installs a Team', async () => {
    const routing = await makeRouting();
    const space = await routing.bindSpace({
      spaceName: 'space',
      containerChatId: 'oc_space',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    await routing.bind({
      target: topicTarget('oc_space', 'omt_one'),
      teamName: 'team-a',
      display: null,
      origin: 'space',
      spaceId: space.space_id,
    });
    expect(routing.plan(topicTarget('oc_space', 'omt_one'), 'oc_space')).toMatchObject({
      kind: 'bound',
      teamName: 'team-a',
    });
    // The sibling topic is untouched: one provisioned topic never speaks for
    // the rest of the Space, which is what binding the chat itself would do.
    expect(routing.plan(topicTarget('oc_space', 'omt_two'), 'oc_space')).toMatchObject({
      kind: 'provision',
    });
  });

  /**
   * The same invariant from the other side. Without this, an operator could
   * reach the identical silent shadowing simply by doing the two steps in the
   * other order, and nothing would say so.
   */
  it('refuses to register a space on a chat already bound as a whole, and commits nothing', async () => {
    const routing = await makeRouting();
    await routing.bind({
      target: chatTarget('oc_space', 'group'),
      teamName: 'team-a',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    await expect(
      routing.bindSpace({
        spaceName: 'space',
        containerChatId: 'oc_space',
        display: null,
        leaderAgentRuntime: 'codex',
        identity: null,
        repo: null,
      }),
    ).rejects.toThrow(/bound as a whole to Team "team-a"/);
    expect(routing.listSpaces()).toEqual([]);
    // Unbind the chat and the registration goes through, which is what the
    // refusal tells the operator to do.
    await routing.unbind(chatTarget('oc_space', 'group'));
    await routing.bindSpace({
      spaceName: 'space',
      containerChatId: 'oc_space',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    expect(routing.plan(topicTarget('oc_space', 'omt_new'), 'oc_space')).toMatchObject({
      kind: 'provision',
    });
  });

  it('re-registers a space whose topics are already provisioned, because topic rows never conflict', async () => {
    const routing = await makeRouting();
    const space = await routing.bindSpace({
      spaceName: 'space',
      containerChatId: 'oc_space',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    await routing.bind({
      target: topicTarget('oc_space', 'omt_one'),
      teamName: 'team-a',
      display: null,
      origin: 'space',
      spaceId: space.space_id,
    });
    const renamed = await routing.bindSpace({
      spaceName: 'space-renamed',
      containerChatId: 'oc_space',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    expect(renamed.space_name).toBe('space-renamed');
    expect(routing.plan(topicTarget('oc_space', 'omt_one'), 'oc_space')).toMatchObject({
      kind: 'bound',
      teamName: 'team-a',
    });
  });

  /**
   * A document written before the two refusals existed can hold the
   * coexistence they now prevent, and neither API can reproduce it any more —
   * so it is seeded on disk, which is exactly what such a document is.
   *
   * This pins the decision that the refusal sits above the create/update fork
   * rather than only on creation. Such a document is already malfunctioning:
   * its fresh topics resolve to the whole-chat Team and never get one of their
   * own. Exempting the update path would let an operator keep editing policy
   * on top of that and never learn; failing the one write that names the
   * entity surfaces it while they are holding it.
   */
  it('refuses to re-register a space whose chat a legacy document also binds as a whole', async () => {
    const containerChatId = 'oc_space';
    const space_id = deriveSpaceId({
      dispatcherId: 'disp-1',
      channelId: 'chan-1',
      containerChatId,
    });
    writeFileSync(
      join(dir, routingDocumentFilename('chan-1')),
      JSON.stringify({
        version: 1,
        dispatcher_id: 'disp-1',
        channel_id: 'chan-1',
        bindings: [{
          target: { kind: 'group', chat_id: containerChatId },
          display: null,
          team_name: 'team-a',
          origin: 'manual',
          space_id: null,
          created_at: 1,
          updated_at: 1,
        }],
        spaces: [{
          space_id,
          space_name: 'space',
          container_chat_id: containerChatId,
          display: null,
          generation: 1,
          leader_agent_runtime: 'codex',
          identity: null,
          repo: null,
          created_at: 1,
          updated_at: 1,
        }],
        updated_at: 1,
      }),
    );
    const routing = await makeRouting();

    // It loads: validation is shape-only, so this cannot block a channel start.
    expect(routing.listSpaces()).toHaveLength(1);
    // And it is broken in exactly the way the refusals exist to prevent.
    expect(routing.plan(topicTarget(containerChatId, 'omt_new'), containerChatId))
      .toMatchObject({ kind: 'bound', teamName: 'team-a' });

    await expect(
      routing.bindSpace({
        spaceName: 'space-renamed',
        containerChatId,
        display: null,
        leaderAgentRuntime: 'codex',
        identity: null,
        repo: null,
      }),
    ).rejects.toThrow(/bound as a whole to Team "team-a"/);
    expect(routing.spaceByName('space')?.space_name).toBe('space');

    // The refusal's own instruction is the repair, and it works.
    await routing.unbind(chatTarget(containerChatId, 'group'));
    const renamed = await routing.bindSpace({
      spaceName: 'space-renamed',
      containerChatId,
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    expect(renamed.space_name).toBe('space-renamed');
    // Still one row, same id, same policy snapshot — so the call that was
    // refused above was the *update* branch, not a creation that happened to
    // hit the same guard. That is the distinction this test exists to pin.
    expect(routing.listSpaces()).toHaveLength(1);
    expect(renamed.space_id).toBe(space_id);
    expect(renamed.generation).toBe(1);
    expect(routing.plan(topicTarget(containerChatId, 'omt_new'), containerChatId))
      .toMatchObject({ kind: 'provision' });
  });

  it('unbindSpace removes only the space policy; nothing about existing bindings changes', async () => {
    const routing = await makeRouting();
    await routing.bindSpace({
      spaceName: 'space-x',
      containerChatId: 'oc_x',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    const target = topicTarget('oc_x', 'thread_1');
    await routing.bind({
      target,
      teamName: 'space-team',
      display: null,
      origin: 'space',
      spaceId: routing.spaceForContainer('oc_x')?.space_id ?? null,
    });

    const removed = await routing.unbindSpace('space-x');
    expect(removed?.space_name).toBe('space-x');
    expect(routing.spaceByName('space-x')).toBeUndefined();
    // The Team it already provisioned keeps routing.
    expect(routing.bindingFor(target)?.team_name).toBe('space-team');
  });
});
