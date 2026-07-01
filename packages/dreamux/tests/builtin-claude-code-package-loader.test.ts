/**
 * Real built-in package-loader contract test (issue #209 slice 4).
 *
 * Proves that the generic provider package-loader path is real for Claude Code:
 * the `builtin:claude-code` alias resolves to
 * `@excitedjs/agent-runtime-claude-code` via `BUILTIN_PROVIDER_PACKAGES`, the
 * loader imports the ACTUAL package (default importer, no fake module), selects
 * its default-export factory, and the loaded provider satisfies the
 * `AgentRuntimeProvider` contract end-to-end — including a `createRuntime`
 * constructed from the neutral create context alone (no host hooks injected).
 *
 * Production wires Claude Code through the core-owned adapter instead, because
 * core's launcher still drives the host-shaped create context; this test
 * exercises the package's neutral contract directly.
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
import type { DispatcherClaudeCodeConfig } from '@excitedjs/agent-runtime-claude-code';

import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { loadAgentRuntimeProviders } from '../src/agent-runtime/external-provider.js';

const tmpDirs: string[] = [];
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function loadRealClaudeCodeProvider(): Promise<
  AgentRuntimeProvider<DispatcherClaudeCodeConfig>
> {
  const registry = createBuiltinProviderRegistry();
  // Default importer => real `import('@excitedjs/agent-runtime-claude-code')`.
  await loadAgentRuntimeProviders({
    registry,
    refs: ['builtin:claude-code'],
  });
  const descriptor = registry.resolve('builtin:claude-code');
  const impl = registry.getImplementation(descriptor.id);
  return impl as AgentRuntimeProvider<DispatcherClaudeCodeConfig>;
}

describe('builtin:claude-code loads the real @excitedjs/agent-runtime-claude-code package', () => {
  it('satisfies the AgentRuntimeProvider contract through the generic loader', async () => {
    const provider = await loadRealClaudeCodeProvider();

    expect(provider.ref).toBe('builtin:claude-code');
    expect(provider.descriptor.kind).toBe('agentRuntime');
    expect(provider.descriptor.ref.raw).toBe('builtin:claude-code');

    const capabilities = provider.getCapabilities();
    expect(capabilities.resume).toEqual({
      supported: true,
    });
  });

  it('parses real Claude Code runtime config via the loaded provider readConfig', async () => {
    const provider = await loadRealClaudeCodeProvider();

    const config = await provider.readConfig!(
      { model: 'sonnet', permission_mode: 'plan' },
      {
        providerRef: 'builtin:claude-code',
        agentId: 'flow',
        file: 'config.json',
        prefix: '',
      },
    );
    expect(config.model).toBe('sonnet');
    expect(config.permission_mode).toBe('plan');
    expect(config.bin).toBe('claude');
  });

  it('constructs a runtime from the neutral context without throwing on absent host hooks', async () => {
    const provider = await loadRealClaudeCodeProvider();
    const config = await provider.readConfig!(
      {},
      {
        providerRef: 'builtin:claude-code',
        agentId: 'flow',
        file: 'config.json',
        prefix: '',
      },
    );

    const tmp = mkdtempSync(join(tmpdir(), 'dx-claude-loader-'));
    tmpDirs.push(tmp);
    const paths: AgentRuntimePathContext = {
      dispatcherDir: () => tmp,
      logsDir: () => tmp,
      completionSpillDir: () => join(tmp, 'spill'),
      runtimeSocketDirs: () => [join(tmp, 'sockets')],
    };
    const state: AgentRuntimeStateCallbacks = {
      setStatus: async () => {},
      setCheckpoint: async () => {},
    };
    const context: AgentRuntimeCreateContext<DispatcherClaudeCodeConfig> = {
      identity: { runtime_id: 'flow', checkpoint_id: null },
      role: 'dispatcher',
      config,
      cwd: tmp,
      mcpServers: [],
      paths,
      state,
    };

    // No host base-env / session factory injected: the package falls back to
    // its own defaults, so construction succeeds without throwing.
    const runtime = provider.createRuntime(context);
    runtimes.push(runtime);
    expect(runtime.providerRef).toBe('builtin:claude-code');
    expect(runtime.getStatus()).toBe('declared');
  });
});
