import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ChannelProvider,
  ChannelSession,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/catalog.js';
import { loadConfig } from '../src/config/config.js';
import { createTeammateService } from '../src/service/teammate-service/factory.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { AgentTurnsStore } from '../src/service/agent-entity/turns-store.js';
import type {
  AgentEntityWorktreeIdentity,
} from '../src/service/agent-entity/types.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import type { ExternalChannelProviderFactory } from '../src/channel/external-channel-provider.js';
import { testConfigFileObject } from './helpers/config.js';
import { asChannelDescriptor } from './helpers/provider.js';
import * as externalRuntimeModule from './fixtures/external-runtime-provider.js';

const EXTERNAL_RUNTIME_REF = 'npm:@example/dreamux-runtime#provider';
const EXTERNAL_CHANNEL_REF = 'npm:@example/dreamux-channel#provider';

function noopLog(): DreamuxLogger {
  const log = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as DreamuxLogger;
}

function reuseCwd(path: string): AgentEntityWorktreeIdentity {
  return {
    mode: 'reuse-cwd',
    slug: null,
    path,
    branch: null,
    base_ref: null,
    cleanup: 'keep',
    cleanup_state: 'not-managed',
    cleanup_error: null,
  };
}

function externalChannelFactory(): ExternalChannelProviderFactory {
  return ({ ref, descriptor }) => {
    const provider: ChannelProvider = {
      ref,
      descriptor: asChannelDescriptor(descriptor),
      readConfig(rawConfig) {
        return rawConfig;
      },
      getIdentity(config) {
        if (typeof config !== 'object' || config === null) return '';
        return String((config as Record<string, unknown>)['app_id'] ?? '');
      },
      createSession(context) {
        const session: ChannelSession = {
          provider: ref,
          channel_id: context.channel_id,
          async start() {
            /* config parse only */
          },
          async close() {
            /* config parse only */
          },
          async resolveTarget() {
            return { target_type: 'group', target_key: 'fixture', bindable: true };
          },
        };
        return session;
      },
    };
    return provider;
  };
}

