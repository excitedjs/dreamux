/**
 * Epic #209 package-boundary validation guards (decision record
 * `.agents/tasks/architecture/npm-package-split/requirement.md` (npm-package-split record) §Validation
 * Guards). These are repo-wide regression catchers for package-split invariants
 * that are otherwise only "currently true" by inspection:
 *
 * - the Feishu/Lark SDK stays owned by exactly one package
 *   (`@excitedjs/feishu-transport`);
 * - a default `@excitedjs/dreamux` install still bundles the built-in provider
 *   packages (the runtime + channel builtins) as dependencies;
 * - provider/type packages never depend on `@excitedjs/dreamux` core.
 *
 * The per-package `import-boundary.test.ts` files already guard each provider's
 * own `src/` (no `@excitedjs/dreamux` import, no relative escape, and — for the
 * Feishu channel — no direct SDK import). These guards add the reciprocal,
 * repo-wide assertions: the SDK has a single owner across ALL packages, and the
 * package *manifests* (not just source imports) keep the dependency direction.
 *
 * They read `rush.json` + manifests and scan package `src/` on disk rather than
 * importing, so a boundary regression fails loud at the manifest/import layer.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// packages/dreamux/tests -> repo root
const repoRoot = join(here, '..', '..', '..');

interface RushProject {
  packageName: string;
  projectFolder: string;
}

/**
 * Anchor the guards to rush's canonical project list so a newly-added package is
 * scanned automatically rather than silently escaping the guard. rush.json is
 * JSONC (comments + trailing commas), so pair the fields with a tolerant regex
 * instead of JSON.parse.
 */
function rushProjects(): RushProject[] {
  const raw = readFileSync(join(repoRoot, 'rush.json'), 'utf8');
  const re =
    /"packageName":\s*"([^"]+)"[\s\S]*?"projectFolder":\s*"([^"]+)"/g;
  const out: RushProject[] = [];
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    out.push({ packageName: m[1]!, projectFolder: m[2]! });
  }
  return out;
}

