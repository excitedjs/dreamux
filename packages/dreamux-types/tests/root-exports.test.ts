/**
 * Root-export allowlist guard (issue #209 overexposure audit, section B).
 *
 * `@excitedjs/dreamux-types` publishes only its package root (the `exports` map
 * exposes `.` → `dist/index.d.ts` and nothing deeper). So the set of names
 * re-exported by `src/index.ts` IS the public API an external provider author
 * can name. This test pins that set to an explicit allowlist so a later slice
 * cannot casually change the surface — adding or removing a root export now
 * requires updating this list, which is the deliberate review checkpoint.
 *
 * Contract: the root aggregates EVERY public type from the source modules, so
 * the allowlist below equals the full set of `export interface`/`export type`
 * names under `src/`. The package is type-only, so a type reached only
 * contextually today (e.g. `AgentRuntimeDiagnosticContext` as a param of the
 * `AgentRuntimeDiagnostic` methods, `ChannelSender` on `ChannelInboundEnvelope`,
 * `AgentRuntimeResumeCapability` / `AgentRuntimeResumeCheckpoint` on the
 * capability/checkpoint shapes) is still re-exported so a provider author can
 * name a shape they legitimately depend on — hiding it buys nothing at runtime. The
 * expanded `tests/fixtures/external-provider.ts` separately proves the surface
 * is *sufficient* to author a full provider importing from the root only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexFile = join(here, '..', 'src', 'index.ts');

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

/** Every `export interface`/`export type` name declared across the source modules. */
function sourceModulePublicTypeNames(): string[] {
  const srcDir = join(here, '..', 'src');
  const names = new Set<string>();
  const decl = /export\s+(?:interface|type)\s+([A-Za-z0-9_]+)/g;
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith('.ts') || file === 'index.ts') continue;
    const source = readFileSync(join(srcDir, file), 'utf8');
    let match: RegExpExecArray | null;
    while ((match = decl.exec(source)) !== null) names.add(match[1]);
  }
  return [...names].sort();
}

