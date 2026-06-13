/**
 * Real built-in package-loader contract test (issue #209 slice 3).
 *
 * Proves that the generic provider package-loader path is real for Codex: the
 * `builtin:codex` alias resolves to `@excitedjs/agent-runtime-codex` via
 * `BUILTIN_PROVIDER_PACKAGES`, the loader imports the ACTUAL package (default
 * importer, no fake module), selects its default-export factory, and the loaded
 * provider satisfies the `AgentRuntimeProvider` contract end-to-end — including a
 * runnable `createRuntime` constructed from the neutral create context alone
 * (the package falls back to its own standalone socket allocator).
 *
 * Production wires Codex through the core-owned adapter instead, because core's
 * launcher still drives the host-shaped create context; this test exercises the
 * package's neutral contract directly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimePathContext,
  AgentRuntimeProvider,
  AgentRuntimeStateCallbacks,
} from '@excitedjs/dreamux-types';
import type { DispatcherCodexConfig } from '@excitedjs/agent-runtime-codex';

import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { loadExternalAgentRuntimeProviders } from '../src/agent-runtime/external-provider.js';

const tmpDirs: string[] = [];
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function loadRealCodexProvider(): Promise<
  AgentRuntimeProvider<DispatcherCodexConfig>
> {
  const registry = createBuiltinProviderRegistry();
  // Default importer => real `import('@excitedjs/agent-runtime-codex')`.
  await loadExternalAgentRuntimeProviders({ registry, refs: ['builtin:codex'] });
  const descriptor = registry.resolve('builtin:codex');
  const impl = registry.getImplementation(descriptor.id);
  return impl as AgentRuntimeProvider<DispatcherCodexConfig>;
}

describe('builtin:codex loads the real @excitedjs/agent-runtime-codex package', () => {
  it('satisfies the AgentRuntimeProvider contract through the generic loader', async () => {
    const provider = await loadRealCodexProvider();

    expect(provider.ref).toBe('builtin:codex');
    expect(provider.descriptor.kind).toBe('agentRuntime');
    expect(provider.descriptor.ref.raw).toBe('builtin:codex');

    const capabilities = provider.getCapabilities();
    expect(capabilities.resume.supported).toBe(true);
    expect(capabilities.resume.checkpoint).toBe('codexThread');
    expect(capabilities.teammateCompletion.map((s) => s.kind)).toEqual([
      'codexInboxTurn',
    ]);
  });

  it('parses real Codex runtime config via the loaded provider readConfig', async () => {
    const provider = await loadRealCodexProvider();

    const config = provider.readConfig!(
      { approval_policy: 'never', sandbox_mode: 'read-only' },
      { providerRef: 'builtin:codex', agentId: 'flow', file: 'config.json', prefix: '' },
    );
    expect(config.approval_policy).toBe('never');
    expect(config.sandbox_mode).toBe('read-only');
    expect(config.bin).toBe('codex');
  });

  it('constructs a runnable runtime from the neutral create context alone', async () => {
    const provider = await loadRealCodexProvider();
    const config = provider.readConfig!(
      {},
      { providerRef: 'builtin:codex', agentId: 'flow', file: 'config.json', prefix: '' },
    );

    const tmp = mkdtempSync(join(tmpdir(), 'dx-codex-loader-'));
    tmpDirs.push(tmp);
    const paths: AgentRuntimePathContext = {
      dispatcherDir: () => tmp,
      stdoutLogPath: () => join(tmp, 'out.log'),
      stderrLogPath: () => join(tmp, 'err.log'),
      completionSpillDir: () => join(tmp, 'spill'),
    };
    const state: AgentRuntimeStateCallbacks = {
      setStatus: async () => {},
      setThreadId: async () => {},
    };
    const context: AgentRuntimeCreateContext<DispatcherCodexConfig> = {
      identity: { runtime_id: 'flow', checkpoint_id: null },
      role: 'dispatcher',
      config,
      cwd: tmp,
      mcpServers: [],
      paths,
      state,
    };

    // No host socket allocator injected: the package falls back to its own
    // standalone allocator, so construction succeeds without throwing.
    const runtime = provider.createRuntime(context);
    runtimes.push(runtime);
    expect(runtime.providerRef).toBe('builtin:codex');
    expect(runtime.getStatus()).toBe('declared');
  });
});
