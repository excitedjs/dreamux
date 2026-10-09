import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentRuntimeSkillSource,
  Dispatcher,
} from '@excitedjs/dreamux-types';
import { teamCreatePayloadHash } from '../src/service/team/create-request.js';
import { TEAM_LEADER_REQUIRED_SKILL_SOURCES } from '../src/service/team/leader.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';

type Fixture = Awaited<ReturnType<typeof dispatcherFixture>>;
async function skillRoot(
  fixture: Fixture,
  rootName: string,
  skillName: string,
): Promise<string> {
  const root = join(fixture.host.cwd, rootName);
  await mkdir(join(root, skillName), { recursive: true });
  return root;
}

function promptedRequest(
  id: string,
  skillSources: readonly AgentRuntimeSkillSource[] = [],
) {
  const request = teamRequest(id, 'Inspect launch context');
  const command = {
    ...request.command,
    leader: { ...request.command.leader, skill_sources: skillSources },
  };
  return { ...request, command, payloadHash: teamCreatePayloadHash(command) };
}

describe('Team hook composition through real owner construction', () => {
  it('orders mandatory, identity, and plugin skill roots in the launched runtime', async () => {
    const fixture = await dispatcherFixture();
    const identityRoot = await skillRoot(
      fixture,
      'identity-root',
      'identity-skill',
    );
    const pluginRoot = await skillRoot(fixture, 'plugin-root', 'plugin-skill');
    fixture.host.hooks.team.tap('install-plugin', (team) => {
      team.hooks.leaderLaunch.tapPromise('alpha', async (draft) => {
        draft.skillSources.push({
          name: 'alpha',
          path: pluginRoot,
          source: 'alpha',
        });
      });
    });
    await fixture.teams.createFromRequest(
      promptedRequest('skill-order', [
        { name: 'identity', path: identityRoot, source: 'admin' },
      ]),
    );
    expect(
      fixture.provider.runtimes[0]!.context.skillSources.map(
        (source) => source.name,
      ),
    ).toEqual([
      ...TEAM_LEADER_REQUIRED_SKILL_SOURCES.map((source) => source.name),
      'identity',
      'alpha',
    ]);
  });

  it('drops an entire colliding plugin skill draft and still runs subsequent taps', async () => {
    const fixture = await dispatcherFixture();
    const identityRoot = await skillRoot(
      fixture,
      'identity-root',
      'same-skill',
    );
    const collidingRoot = await skillRoot(
      fixture,
      'colliding-root',
      'same-skill',
    );
    const cleanRoot = await skillRoot(fixture, 'clean-root', 'other-skill');
    fixture.host.hooks.team.tap('install-plugin', (team) => {
      team.hooks.leaderLaunch.tapPromise('colliding', async (draft) => {
        draft.instructions.push('from colliding');
        draft.skillSources.push({
          name: 'colliding',
          path: collidingRoot,
          source: 'colliding',
        });
      });
      team.hooks.leaderLaunch.tapPromise('clean', async (draft) => {
        draft.instructions.push('from clean');
        draft.skillSources.push({
          name: 'clean',
          path: cleanRoot,
          source: 'clean',
        });
      });
    });
    await fixture.teams.createFromRequest(
      promptedRequest('skill-collision', [
        { name: 'identity', path: identityRoot, source: 'admin' },
      ]),
    );
    const context = fixture.provider.runtimes[0]!.context;
    expect(context.skillSources.map((source) => source.name)).toEqual([
      ...TEAM_LEADER_REQUIRED_SKILL_SOURCES.map((source) => source.name),
      'identity',
      'clean',
    ]);
    expect(context.systemPrompt?.append).toContain('from clean');
    expect(context.systemPrompt?.append).not.toContain('from colliding');
  });

  it('keeps the leader launch hook at one call across a runtime stop and restart in the same Team', async () => {
    const fixture = await dispatcherFixture();
    let launches = 0;
    fixture.host.hooks.team.tap('install-plugin', (team) => {
      team.hooks.leaderLaunch.tapPromise('count', async () => {
        launches++;
      });
    });
    const created = await fixture.teams.createFromRequest(
      promptedRequest('process-restart'),
    );
    const service = await fixture.teams.open(created.team_name);
    expect(launches).toBe(1);
    await service.stopForHost();
    expect(
      (
        await service.submitInput({
          source: 'task',
          text: 'Second turn',
        })
      ).status,
    ).toBe('submitted');
    expect(fixture.provider.runtimes).toHaveLength(2);
    expect(launches).toBe(1);
  });

  it('announces create and rebuild once each while replay and repeated open construct nothing', async () => {
    const fixture = await dispatcherFixture();
    const origins: string[] = [];
    let launches = 0;
    function observe(host: Dispatcher) {
      host.hooks.team.tap('observe', (team, event) => {
        origins.push(event.origin);
        team.hooks.leaderLaunch.tapPromise('count', async () => {
          launches++;
        });
      });
    }
    observe(fixture.host);
    const request = teamRequest('replayed-hook');
    const created = await fixture.teams.createFromRequest(request);
    await fixture.teams.createFromRequest(request);
    expect(origins).toEqual(['create']);
    expect(launches).toBe(1);
    await fixture.host.close();
    const restored = fixture.build();
    observe(restored.host);
    await restored.teams.createFromRequest(request);
    expect(origins).toEqual(['create']);
    const [left, right] = await Promise.all([
      restored.teams.open(created.team_name),
      restored.teams.open(created.team_name),
    ]);
    expect(left).toBe(right);
    expect(origins).toEqual(['create', 'rebuild']);
    expect(launches).toBe(2);
    expect(fixture.provider.runtimes).toHaveLength(0);
  });

  it('preserves leader taps registered before a Team tap throws and continues later Team taps', async () => {
    const fixture = await dispatcherFixture();
    fixture.host.hooks.team.tap('broken-owner', (team) => {
      team.hooks.leaderLaunch.tapPromise(
        'registered-before-throw',
        async (draft) => {
          draft.instructions.push('surviving registration');
        },
      );
      throw new Error('owner stopped after registration');
    });
    fixture.host.hooks.team.tap('next-owner', (team) => {
      team.hooks.leaderLaunch.tapPromise('later-owner', async (draft) => {
        draft.instructions.push('later registration');
      });
    });
    const created = await fixture.teams.createFromRequest(
      promptedRequest('throwing-team-tap'),
    );
    expect(created.status).toBe('running');
    expect(
      fixture.provider.runtimes[0]!.context.systemPrompt?.append?.slice(-2),
    ).toEqual(['surviving registration', 'later registration']);
  });
});
