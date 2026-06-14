/**
 * Root-export allowlist guard (issue #209 overexposure audit, section B).
 *
 * `@excitedjs/dreamux-types` publishes only its package root (the `exports` map
 * exposes `.` → `dist/index.d.ts` and nothing deeper). So the set of names
 * re-exported by `src/index.ts` IS the public API an external provider author
 * can name. This test pins that set to an explicit allowlist so a later slice
 * cannot casually widen the surface — adding a root export now requires updating
 * this list, which is the deliberate review checkpoint.
 *
 * Helper shapes a provider only reaches contextually (e.g.
 * `AgentRuntimeDiagnosticContext` — a param of the *required* `AgentRuntimeDiagnostic`
 * methods, contextually inferred — `ChannelSender`, and the vestigial
 * `AgentRuntimeResumeCapability` / `AgentRuntimeResumeCheckpoint`) stay
 * `export`ed from their source module — the emitted `.d.ts` resolves them
 * transitively — but are intentionally absent here. The expanded
 * `tests/fixtures/external-provider.ts` proves this allowlist is *sufficient*:
 * it implements the full provider surface (incl. diagnostics, the factory
 * contract, and the optional channel tool/reply/react methods) importing from
 * the root only. Note: params of *optional* interface methods (e.g.
 * `ChannelToolCall` on `handleTool?`) are NOT contextually inferred under
 * `strict`, so those stay root-exported.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexFile = join(here, '..', 'src', 'index.ts');

/** The intended public root API. Keep sorted; grow only by deliberate review. */
const ALLOWLIST = [
  'AgentRuntime',
  'AgentRuntimeBinCheck',
  'AgentRuntimeCapabilities',
  'AgentRuntimeContextSnapshot',
  'AgentRuntimeCreateContext',
  'AgentRuntimeDiagnostic',
  'AgentRuntimeDiagnosticRunner',
  'AgentRuntimeDoctorResult',
  'AgentRuntimeIdentity',
  'AgentRuntimeLastResult',
  'AgentRuntimeMcpServer',
  'AgentRuntimePathContext',
  'AgentRuntimeProvider',
  'AgentRuntimeProviderConfigReadContext',
  'AgentRuntimeProviderDescriptor',
  'AgentRuntimeProviderFactory',
  'AgentRuntimeResumeInput',
  'AgentRuntimeRole',
  'AgentRuntimeSkillSource',
  'AgentRuntimeStateCallbacks',
  'AgentRuntimeStatus',
  'AgentRuntimeSystemInput',
  'AgentRuntimeTurnResult',
  'BuiltinProviderRef',
  'ChannelConfigContext',
  'ChannelInboundEnvelope',
  'ChannelMessageTargetCheck',
  'ChannelProvider',
  'ChannelProviderDescriptor',
  'ChannelProviderFactory',
  'ChannelReactInput',
  'ChannelReplyInput',
  'ChannelRoutes',
  'ChannelSession',
  'ChannelSessionCreateContext',
  'ChannelTarget',
  'ChannelToolCall',
  'ChannelToolContext',
  'ChannelToolDescriptor',
  'ChannelToolListContext',
  'CompletionDeliveryShape',
  'CompletionEnvelope',
  'DreamuxEnvironment',
  'DreamuxLogger',
  'InboundAttachment',
  'InboundDeliveryHooks',
  'InboundDeliveryResult',
  'InboundTurnInput',
  'NoticeInjectionResult',
  'NpmProviderRef',
  'ProviderDescriptor',
  'ProviderFactory',
  'ProviderFactoryContext',
  'ProviderKind',
  'ProviderRef',
  'ProviderRefSource',
  'TeamMateCompletionDeliveryResult',
  'TurnSettledSignal',
];

/** Parse the names re-exported by every `export type { ... } from '...'` block. */
function rootExportNames(): string[] {
  const source = readFileSync(indexFile, 'utf8');
  const names = new Set<string>();
  const block = /export\s+type\s+\{([^}]*)\}\s+from/g;
  let match: RegExpExecArray | null;
  while ((match = block.exec(source)) !== null) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim();
      if (name !== '') names.add(name);
    }
  }
  return [...names].sort();
}

describe('dreamux-types root export surface', () => {
  it('matches the reviewed allowlist exactly (no casual widening)', () => {
    expect(rootExportNames()).toEqual([...ALLOWLIST].sort());
  });

  it('re-exports only types (declaration-only: no value exports)', () => {
    const source = readFileSync(indexFile, 'utf8');
    // Every re-export block must be `export type {`, never a value `export {`.
    expect(/\bexport\s+\{/.test(source.replace(/export\s+type\s+\{/g, ''))).toBe(
      false,
    );
  });
});
