/**
 * Test helper for the neutral agentRuntime-provider seam (issue #209 Q2).
 *
 * Production loads every referenced runtime implementation — builtin and npm
 * alike — through the single dynamic loader (`loadConfig`), and the Server backs
 * its `AgentRuntimeProviderCatalog` with the resulting registry. The Server's
 * old codex-specific construction seams (`codexProcessFactory` /
 * `codexClientFactory` / `codexHomeDoctor` / restart backoff) are gone: those
 * are the Codex *package's* hooks, injected by registering a codex provider that
 * carries them — never by Server, which names no provider's internals.
 *
 * This mirrors `fake-channel.ts`'s `feishuChannelCatalog` exactly: seed a
 * registry with the builtin descriptors, register the codex AND claude-code
 * implementations (the codex one carrying the test fakes), and return an
 * `AgentRuntimeProviderCatalog`. Tests inject the result as
 * `agentRuntimeProviderCatalog` instead of the removed Server codex seams.
 */
import { createBuiltinProviderRegistry } from '../../src/registry/index.js';
import {
  BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  BUILTIN_CODEX_PROVIDER_REF,
} from '../../src/registry/builtins.js';
import { AgentRuntimeProviderCatalog } from '../../src/agent-runtime/catalog.js';
import {
  createCodexAgentRuntimeProvider,
  type CodexProcess,
  type CodexProcessOptions,
  type CodexWsClient,
} from '@excitedjs/agent-runtime-codex';
import {
  createClaudeCodeAgentRuntimeProvider,
  type ClaudeCodeAgentRuntimeProviderOptions,
} from '@excitedjs/agent-runtime-claude-code';

export interface CodexAgentRuntimeCatalogOptions {
  /** Codex child-process double (the fake codex's WS endpoint backs it). */
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  /** Codex WS-client double pointing at the fake codex. */
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  /** Optional Codex home/auth pre-start check (fake codex tests no-op it). */
  codexHomeDoctor?: (info: { runtimeId: string; cwd: string }) => void | Promise<void>;
  restartBackoffBaseMs?: number;
  restartBackoffMaxMs?: number;
  /**
   * Optional Claude Code provider overrides (e.g. a fake session factory). The
   * descriptor is supplied by this helper from the registry.
   */
  claude?: Omit<ClaudeCodeAgentRuntimeProviderOptions, 'descriptor'>;
}

/**
 * An `AgentRuntimeProviderCatalog` backed by the real builtin codex + claude-code
 * providers, with the codex implementation carrying the supplied test fakes
 * (process/client factories, home doctor, restart backoff). Use it wherever a
 * test previously passed the Server's codex* construction seams.
 */
export function codexAgentRuntimeCatalog(
  options: CodexAgentRuntimeCatalogOptions = {},
): AgentRuntimeProviderCatalog {
  const { claude, ...codexFakes } = options;
  const registry = createBuiltinProviderRegistry();

  const codexDescriptor = registry.resolve(BUILTIN_CODEX_PROVIDER_REF);
  registry.registerImplementation(
    codexDescriptor.id,
    createCodexAgentRuntimeProvider({ descriptor: codexDescriptor, ...codexFakes }),
  );

  const claudeDescriptor = registry.resolve(BUILTIN_CLAUDE_CODE_PROVIDER_REF);
  registry.registerImplementation(
    claudeDescriptor.id,
    createClaudeCodeAgentRuntimeProvider({ descriptor: claudeDescriptor, ...claude }),
  );

  return new AgentRuntimeProviderCatalog({ registry });
}