async function writeConfigFile(input: {
  configDir: string;
  workspace: string;
}): Promise<void> {
  await mkdir(input.configDir, { recursive: true });
  const configFile = join(input.configDir, 'config.json');
  await writeFile(
    configFile,
    JSON.stringify(
      testConfigFileObject({
        agents: [
          {
            id: 'external-agent',
            provider: EXTERNAL_RUNTIME_REF,
            config: {
              finalTextPrefix: 'settled-by-generic-loader',
              model: 'fixture-model',
            },
          },
        ],
        dispatchers: [
          {
            id: 'flow',
            cwd: input.workspace,
            agentRuntime: 'external-agent',
            channelProvider: EXTERNAL_CHANNEL_REF,
            feishu: { app_id: 'fixture-app', app_secret: 'fixture-secret' },
          },
        ],
      }),
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await chmod(configFile, 0o600);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

describe('external runtime production parity', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-external-runtime-parity-'));
    externalRuntimeModule.resetExternalRuntimeFixture();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    externalRuntimeModule.resetExternalRuntimeFixture();
  });

  it('drives a generic-loader provider through the real TeammateService runtime path', async () => {
    const configDir = join(root, 'config');
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeConfigFile({ configDir, workspace });

    const importedRuntimePackages: string[] = [];
    const importedChannelPackages: string[] = [];
    const { config, providerRegistry } = await loadConfig({
      configDir,
      externalAgentRuntimeModuleImporter: async (packageName) => {
        importedRuntimePackages.push(packageName);
        return externalRuntimeModule;
      },
      externalChannelModuleImporter: async (packageName) => {
        importedChannelPackages.push(packageName);
        return { provider: externalChannelFactory() };
      },
    });

    expect(importedRuntimePackages).toEqual(['@example/dreamux-runtime']);
    expect(importedChannelPackages).toEqual(['@example/dreamux-channel']);

    const agentRuntimeProviders = new AgentRuntimeProviderCatalog({
      registry: providerRegistry,
    });
    expect(agentRuntimeProviders.resolve(EXTERNAL_RUNTIME_REF).ref).toBe(
      EXTERNAL_RUNTIME_REF,
    );

    const log = noopLog();
    const identities = new AgentIdentityStore(log);
    const turnsStore = new AgentTurnsStore(log);
    const identity = await identities.create({
      dispatcherId: 'flow',
      name: 'external-peer',
      role: 'teammate',
      agentRuntime: 'external-agent',
      sourceCwd: workspace,
      sourceRepo: null,
      cwd: workspace,
      runtimeCwd: workspace,
      worktree: reuseCwd(workspace),
      intent: 'prove external runtime parity',
      status: 'starting',
    });
    const settleCaptures: Promise<void>[] = [];
    const routedCompletions: Array<{
      producerName: string;
      turnId: string;
      result: string | null;
    }> = [];
    let submissionSeq = 0;
    const teammate = createTeammateService({
      dispatcherId: 'flow',
      identity,
      options: {
        runtimeId: 'flow.tm.external',
        ownsWorktreeOnClose: true,
      },
      config,
      agentRuntimeProviders,
      identities,
      turnsStore,
      worktrees: new WorktreeManager(),
      log,
      nextSubmissionSeq: () => {
        submissionSeq += 1;
        return submissionSeq;
      },
      trackSettleCapture: (capture) => settleCaptures.push(capture),
      routeSettledCompletion: async (producerName, turnId, completion) => {
        routedCompletions.push({
          producerName,
          turnId,
          result: completion.result,
        });
      },
    });

    const sent = await teammate.send({
      prompt: 'exercise neutral runtime seam',
      turnOrigin: 'dispatcher',
    });
    expect(sent.turn).toEqual({
      status: 'submitted',
      turn_id: 'teammate:external-peer:1',
    });

    await waitFor(() => settleCaptures.length === 1);
    await Promise.all(settleCaptures);

    expect(routedCompletions).toEqual([
      {
        producerName: 'external-peer',
        turnId: 'teammate:external-peer:1',
        result: 'settled-by-generic-loader: exercise neutral runtime seam',
      },
    ]);

    const last = await teammate.last(1);
    expect(last.turns).toMatchObject([
      {
        turn_id: 'teammate:external-peer:1',
        settle_status: 'completed',
        assistant: 'settled-by-generic-loader: exercise neutral runtime seam',
      },
    ]);

    expect(externalRuntimeModule.externalRuntimeObservations).toEqual([
      expect.objectContaining({
        providerRef: EXTERNAL_RUNTIME_REF,
        cwd: workspace,
        config: {
          finalTextPrefix: 'settled-by-generic-loader',
          model: 'fixture-model',
        },
        mcpServerNames: [],
        hasTurnSettledHook: true,
        starts: 1,
        submittedTexts: ['exercise neutral runtime seam'],
      }),
    ]);
    expect(externalRuntimeModule.externalRuntimeObservations[0]).not.toHaveProperty(
      'role',
    );
    expect(
      externalRuntimeModule.externalRuntimeObservations[0]?.disableFeatures,
    ).toContain('userInterrupt');
    expect(
      externalRuntimeModule.externalRuntimeObservations[0]?.skillSourceNames,
    ).not.toContain('codex');

    await teammate.stop();
    expect(externalRuntimeModule.externalRuntimeObservations[0]?.stops).toBe(1);

    const fixtureSource = await readFile(
      join(import.meta.dirname, 'fixtures', 'external-runtime-provider.ts'),
      'utf8',
    );
    expect(fixtureSource.match(/^import\s+(?!type\b)/gm) ?? []).toEqual([]);
    expect(fixtureSource.match(/^import\s+type\s+[\s\S]*?from\s+['"][^'"]+['"];?/gm)).toEqual([
      expect.stringContaining("from '@excitedjs/dreamux-types'"),
    ]);
  });
});
