import { describe, expect, it, vi } from 'vitest';
import {
  adminContext,
  createCommandHarness,
  createUnstartedCommandServer,
} from './helpers/command-harness.js';
describe('structural host addressing through the actual Server', () => {
  it('pre-start missing and unknown ids reject before reading the late dispatchers accessor', async () => {
    const { host } = await createUnstartedCommandServer();
    const late = vi.spyOn(host, 'dispatchers', 'get');
    for (const name of [
      'dispatcher.status',
      'channel.list',
      'team.list',
      'teammate.list',
      'workflow.list',
      'scheduler.cron.list',
    ]) {
      await expect(
        host.commands.invoke(adminContext(), name, {}),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        host.commands.invoke(adminContext('unknown'), name, {}),
      ).rejects.toMatchObject({ code: 'DISPATCHER_NOT_FOUND' });
    }
    expect(late).not.toHaveBeenCalled();
  });
  it('pre-start configured ids reach the normal not-started error', async () => {
    const { host } = await createUnstartedCommandServer();
    await expect(
      host.commands.invoke(adminContext('harness-d1'), 'channel.list', {}),
    ).rejects.toThrow('dreamux server has not started');
  });
  it('configured-id validation wins over a previously materialized aggregate', async () => {
    const harness = await createCommandHarness();
    const snapshot = harness.host.config.current();
    vi.spyOn(harness.host.config, 'current').mockReturnValue({
      ...snapshot,
      dispatchers: [],
    });
    for (const name of [
      'dispatcher.status',
      'channel.list',
      'team.list',
      'teammate.list',
      'workflow.list',
      'scheduler.cron.list',
    ]) {
      await expect(
        harness.host.commands.invoke(adminContext('harness-d1'), name, {}),
      ).rejects.toMatchObject({ code: 'DISPATCHER_NOT_FOUND' });
    }
    expect(harness.dispatcherLookups).toEqual([]);
  });
});
