/**
 * Coverage cell C (registry half): adapter equivalence.
 *
 * The `admin.sock` NDJSON server and the in-process Channel invoker are both
 * built here as the real production objects — `createAdminSocketServer` over
 * a real Unix socket, and `createChannelCorePort` — wired to the *same*
 * `CoreCommandPort` a harness builds around one shared registry. Any
 * divergence between them would have to be a divergence these tests actually
 * exercise, not an assumption about how the two adapters are supposed to
 * agree.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_PAYLOAD_BOUNDS } from '../src/command/registry.js';
import {
  adminContext,
  channelContext,
  createCommandHarness,
  createHarnessChannelInvoker,
  hostileDeepPayload,
  mintFakeMcpServer,
  startHarnessAdminSocket,
  type HarnessAdminSocket,
} from './helpers/command-harness.js';

describe('adapter equivalence — one representative Command per namespace', () => {
  let admin: HarnessAdminSocket | null = null;

  afterEach(async () => {
    if (admin !== null) {
      await admin.close();
      admin = null;
    }
  });

  it('server.status: identical result via admin.sock and the Channel invoker', async () => {
    const harness = createCommandHarness();
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);

    const viaAdmin = await admin.send('server.status');
    const viaChannel = await lease.port.invoke.invoke('server.status', {});

    expect(viaAdmin.ok).toBe(true);
    expect((viaAdmin as { result: unknown }).result).toEqual(viaChannel);
  });

  it('dispatcher.status: identical result via both adapters, each addressing the dispatcher its own way', async () => {
    const harness = createCommandHarness();
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);

    // admin.sock states dispatcher_id as a payload param the adapter lifts
    // into context; the Channel invoker states it once, at construction, and
    // never accepts it from the caller. Both name the same dispatcher.
    const viaAdmin = await admin.send('dispatcher.status', {
      dispatcher_id: harness.host.dispatcherRow('harness-d1')!.dispatcher_id,
    });
    const viaChannel = await lease.port.invoke.invoke('dispatcher.status', {});

    expect(viaAdmin.ok).toBe(true);
    expect((viaAdmin as { result: unknown }).result).toEqual(viaChannel);
  });

  it('team.list: identical result via both adapters', async () => {
    const harness = createCommandHarness({
      dispatcherOverrides: { listTeams: async () => [{ team_id: 'alpha' }] },
    });
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);

    const viaAdmin = await admin.send('team.list', { dispatcher_id: 'harness-d1' });
    const viaChannel = await lease.port.invoke.invoke('team.list', {});

    expect(viaAdmin.ok).toBe(true);
    expect((viaAdmin as { result: unknown }).result).toEqual(viaChannel);
    expect((viaChannel as { teams: unknown[] }).teams).toEqual([{ team_id: 'alpha' }]);
  });

  it('team.interrupt: both adapters preserve optional Team addressing', async () => {
    const interruptAgent = vi.fn(async () => ({ status: 'idle' as const }));
    const interruptTeamLeader = vi.fn(async (_teamId: string) => ({
      status: 'interrupted' as const,
    }));
    const harness = createCommandHarness({
      dispatcherOverrides: { interruptAgent, interruptTeamLeader },
    });
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);

    const dispatcherResult = await admin.send('team.interrupt', {
      dispatcher_id: 'harness-d1',
    });
    const leaderResult = await lease.port.invoke.invoke('team.interrupt', {
      team_name: 'alpha',
    });

    expect(dispatcherResult).toMatchObject({ ok: true, result: { status: 'idle' } });
    expect(leaderResult).toEqual({ status: 'interrupted' });
    expect(interruptAgent).toHaveBeenCalledOnce();
    expect(interruptTeamLeader).toHaveBeenCalledWith('alpha');
  });

  it('teammate.list: identical result via both adapters', async () => {
    const harness = createCommandHarness({
      dispatcherOverrides: { teammates: { list: async () => [{ name: 'mate-1' }] } },
    });
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);

    const viaAdmin = await admin.send('teammate.list', { dispatcher_id: 'harness-d1' });
    const viaChannel = await lease.port.invoke.invoke('teammate.list', {});

    expect(viaAdmin.ok).toBe(true);
    expect((viaAdmin as { result: unknown }).result).toEqual(viaChannel);
  });

  it('workflow.list: identical result via both adapters', async () => {
    const harness = createCommandHarness({
      dispatcherOverrides: { workflows: { list: async () => ({ runs: [] }) } },
    });
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);

    const viaAdmin = await admin.send('workflow.list', { dispatcher_id: 'harness-d1' });
    const viaChannel = await lease.port.invoke.invoke('workflow.list', {});

    expect(viaAdmin.ok).toBe(true);
    expect((viaAdmin as { result: unknown }).result).toEqual(viaChannel);
  });

  it('scheduler.cron.list: identical result via both adapters', async () => {
    // A whole job, because both adapters now answer with the scheduler's own
    // public projection of one: a partial stand-in would be a CronJob that is
    // not one, and would prove nothing about either adapter.
    const job = {
      id: 'cron-1',
      dispatcher_id: 'harness-d1',
      cron: '17 3 * * *',
      tz: 'UTC',
      recurring: true,
      action: { kind: 'prompt-agent', prompt: 'sweep' },
      enabled: true,
      created_at: 1,
      updated_at: 2,
      next_run_at: 3,
      last_fired_at: null,
    };
    const harness = createCommandHarness({
      dispatcherOverrides: { scheduler: { list: async () => ({ jobs: [job] }) } },
    });
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);

    const viaAdmin = await admin.send('scheduler.cron.list', { dispatcher_id: 'harness-d1' });
    const viaChannel = await lease.port.invoke.invoke('scheduler.cron.list', {});

    expect(viaAdmin.ok).toBe(true);
    expect((viaAdmin as { result: unknown }).result).toEqual(viaChannel);
    expect((viaChannel as { jobs: unknown[] }).jobs).toEqual([job]);
  });

  it('mcp.describe: identical result via both adapters, addressed by lease token rather than dispatcher_id', async () => {
    const harness = createCommandHarness();
    const { token } = mintFakeMcpServer(harness.mcpLeases, { toolName: 'echo' });
    admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);

    const viaAdmin = await admin.send('mcp.describe', { token });
    const viaChannel = await lease.port.invoke.invoke('mcp.describe', { token });

    expect(viaAdmin.ok).toBe(true);
    expect((viaAdmin as { result: unknown }).result).toEqual(viaChannel);
    expect((viaChannel as { tools: unknown[] }).tools).toHaveLength(1);
  });
});

describe('adapter context is factual and never filters the catalog', () => {
  it('the same Command name, called directly with an admin_socket vs a channel context, executes the same handler with the same result', async () => {
    // Bypasses both transport adapters to isolate exactly what the registry
    // itself does with `context`: `mcp.describe` never reads dispatcher_id or
    // channel_id, so its result must be byte-identical no matter which
    // adapter's context shape it is called with.
    const harness = createCommandHarness();
    const { token } = mintFakeMcpServer(harness.mcpLeases, { toolName: 'ping' });

    const viaAdminContext = await harness.registry.invoke(adminContext(), 'mcp.describe', {
      token,
    });
    const viaChannelContext = await harness.registry.invoke(
      channelContext(),
      'mcp.describe',
      { token },
    );

    expect(viaAdminContext).toEqual(viaChannelContext);
  });

  it('a Channel-bound context does not unlock a name an admin.sock caller cannot reach, and vice versa', async () => {
    // Every catalog name is reachable through the registry regardless of
    // which context shape addresses it — there is no per-source allowlist to
    // prove absent by exhausting every name, so this spot-checks one Command
    // from a namespace that is dispatcher-scoped (team.list) and one that
    // is not (mcp.describe) under both context shapes.
    const harness = createCommandHarness();
    const { token } = mintFakeMcpServer(harness.mcpLeases);

    await expect(
      harness.registry.invoke(channelContext(), 'team.list', {}),
    ).resolves.toBeDefined();
    await expect(
      harness.registry.invoke(adminContext('harness-d1'), 'team.list', {}),
    ).resolves.toBeDefined();
    await expect(
      harness.registry.invoke(channelContext(), 'mcp.describe', { token }),
    ).resolves.toBeDefined();
    await expect(
      harness.registry.invoke(adminContext(), 'mcp.describe', { token }),
    ).resolves.toBeDefined();
  });
});

describe('validation runs before the handler, on both adapters', () => {
  let admin: HarnessAdminSocket | null = null;

  afterEach(async () => {
    if (admin !== null) {
      await admin.close();
      admin = null;
    }
  });

  it('an invalid payload is rejected as BAD_REQUEST without the handler ever running (admin.sock)', async () => {
    const dissolveTeam = vi.fn(async () => ({
      accepted: true,
      team_name: 'x',
      status: 'dissolving',
    }));
    const harness = createCommandHarness({ dispatcherOverrides: { dissolveTeam } });
    admin = await startHarnessAdminSocket(harness);

    // team.dissolve requires both team_name and note; this sends neither.
    const response = await admin.send('team.dissolve', { dispatcher_id: 'harness-d1' });

    expect(response.ok).toBe(false);
    expect((response as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
    expect(dissolveTeam).not.toHaveBeenCalled();
  });

  it('an invalid payload is rejected as BAD_REQUEST without the handler ever running (Channel invoker)', async () => {
    const dissolveTeam = vi.fn(async () => ({
      accepted: true,
      team_name: 'x',
      status: 'dissolving',
    }));
    const harness = createCommandHarness({ dispatcherOverrides: { dissolveTeam } });
    const lease = createHarnessChannelInvoker(harness);

    await expect(
      lease.port.invoke.invoke('team.dissolve', {}),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dissolveTeam).not.toHaveBeenCalled();
  });

  it('COMMAND_PAYLOAD_BOUNDS.maxDepth rejects a hostile payload the Channel invoker built in-process — it never crossed JSON.parse', async () => {
    const harness = createCommandHarness();
    const lease = createHarnessChannelInvoker(harness);
    const tooDeep = hostileDeepPayload(COMMAND_PAYLOAD_BOUNDS.maxDepth + 4);

    await expect(
      lease.port.invoke.invoke('team.submit', { team_name: 'x', text: tooDeep }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('COMMAND_PAYLOAD_BOUNDS.maxDepth rejects the same hostile payload sent as JSON text over admin.sock', async () => {
    const harness = createCommandHarness();
    admin = await startHarnessAdminSocket(harness);
    const tooDeep = hostileDeepPayload(COMMAND_PAYLOAD_BOUNDS.maxDepth + 4);

    const response = await admin.send('team.submit', {
      dispatcher_id: 'harness-d1',
      team_name: 'x',
      text: 'placeholder',
      attrs: { deep: tooDeep },
    });

    expect(response.ok).toBe(false);
    expect((response as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  it('COMMAND_PAYLOAD_BOUNDS.maxEntries rejects an object with more keys than the bound allows', async () => {
    const harness = createCommandHarness();
    const lease = createHarnessChannelInvoker(harness);
    const wide: Record<string, string> = {};
    for (let i = 0; i < COMMAND_PAYLOAD_BOUNDS.maxEntries + 10; i++) {
      wide[`k${i}`] = 'v';
    }

    await expect(
      lease.port.invoke.invoke('team.submit', { team_name: 'x', text: 'hi', attrs: wide }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('COMMAND_PAYLOAD_BOUNDS.maxBytes rejects a payload larger than the byte budget', async () => {
    const harness = createCommandHarness();
    const lease = createHarnessChannelInvoker(harness);
    const huge = 'x'.repeat(COMMAND_PAYLOAD_BOUNDS.maxBytes + 1_024);

    await expect(
      lease.port.invoke.invoke('team.submit', { team_name: 'x', text: huge }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
