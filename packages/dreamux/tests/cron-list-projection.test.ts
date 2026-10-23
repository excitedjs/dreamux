import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonSchema } from '@excitedjs/dreamux-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateJsonSchema } from '../src/command/validate.js';
import { runMcpServer } from '../src/mcp/server.js';
import { createLogger } from '../src/platform/logger.js';
import { WorkFence } from '../src/platform/work-fence.js';
import { validateMcpToolCatalog } from '../src/service/mcp/catalog.js';
import { SchedulerService } from '../src/service/scheduler/index.js';
import { createCronMcpDelegate } from '../src/service/scheduler/mcp.js';
import {
  callTool,
  connectMcpClient,
  listedTools,
} from './helpers/mcp-client.js';

let root: string;
let scheduler: SchedulerService;
let fence: WorkFence;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dreamux-cron-list-'));
  fence = new WorkFence('cron-list-owner');
  scheduler = new SchedulerService({
    ownerId: 'cron-list-owner',
    cronJobsPath: join(root, 'cron-jobs.json'),
    fence,
    recipient: {
      async submitInput() {
        throw new Error('listing cron jobs must not submit an input');
      },
    },
    log: createLogger({ destination: { write() {} } }),
  });
});

afterEach(async () => {
  scheduler.stop();
  await fence.drain();
  await rm(root, { recursive: true, force: true });
});