function readManifest(projectFolder: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(repoRoot, projectFolder, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
}

function walkTs(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const LARK_SDK_IMPORT = /from\s+['"]@larksuiteoapi\//;
const CORE_PROVIDER_PACKAGE_IMPORT =
  /from\s+['"]@excitedjs\/(?:agent-runtime-codex|agent-runtime-claude-code|feishu-channel|feishu-transport)(?:['"/]|$)|import\s*\(\s*['"]@excitedjs\/(?:agent-runtime-codex|agent-runtime-claude-code|feishu-channel|feishu-transport)(?:['"/]|$)/;
const CORE_PROVIDER_FACTORY_CALL =
  /\b(?:createCodexAgentRuntimeProvider|createClaudeCodeAgentRuntimeProvider|createFeishuChannelProvider)\s*\(|\bnew\s+(?:CodexRuntime|ClaudeCodeRuntime|FeishuChannelSession)\b/;
const projects = rushProjects();

describe('epic #209 package-boundary guards', () => {
  it('discovers the rush project set (sanity)', () => {
    // If this drops to a stub, the guards below would scan nothing — keep it
    // honest by asserting the real monorepo shape is present.
    const names = projects.map((p) => p.packageName);
    expect(names).toContain('@excitedjs/dreamux');
    expect(names).toContain('@excitedjs/feishu-transport');
    expect(names.length).toBeGreaterThanOrEqual(6);
  });

  it('the Feishu/Lark SDK is imported by exactly one package (@excitedjs/feishu-transport)', () => {
    const owners = new Set<string>();
    for (const project of projects) {
      const files = walkTs(join(repoRoot, project.projectFolder, 'src'));
      const importsSdk = files.some((file) =>
        LARK_SDK_IMPORT.test(readFileSync(file, 'utf8')),
      );
      if (importsSdk) owners.add(project.packageName);
    }
    expect([...owners]).toEqual(['@excitedjs/feishu-transport']);
  });

  it('a default @excitedjs/dreamux install bundles the built-in provider packages', () => {
    const dreamux = projects.find((p) => p.packageName === '@excitedjs/dreamux');
    expect(dreamux).toBeDefined();
    const deps = (readManifest(dreamux!.projectFolder).dependencies ??
      {}) as Record<string, string>;
    // The built-in runtime + channel packages must ship as default dependencies
    // so an out-of-the-box install retains builtin:codex / builtin:claude-code /
    // builtin:feishu (issue #209 acceptance: "a default install still includes
    // the builtin runtime packages").
    for (const builtin of [
      '@excitedjs/agent-runtime-codex',
      '@excitedjs/agent-runtime-claude-code',
      '@excitedjs/feishu-channel',
    ]) {
      expect(deps).toHaveProperty(builtin);
    }
  });

  it('provider and type packages never depend on @excitedjs/dreamux core', () => {
    const providerPackages = [
      '@excitedjs/dreamux-types',
      '@excitedjs/feishu-transport',
      '@excitedjs/feishu-channel',
      '@excitedjs/agent-runtime-codex',
      '@excitedjs/agent-runtime-claude-code',
    ];
    for (const name of providerPackages) {
      const project = projects.find((p) => p.packageName === name);
      expect(project, `${name} present in rush.json`).toBeDefined();
      const manifest = readManifest(project!.projectFolder);
      for (const field of [
        'dependencies',
        'peerDependencies',
        'optionalDependencies',
      ] as const) {
        const block = (manifest[field] ?? {}) as Record<string, string>;
        expect(
          Object.prototype.hasOwnProperty.call(block, '@excitedjs/dreamux'),
          `${name} must not list @excitedjs/dreamux in ${field}`,
        ).toBe(false);
      }
    }
  });

  it('core source does not import built-in provider implementation packages', () => {
    const coreSrc = join(repoRoot, 'packages/dreamux/src');
    const offenders = walkTs(coreSrc).filter((file) =>
      CORE_PROVIDER_PACKAGE_IMPORT.test(readFileSync(file, 'utf8')),
    );
    expect(
      offenders.map((file) => file.slice(repoRoot.length + 1)),
    ).toEqual([]);
  });

  it('core source does not call provider-specific factories or classes directly', () => {
    const coreSrc = join(repoRoot, 'packages/dreamux/src');
    const offenders = walkTs(coreSrc).filter((file) =>
      CORE_PROVIDER_FACTORY_CALL.test(readFileSync(file, 'utf8')),
    );
    expect(
      offenders.map((file) => file.slice(repoRoot.length + 1)),
    ).toEqual([]);
  });

  it('core has no provider-specific runtime/channel adapter source tree', () => {
    for (const removedPath of [
      'packages/dreamux/src/agent-runtime/builtin',
      'packages/dreamux/src/channel/feishu',
      'packages/dreamux/src/channel/feishu-channel.ts',
      'packages/dreamux/src/channel/feishu-mcp-surface.ts',
      'packages/dreamux/src/channel/bot.ts',
    ]) {
      expect(existsSync(join(repoRoot, removedPath)), removedPath).toBe(false);
    }
  });
});

describe('no package ships a dev-tool runtime dependency', () => {
  it('no manifest\'s runtime "dependencies" names tsx or ts-node (bin launchers run compiled dist with plain node)', () => {
    const offenders: string[] = [];
    for (const project of projects) {
      const deps = (readManifest(project.projectFolder).dependencies ??
        {}) as Record<string, string>;
      for (const name of Object.keys(deps)) {
        if (/^(tsx|ts-node)$/.test(name)) {
          offenders.push(`${project.packageName}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('dreamux-types stays declaration-only with no runtime dependency', () => {
  const project = projects.find((p) => p.packageName === '@excitedjs/dreamux-types')!;
  const manifest = readManifest(project.projectFolder);

  it('has no runtime "dependencies" field at all', () => {
    expect(manifest['dependencies']).toBeUndefined();
  });

  it('publishes only declaration files (no "import"/"default" export condition)', () => {
    const exportsMap = manifest['exports'] as Record<string, unknown>;
    const root = exportsMap['.'] as Record<string, unknown>;
    expect(Object.keys(root)).toEqual(['types']);
    expect(root['types']).toBe('./dist/index.d.ts');
  });
});

describe('dreamux-utils depends on dreamux-types only, never on @excitedjs/dreamux core', () => {
  it('runtime "dependencies" is exactly { "@excitedjs/dreamux-types": "workspace:*" }', () => {
    const project = projects.find((p) => p.packageName === '@excitedjs/dreamux-utils')!;
    const manifest = readManifest(project.projectFolder);
    const deps = manifest['dependencies'] as Record<string, string>;
    expect(deps).toEqual({ '@excitedjs/dreamux-types': 'workspace:*' });
  });
});

describe('each package\'s public exports map is an intentional, pinned surface', () => {
  // A new subpath export or a widened export condition is a deliberate,
  // reviewed decision, not something that should be able to happen as a side
  // effect of an unrelated change. Pinned to the CURRENT shape observed in
  // every consumer package's package.json.
  const expectedExportKeys: Record<string, string[]> = {
    '@excitedjs/dreamux-types': ['.'],
    '@excitedjs/dreamux-utils': ['.'],
    '@excitedjs/agent-runtime-codex': ['.', './config'],
    '@excitedjs/agent-runtime-claude-code': ['.', './config'],
    '@excitedjs/feishu-channel': ['.'],
    '@excitedjs/feishu-transport': ['.'],
  };

  it.each(Object.entries(expectedExportKeys))(
    '%s exports exactly %j',
    (packageName, expectedKeys) => {
      const project = projects.find((p) => p.packageName === packageName)!;
      const manifest = readManifest(project.projectFolder);
      const exportsMap = (manifest['exports'] ?? {}) as Record<string, unknown>;
      expect(Object.keys(exportsMap).sort()).toEqual([...expectedKeys].sort());
    },
  );
});

describe('each package\'s index.ts re-export set is an intentional, pinned surface', () => {
  /**
   * Extracts every name a package's barrel makes public: named identifiers
   * from `export { a, type B, c as d } from '...'` blocks (the alias, i.e.
   * the name actually exposed) plus bare `export const/function/class/enum`
   * declarations. Comments are stripped first so a docstring mentioning a
   * removed or historical name never inflates the surface.
   *
   * Deliberately does NOT resolve `export * from './module.js'` re-exports
   * (dreamux-utils' barrel shape) — that would require compiling every
   * transitive module. dreamux-utils is instead pinned by its re-exported
   * MODULE list, one line down.
   */
  function namedExports(src: string): string[] {
    const clean = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const names = new Set<string>();
    const braceRe = /export\s+(?:type\s+)?\{([^}]*)\}/g;
    for (let m = braceRe.exec(clean); m !== null; m = braceRe.exec(clean)) {
      for (let part of m[1]!.split(',')) {
        part = part.trim();
        if (part === '') continue;
        if (part.startsWith('type ')) part = part.slice(5).trim();
        const asIdx = part.indexOf(' as ');
        names.add(asIdx >= 0 ? part.slice(asIdx + 4).trim() : part);
      }
    }
    const bareRe = /export\s+(?:const|function|class|enum)\s+([A-Za-z0-9_$]+)/g;
    for (let m = bareRe.exec(clean); m !== null; m = bareRe.exec(clean)) {
      names.add(m[1]!);
    }
    return [...names].sort();
  }

  it('dreamux-utils re-exports exactly this pinned set of internal modules (star-export barrel)', () => {
    const src = readFileSync(
      join(repoRoot, 'packages/dreamux-utils/src/index.ts'),
      'utf8',
    );
    const modules = [...src.matchAll(/export \* from '(\.\/[a-z-]+\.js)';/g)].map(
      (m) => m[1]!,
    );
    expect(modules.sort()).toEqual(
      [
        './activity-scan.js',
        './completion-body.js',
        './config-validate.js',
        './fs.js',
        './json-invoke.js',
        './os.js',
        './runtime-state-fence.js',
        './socket-budget.js',
        './supervised-child.js',
        './unsupported-feature.js',
      ].sort(),
    );
  });

  it("dreamux-types index.ts exports exactly the pinned name set (the neutral contract's full public surface)", () => {
    const src = readFileSync(
      join(repoRoot, 'packages/dreamux-types/src/index.ts'),
      'utf8',
    );
    expect(namedExports(src)).toEqual(
      [
        'AgentActivityError',
        'AgentActivityPage',
        'AgentActivityQuery',
        'AgentActivityReadContext',
        'AgentActivityRecord',
        'AgentRuntime',
        'AgentRuntimeActivitySink',
        'AgentRuntimeBinCheck',
        'AgentRuntimeConfigCapability',
        'AgentRuntimeCreateContext',
        'AgentRuntimeDiagnosticCapability',
        'AgentRuntimeDiagnosticContext',
        'AgentRuntimeDiagnosticResult',
        'AgentRuntimeDiagnosticRunner',
        'AgentRuntimeIdentity',
        'AgentRuntimeLogger',
        'AgentRuntimeMcpServer',
        'AgentRuntimeNativeTurnSink',
        'AgentRuntimeOnboardCapability',
        'AgentRuntimePathContext',
        'AgentRuntimeProvider',
        'AgentRuntimeProviderCapabilities',
        'AgentRuntimeProviderConfigReadContext',
        'AgentRuntimeProviderDescriptor',
        'AgentRuntimeProviderFactory',
        'AgentRuntimeSkillSource',
        'AgentRuntimeStartOutcome',
        'AgentRuntimeStateLeaseRevokedError',
        'AgentRuntimeStateSink',
        'AgentRuntimeStateUpdate',
        'AgentRuntimeStatus',
        'AgentRuntimeSubmissionInput',
        'AgentRuntimeSystemPrompt',
        'BuiltinProviderRef',
        'ChannelBinCheck',
        'ChannelCommandError',
        'ChannelCommandRetryableErrorCode',
        'ChannelConfigCapability',
        'ChannelConfigContext',
        'ChannelCoreEvent',
        'ChannelCorePort',
        'ChannelDiagnosticCapability',
        'ChannelDiagnosticContext',
        'ChannelDiagnosticResult',
        'ChannelDiagnosticRunner',
        'ChannelEventSource',
        'ChannelEventSubscription',
        'ChannelIdentityCapability',
        'ChannelInstance',
        'ChannelMcpCall',
        'ChannelMcpCallContext',
        'ChannelMcpCaller',
        'ChannelMcpCapability',
        'ChannelMcpToolAnnotations',
        'ChannelMcpToolDescriptor',
        'ChannelMcpToolIcon',
        'ChannelMcpToolOutcome',
        'ChannelMcpToolRegistration',
        'ChannelOnboardCapability',
        'ChannelProvider',
        'ChannelProviderDescriptor',
        'ChannelProviderFactory',
        'ChannelSession',
        'ChannelSessionCreateContext',
        'ChannelSessionMcpCapability',
        'CoreCommandContext',
        'CoreCommandDefinition',
        'CoreCommandRegistry',
        'CoreCommandSource',
        'DreamuxEnvironment',
        'DreamuxLogger',
        'JsonInvokeResult',
        'JsonInvoker',
        'JsonSchema',
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
        'RegisteredProvider',
        'RuntimeActivity',
        'RuntimeActivityEvent',
        'RuntimeAdmission',
        'RuntimeCompletion',
        'RuntimeNativeTurnEnd',
        'RuntimeSubmission',
        'RuntimeSubmissionSettlement',
        'RuntimeToolAction',
        'TeamContainedRole',
        'TeamCreateCommand',
        'TeamCreateRepoRequest',
        'TeamCreateResult',
        'TeamStateEvent',
        'TeamStateTeammateSummary',
        'TeamSubmitCommand',
        'TeamSubmitResult',
        'TeammateRole',
        'TeammateNativeTurnEndedEvent',
        'TeammateStateEvent',
        'TeammateStatus',
        'TeammateTurnMessageEvent',
        'TeammateTurnScope',
        'TeammateTurnSettledEvent',
        'TeammateTurnSubmittedEvent',
        'TeammateTurnToolCallEvent',
      ].sort(),
    );
  });

  it('agent-runtime-codex index.ts exports exactly the pinned name set', () => {
    const src = readFileSync(
      join(repoRoot, 'packages/agent-runtime/codex/src/index.ts'),
      'utf8',
    );
    expect(namedExports(src)).toEqual(
      [
        'ALLOWED_APPROVAL_POLICIES',
        'ALLOWED_SANDBOX_MODES',
        'BUILTIN_CODEX_PROVIDER_REF',
        'CODEX_AGENT_RUNTIME_CAPABILITIES',
        'CodexAgentRuntimeProviderOptions',
        'CodexProcess',
        'CodexProcessExit',
        'CodexProcessExitHandler',
        'CodexProcessOptions',
        'CodexWsClient',
        'CodexWsClientOptions',
        'DEFAULT_APPROVAL_POLICY',
        'DEFAULT_CODEX_BIN',
        'DEFAULT_CODEX_TURN_TIMEOUT_MS',
        'DEFAULT_INITIALIZE_TIMEOUT_MS',
        'DEFAULT_SANDBOX_MODE',
        'DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES',
        'DispatcherCodexConfig',
        'DispatcherCodexHomeDoctor',
        'DispatcherCodexHomeDoctorContext',
        'DispatcherCodexHomeDoctorResult',
        'MIN_CODEX_VERSION',
        'NotificationHandler',
        'ParsedCodexArgs',
        'ServerNotification',
        'ServerRequest',
        'ThreadStartResponse',
        'TurnStartResponse',
        'assertDispatcherCodexHomeReady',
        'codexAgentRuntimeDiagnostic',
        'codexArgsFromConfig',
        'codexArgsToCli',
        'codexMcpServerArgs',
        'codexRuntimeArgsForMcpServers',
        'codexSystemPromptReplace',
        'codexVersionSatisfies',
        'createCodexAgentRuntimeProvider',
        'default',
        'defaultDispatcherCodexConfig',
        'dispatcherCodexConfig',
        'dispatcherCodexConfigPath',
        'dispatcherCodexHome',
        'dispatcherCodexHomeDoctorContext',
        'formatDispatcherCodexHomeErrors',
        'operatorCodexHome',
        'parseCodexArgs',
        'parseCodexVersion',
        'performInitializeHandshake',
        'readDispatcherCodexConfig',
        'resolveCodexBinPath',
        'validateDispatcherCodexHome',
      ].sort(),
    );
  });

  it('agent-runtime-claude-code index.ts exports exactly the pinned name set', () => {
    const src = readFileSync(
      join(repoRoot, 'packages/agent-runtime/claude-code/src/index.ts'),
      'utf8',
    );
    expect(namedExports(src)).toEqual(
      [
        'ALLOWED_CLAUDE_CODE_PERMISSION_MODES',
        'BUILTIN_CLAUDE_CODE_PROVIDER_REF',
        'CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES',
        'ClaudeCodeAgentRuntimeProviderOptions',
        'ClaudeCodeMcpConfig',
        'ClaudeCodeResidentArgsInput',
        'ClaudeCodeRuntimeDeps',
        'ClaudeCodeSession',
        'ClaudeCodeSessionFactory',
        'ClaudeCodeSessionSpec',
        'ClaudeCodeStreamRpc',
        'ClaudeCodeStreamRpcOptions',
        'DEFAULT_CLAUDE_CODE_BIN',
        'DEFAULT_CLAUDE_CODE_TURN_TIMEOUT_MS',
        'DispatcherClaudeCodeConfig',
        'JsonObject',
        'LineBuffer',
        'ParsedLine',
        'ResultEnvelope',
        'TurnAggregator',
        'TurnOutcome',
        'TurnSubmitOptions',
        'assistantText',
        'buildCanUseToolAllow',
        'buildControlAck',
        'buildRemoteControlEnable',
        'buildUserMessage',
        'claudeCodeAgentRuntimeDiagnostic',
        'claudeCodeMcpConfig',
        'claudeCodeResidentArgs',
        'claudeCodeSkillAddDirArgs',
        'createClaudeCodeAgentRuntimeProvider',
        'createDefaultClaudeCodeSession',
        'default',
        'defaultDispatcherClaudeCodeConfig',
        'dispatcherClaudeCodeConfig',
        'parseLine',
        'readDispatcherClaudeCodeConfig',
        'stringifyClaudeCodeMcpConfig',
      ].sort(),
    );
  });

  it('feishu-channel index.ts exports exactly the pinned name set', () => {
    const src = readFileSync(
      join(repoRoot, 'packages/channel/feishu-channel/src/index.ts'),
      'utf8',
    );
    expect(namedExports(src)).toEqual(
      [
        'BUILTIN_FEISHU_PROVIDER_REF',
        'CHANNEL_REMINDER',
        'ChannelLogger',
        'ChatBotsListing',
        'CreateBotOptions',
        'CreateFeishuChannelProviderOptions',
        'DREAMUX_ACTION_KEY',
        'DREAMUX_PAIRING_CARD_ACTION',
        'DREAMUX_PAIRING_TOKEN_KEY',
        'DispatcherAccessState',
        'FEISHU_ROUTING_DOCUMENT_VERSION',
        'FEISHU_SKILL_FALLBACK_NOTE',
        'FEISHU_TOOLS',
        'FeishuBindingRecord',
        'FeishuBindingView',
        'FeishuBot',
        'FeishuCardActionEvent',
        'FeishuCardActionResponse',
        'FeishuChannelConfig',
        'FeishuChannelSession',
        'FeishuChannelSessionOptions',
        'FeishuInboundDelivery',
        'FeishuInboundEvent',
        'FeishuListChatBotsResult',
        'FeishuRouting',
        'FeishuRoutingDocument',
        'FeishuRoutingPlan',
        'FeishuRoutingStore',
        'FeishuSpaceRecord',
        'FeishuSubmission',
        'FeishuSubmitOutcome',
        'FeishuTarget',
        'FeishuTargetKind',
        'FeishuTeamSubmitter',
        'FeishuToolContext',
        'FeishuToolDef',
        'FeishuToolResult',
        'FeishuToolSession',
        'FormatFeishuMessageOptions',
        'FormatFeishuMessageResult',
        'FormattedFeishuAttachment',
        'PeerBot',
        'TRUST_DOMAIN_WARNING',
        'WireChatBot',
        'buildPairingApprovalCard',
        'buildPairingSuccessCard',
        'channelOutboundToFeishuTarget',
        'chatTarget',
        'createFeishuBot',
        'createFeishuChannelProvider',
        'createFeishuSessionMcp',
        'default',
        'defaultDispatcherAccessState',
        'describeTarget',
        'dreamuxFeishuGate',
        'feishuToolRegistrations',
        'feishuToolsFor',
        'findFeishuTool',
        'formatFeishuCreateTime',
        'formatFeishuMessageForRuntime',
        'listChatBots',
        'loadChatBots',
        'loadDispatcherAccess',
        'rawCardActionResponse',
        'routingDocumentFilename',
        'saveDispatcherAccess',
        'targetKey',
        'toWireChatBot',
        'topicTarget',
      ].sort(),
    );
  });

  it('feishu-transport index.ts exports exactly the pinned name set', () => {
    const src = readFileSync(
      join(repoRoot, 'packages/channel/feishu-transport/src/index.ts'),
      'utf8',
    );
    expect(namedExports(src)).toEqual(
      [
        'BOT_MEMBER_ADDED_EVENT_TYPE',
        'CELL_MAX_BYTES',
        'ChannelInbound',
        'DOC_COMMENT_EVENT_TYPE',
        'FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER',
        'FEISHU_CARD_CONTENT_SAFE_BYTES',
        'FEISHU_CARD_ELEMENT_HARD_CAP',
        'FEISHU_CARD_REQUEST_LIMIT_BYTES',
        'FEISHU_COT_APPEND_MAX_EVENTS',
        'FEISHU_TRANSPORT_PACKAGE',
        'FeishuAppOwnerIdentity',
        'FeishuBotMemberAddedEvent',
        'FeishuChatMode',
        'FeishuCommentEvent',
        'FeishuCotApiError',
        'FeishuCotAppendInput',
        'FeishuCotClient',
        'FeishuCotClientOptions',
        'FeishuCotCompleteInput',
        'FeishuCotCompleteReason',
        'FeishuCotCreateInput',
        'FeishuCotCreateResult',
        'FeishuCotEventInput',
        'FeishuCreateGroupInput',
        'FeishuCreateGroupResult',
        'FeishuCredentials',
        'FeishuDocComment',
        'FeishuDocCommentReply',
        'FeishuDocMeta',
        'FeishuInviteMembersInput',
        'FeishuInviteMembersResult',
        'FeishuMessageReadItem',
        'FeishuMessageReadMode',
        'FeishuMessageReadRequest',
        'FeishuMessageReadResponse',
        'FeishuMessageReader',
        'FeishuMessageResourceFetcher',
        'FeishuMessageResourceRequest',
        'FeishuMessageResourceResponse',
        'FeishuMessageResourceType',
        'FeishuSendOptions',
        'FeishuSendResult',
        'FeishuTransport',
        'FeishuTransportOptions',
        'FeishuWebSocketRegistration',
        'InboundContentPart',
        'InboundMessage',
        'InboundResource',
        'InboundResourceType',
        'InboundRoutes',
        'Mention',
        'OutboundTarget',
        'ParsedInbound',
        'RenderedCard',
        'RouteHandler',
        'TransportLogger',
        'applyMentions',
        'asString',
        'cardContentBytes',
        'cardToContent',
        'commentFromBatchQuery',
        'createFeishuCotClient',
        'createFeishuTransport',
        'extractPostText',
        'isBotMentioned',
        'isBotSenderType',
        'isRecord',
        'mentionName',
        'mergeInteractiveInbound',
        'narrowMetaFromEvent',
        'normalizeBotMemberAddedEvent',
        'normalizeCommentEvent',
        'parseInbound',
        'renderMarkdownToCards',
        'splitMarkdownByBytes',
        'textMessageContent',
        'toChannelInbound',
      ].sort(),
    );
  });
});
