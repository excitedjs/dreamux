import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Team } from '@excitedjs/dreamux-types';
import type { AgentEntityWorktreeIdentity } from '../src/service/agent/identity.js';
import { teamCreatePayloadHash } from '../src/service/team/create-request.js';
import { reuseCwdWorktree } from '../src/service/worktree/manager.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
async function launchedLeaderAppend(
  identityPrompt: string | null = null,
  workspace: (
    teamRoot: string,
  ) => AgentEntityWorktreeIdentity = reuseCwdWorktree,
  install: (hook: Team['hooks']['leaderLaunch']) => void = () => {},
): Promise<readonly string[]> {
  const fixture = await dispatcherFixture();
  const request = teamRequest('leader-prompt');
  const command = {
    ...request.command,
    leader: {
      ...request.command.leader,
      ...(identityPrompt === null ? {} : { identity: identityPrompt }),
    },
  };
  const created = await fixture.teams.createFromRequest({
    ...request,
    command,
    payloadHash: teamCreatePayloadHash(command),
  });
  expect(fixture.provider.runtimes).toHaveLength(0);
  await fixture.host.close();
  const path = join(fixture.teamRoot, created.team_name, 'record.json');
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(
    path,
    JSON.stringify({ ...record, worktree: workspace(created.runtime_cwd) }),
  );
  const restored = fixture.build();
  restored.host.hooks.team.tap('observe-leader-launch', (team) => {
    install(team.hooks.leaderLaunch);
  });
  expect(
    (
      await restored.teams.submitToLeader(created.team_name, {
        source: 'task',
        text: 'Inspect launch context',
        deliverCompletionToDispatcher: false,
      })
    ).status,
  ).toBe('submitted');
  expect(fixture.provider.runtimes).toHaveLength(1);
  return fixture.provider.runtimes[0]!.context.systemPrompt?.append ?? [];
}
async function launchedLeaderPrompt(
  identityPrompt: string | null = null,
  workspace: (
    teamRoot: string,
  ) => AgentEntityWorktreeIdentity = reuseCwdWorktree,
): Promise<string> {
  return (await launchedLeaderAppend(identityPrompt, workspace)).join('\n');
}
function managedWorktree(
  cleanup: AgentEntityWorktreeIdentity['cleanup'],
): (teamRoot: string) => AgentEntityWorktreeIdentity {
  return (teamRoot) => ({
    mode: 'managed',
    slug: 'team-alpha',
    path: teamRoot,
    branch: 'dreamux/team-alpha',
    base_ref: 'HEAD',
    cleanup,
    cleanup_state: 'managed-active',
    cleanup_error: null,
  });
}
describe('the prompt a TeamLeader runtime is launched with', () => {
  it("maps the role's MCP servers", async () => {
    const prompt = await launchedLeaderPrompt();
    expect(prompt).toContain('`teammate`');
    expect(prompt).toContain('`team`');
    expect(prompt).toContain('`cron`');
    expect(prompt).toContain('channel-');
  });

  it('names a reused workspace and its cleanup mode', async () => {
    const prompt = await launchedLeaderPrompt();
    expect(prompt).toContain('is a reused directory (cleanup: keep).');
  });

  it('names a managed delete-on-close workspace and its cleanup mode', async () => {
    const prompt = await launchedLeaderPrompt(
      null,
      managedWorktree('delete-on-close'),
    );
    expect(prompt).toContain(
      'is a managed git worktree (cleanup: delete-on-close).',
    );
  });

  it('names a managed kept workspace and its cleanup mode', async () => {
    const prompt = await launchedLeaderPrompt(null, managedWorktree('keep'));
    expect(prompt).toContain('is a managed git worktree (cleanup: keep).');
  });

  it('never mentions dissolving; that lives in the dissolve description', async () => {
    for (const workspace of [
      undefined,
      managedWorktree('delete-on-close'),
      managedWorktree('keep'),
    ]) {
      const prompt = await launchedLeaderPrompt(null, workspace);
      expect(prompt.replace(/`team` \(dissolve this Team\)/, '')).not.toMatch(
        /dissolv/i,
      );
    }
  });

  it("ends with the operator's own identity text", async () => {
    const identityPrompt = 'You are the release captain for this Team.';
    const append = await launchedLeaderAppend(identityPrompt);
    expect(append.at(-1)).toBe(identityPrompt);
  });

  it('places plugin draft instructions before the identity text and drops a failing tap', async () => {
    const identityPrompt = 'You are the release captain for this Team.';
    const append = await launchedLeaderAppend(
      identityPrompt,
      reuseCwdWorktree,
      (hook) => {
        hook.tapPromise('alpha', async (draft) => {
          draft.instructions.push('from alpha');
        });
        hook.tapPromise('broken', async (draft) => {
          draft.instructions.push('half written');
          throw new Error('read failed');
        });
      },
    );

    expect(append.slice(-2)).toEqual(['from alpha', identityPrompt]);
    expect(append).not.toContain('half written');
  });

  it('keeps a channel-composed identity whole across storage and restore', async () => {
    // What Feishu provisioning hands `team.create` is one string: the operator's
    // configured identity and the reply address the Team was created from. The
    // Team stores a string and the leader reads a string, so the composition
    // happens once, at creation, and nothing downstream appends it again.
    const configured = 'You are the release captain for this Team.';
    const guidance = [
      'Reply in this Feishu conversation with the channel reply tool:',
      '- chat_id: oc_example',
      '- message_id: om_initial_message (the message that initially triggered Team creation)',
      'Never omit message_id.',
    ].join('\n');
    const composed = `${configured}\n\n${guidance}`;

    const append = await launchedLeaderAppend(composed);

    expect(append.at(-1)).toBe(composed);
    const prompt = append.join('\n');
    expect(prompt).toContain('`teammate`');
    expect(prompt).toContain(composed);
    expect(prompt.indexOf(guidance)).toBe(prompt.lastIndexOf(guidance));
    expect(prompt.indexOf(composed)).toBeGreaterThan(
      prompt.indexOf('`teammate`'),
    );
  });

  it('carries no rule that another surface now owns', async () => {
    const prompt = await launchedLeaderPrompt();
    for (const fragment of [
      'do not poll',
      'reply tool',
      'public artifacts',
      'Load a tool',
    ]) {
      expect(
        prompt,
        `the TeamLeader prompt states "${fragment}" again`,
      ).not.toContain(fragment);
    }
  });

  it('mandates no skill before a turn', async () => {
    const prompt = await launchedLeaderPrompt();
    expect(prompt).not.toContain('teamwork');
  });
});