describe('cron_list MCP projection', () => {
  it('returns compact metadata and a Unicode preview without changing stored jobs', async () => {
    const preview = '中'.repeat(199) + '😀';
    const prompt = preview + '\r\n尾';
    const first = await scheduler.create({
      cron: '17 3 * * *',
      tz: 'UTC',
      title: 'nightly',
      prompt,
    });
    const second = await scheduler.create({
      cron: '19 4 * * *',
      tz: 'UTC',
      recurring: false,
      prompt: 'reminder',
    });
    await scheduler.update({ id: second.id, enabled: false });
    const before = await scheduler.list();
    const paused = before.jobs.find((job) => job.id === second.id)!;

    expect(
      await createCronMcpDelegate(scheduler).call({
        name: 'cron_list',
        arguments: {},
      }),
    ).toEqual({
      ok: true,
      structured: {
        jobs: [
          {
            id: first.id,
            title: 'nightly',
            cron: '17 3 * * *',
            tz: 'UTC',
            recurring: true,
            enabled: true,
            next_run_at: first.next_run_at,
            last_fired_at: null,
            prompt_preview: preview,
            prompt_bytes: 606,
          },
          {
            id: second.id,
            cron: '19 4 * * *',
            tz: 'UTC',
            recurring: false,
            enabled: false,
            next_run_at: paused.next_run_at,
            last_fired_at: null,
            prompt_preview: 'reminder',
            prompt_bytes: 8,
          },
        ],
      },
    });
    expect(await scheduler.list()).toEqual(before);
  });

  it.each([199, 200, 201])(
    'previews %i supplementary Unicode code points without splitting a pair',
    async (count) => {
      const job = await scheduler.create({
        cron: '17 3 * * *',
        tz: 'UTC',
        prompt: '😀'.repeat(count),
      });
      const result = await createCronMcpDelegate(scheduler).call({
        name: 'cron_list',
        arguments: { id: job.id, include_prompt: false },
      });
      expect(result).toMatchObject({
        ok: true,
        structured: {
          jobs: [
            {
              prompt_preview: '😀'.repeat(Math.min(count, 200)),
              prompt_bytes: count * 4,
            },
          ],
        },
      });
      if (!result.ok) throw new Error(result.message);
      const value = result.structured as { jobs: Record<string, unknown>[] };
      expect(value.jobs[0]).not.toHaveProperty('prompt');
      expect(value.jobs[0]).not.toHaveProperty('action');
    },
  );

  it('reads one complete prompt for editing without returning the other jobs', async () => {
    const prompt = '😀'.repeat(200) + '\ne\u0301\r\nfinish';
    const first = await scheduler.create({
      cron: '17 3 * * *',
      tz: 'UTC',
      prompt,
    });
    await scheduler.create({
      cron: '19 4 * * *',
      tz: 'UTC',
      prompt: 'unrelated instructions',
    });
    const delegate = createCronMcpDelegate(scheduler);
    const result = await delegate.call({
      name: 'cron_list',
      arguments: { id: first.id, include_prompt: true },
    });
    expect(result).toEqual({
      ok: true,
      structured: {
        jobs: [
          {
            id: first.id,
            cron: '17 3 * * *',
            tz: 'UTC',
            recurring: true,
            enabled: true,
            next_run_at: first.next_run_at,
            last_fired_at: null,
            prompt_preview: '😀'.repeat(200),
            prompt_bytes: 812,
            prompt,
          },
        ],
      },
    });
    if (!result.ok) throw new Error(result.message);
    const value = result.structured as { jobs: { prompt: string }[] };
    const editedPrompt = value.jobs[0]!.prompt + '\nnew instruction';
    await delegate.call({
      name: 'cron_update',
      arguments: { id: first.id, prompt: editedPrompt },
    });
    const stored = await scheduler.list();
    expect(stored.jobs.find((job) => job.id === first.id)?.action).toEqual({
      kind: 'prompt-agent',
      prompt: editedPrompt,
    });
    expect(
      await delegate.call({
        name: 'cron_list',
        arguments: { id: 'missing-job', include_prompt: true },
      }),
    ).toEqual({ ok: true, structured: { jobs: [] } });
  });

  it('supports compact and full reads through the SDK with closed schemas', async () => {
    const job = await scheduler.create({
      cron: '17 3 * * *',
      tz: 'UTC',
      prompt: '😀'.repeat(201),
    });
    const delegate = createCronMcpDelegate(scheduler);
    const [tool] = validateMcpToolCatalog(
      delegate
        .describe()
        .tools.filter(
          (entry) => (entry as { name: string }).name === 'cron_list',
        ),
      'cron list test',
    );
    const connection = await connectMcpClient((transport) =>
      runMcpServer({
        identity: { name: 'cron-list-test', version: '1.0.0' },
        tools: [
          {
            ...tool!,
            handler: async (args) => {
              const result = await delegate.call({
                name: 'cron_list',
                arguments: args,
              });
              if (!result.ok) throw new Error(result.message);
              return {
                structured: result.structured as Record<string, unknown>,
              };
            },
          },
        ],
        transport,
        log: () => {},
      }),
    );
    try {
      const [advertised] = await listedTools(connection.client);
      const compact = await callTool(connection.client, 'cron_list', {});
      expect(compact.isError).not.toBe(true);
      expect(compact.structuredContent).toMatchObject({
        jobs: [
          { id: job.id, prompt_preview: '😀'.repeat(200), prompt_bytes: 804 },
        ],
      });
      const full = await callTool(connection.client, 'cron_list', {
        id: job.id,
        include_prompt: true,
      });
      expect(full.isError).not.toBe(true);
      expect(full.structuredContent).toMatchObject({
        jobs: [{ id: job.id, prompt: '😀'.repeat(201) }],
      });
      expect(advertised!.inputSchema.additionalProperties).toBe(false);
      const output = advertised!.outputSchema as JsonSchema;
      expect(() =>
        validateJsonSchema(full.structuredContent, output),
      ).not.toThrow();
      expect(() =>
        validateJsonSchema(
          {
            jobs: [
              {
                ...(full.structuredContent as { jobs: object[] }).jobs[0],
                action: job.action,
              },
            ],
          },
          output,
        ),
      ).toThrow(/unknown property 'action'/);
      expect(() =>
        validateJsonSchema({ jobs: [], internal: true }, output),
      ).toThrow(/unknown property 'internal'/);
      for (const args of [
        { include_prompt: 'true' },
        { id: 12 },
        { id: '' },
        { internal: true },
      ]) {
        const invalid = await callTool(connection.client, 'cron_list', args);
        expect(invalid.isError).toBe(true);
      }
    } finally {
      await connection.close();
    }
  });
});