/** The intended public root API. Keep sorted; grow only by deliberate review. */
const ALLOWLIST = [
  'AgentRuntime',
  'AgentRuntimeBinCheck',
  'AgentRuntimeCapabilities',
  'AgentRuntimeContextSnapshot',
  'AgentRuntimeCreateContext',
  'AgentRuntimeDiagnostic',
  'AgentRuntimeDiagnosticContext',
  'AgentRuntimeDiagnosticResult',
  'AgentRuntimeDiagnosticRunner',
  'AgentRuntimeIdentity',
  'AgentRuntimeMcpServer',
  'AgentRuntimePathContext',
  'AgentRuntimeProvider',
  'AgentRuntimeProviderConfigReadContext',
  'AgentRuntimeProviderDescriptor',
  'AgentRuntimeProviderFactory',
  'AgentRuntimeResumeCapability',
  'AgentRuntimeResumeCheckpoint',
  'AgentRuntimeSkillSource',
  'AgentRuntimeStateCallbacks',
  'AgentRuntimeStatus',
  'AgentRuntimeStructuredOutputCapability',
  'AgentRuntimeSystemPrompt',
  'AgentRuntimeTextInput',
  'AgentRuntimeTranscriptBlock',
  'AgentRuntimeTranscriptContext',
  'AgentRuntimeTranscriptError',
  'AgentRuntimeTranscriptPage',
  'AgentRuntimeTranscriptQuery',
  'AgentRuntimeTranscriptTurn',
  'BuiltinProviderRef',
  'ChannelAgentStateEvent',
  'ChannelBinCheck',
  'ChannelBindingCollaborationSpaceBoundEvent',
  'ChannelBindingCollaborationSpaceEvent',
  'ChannelBindingCollaborationSpacePolicySnapshot',
  'ChannelBindingCollaborationSpaceUnboundEvent',
  'ChannelBindingEndpointSnapshot',
  'ChannelBindingRouteBoundEvent',
  'ChannelBindingRouteEvent',
  'ChannelBindingRouteOwnerSnapshot',
  'ChannelBindingRouteTeamSnapshot',
  'ChannelBindingRouteUnboundEvent',
  'ChannelCollaborationTargetEnsureInput',
  'ChannelCollaborationTargetEnsureResult',
  'ChannelConfigContext',
  'ChannelConversationScope',
  'ChannelContainer',
  'ChannelCoreEvent',
  'ChannelCoreEventKind',
  'ChannelCoreEventListener',
  'ChannelCoreEventOfKind',
  'ChannelCoreEventSource',
  'ChannelCoreEventSubscription',
  'ChannelDiagnostic',
  'ChannelDiagnosticContext',
  'ChannelDiagnosticResult',
  'ChannelDiagnosticRunner',
  'ChannelExactDeliveryInput',
  'ChannelExactDeliveryResult',
  'ChannelInboundEnvelope',
  'ChannelOrigin',
  'ChannelMessageTargetCheck',
  'ChannelProvider',
  'ChannelProviderDescriptor',
  'ChannelProviderFactory',
  'ChannelReactInput',
  'ChannelReplyInput',
  'ChannelRoutes',
  'ChannelScopedOperationFailureCode',
  'ChannelScopedOperationRejection',
  'ChannelSender',
  'ChannelSession',
  'ChannelSessionCreateContext',
  'ChannelSessionlessToolContext',
  'ChannelTarget',
  'ChannelTargetLifecycleEvent',
  'ChannelTargetLifecycleKind',
  'ChannelTeamAgentRole',
  'ChannelTeamStateEvent',
  'ChannelToolAnnotations',
  'ChannelToolCall',
  'ChannelToolCallerContext',
  'ChannelToolContext',
  'ChannelToolDescriptor',
  'ChannelToolIcon',
  'ChannelTurnMessageEvent',
  'ChannelTurnSettledEvent',
  'ChannelTurnSource',
  'ChannelTurnSubmittedEvent',
  'ChannelTurnToolCallEvent',
  'DreamuxEnvironment',
  'DreamuxLogger',
  'DreamuxManagedRepoRequest',
  'InboundAttachment',
  'InboundDeliveryResult',
  'InboundTurnInput',
  'JsonValue',
  'NpmProviderRef',
  'ProviderBinCheck',
  'ProviderDescriptor',
  'ProviderDiagnosticResult',
  'ProviderDiagnosticRunner',
  'ProviderDiagnosticScope',
  'ProviderFactory',
  'ProviderFactoryContext',
  'ProviderKind',
  'ProviderOnboard',
  'ProviderOnboardConfirmPrompt',
  'ProviderOnboardContext',
  'ProviderOnboardPromptHost',
  'ProviderOnboardSecretPrompt',
  'ProviderOnboardTextPrompt',
  'ProviderRef',
  'ProviderRefSource',
  'RuntimeActivity',
  'RuntimeActivityEvent',
  'RuntimeActivitySink',
  'RuntimeAdmission',
  'RuntimeCompletion',
  'RuntimeSubmission',
  'RuntimeSubmissionSettlement',
  'RuntimeToolAction',
  'UnsupportedAgentRuntimeFeatureError',
];

describe('dreamux-types root export surface', () => {
  it('matches the reviewed allowlist exactly (no casual change)', () => {
    expect(rootExportNames()).toEqual([...ALLOWLIST].sort());
  });

  it('no longer publishes the retired turn-keyed names', () => {
    // The value-keyed contract split `RuntimeTurn` into a submission (one
    // accepted send) and a completion (one native result). Both retired names
    // must stay off the public surface, or an external provider could author
    // against a contract Dreamux no longer honours.
    expect(rootExportNames()).not.toContain('RuntimeTurn');
    expect(rootExportNames()).not.toContain('RuntimeTurnOutcome');
    for (const name of [
      'RuntimeSubmission',
      'RuntimeSubmissionSettlement',
      'RuntimeCompletion',
      'RuntimeActivity',
      'RuntimeActivityEvent',
      'RuntimeActivitySink',
      'RuntimeAdmission',
    ]) {
      expect(rootExportNames()).toContain(name);
    }
  });

  it('aggregates every public type from the source modules (hides nothing)', () => {
    // The contract (issue #209 final review): being type-only is not a reason to
    // hide a public type behind transitive resolution. The root must name every
    // public type declared under src/, so a provider author can import any shape
    // they depend on. A new public type is therefore a deliberate root export.
    expect(rootExportNames()).toEqual(sourceModulePublicTypeNames());
  });

  it('re-exports only types (declaration-only: no value exports)', () => {
    const source = readFileSync(indexFile, 'utf8');
    // Every re-export block must be `export type {`, never a value `export {`.
    expect(/\bexport\s+\{/.test(source.replace(/export\s+type\s+\{/g, ''))).toBe(
      false,
    );
  });
});
