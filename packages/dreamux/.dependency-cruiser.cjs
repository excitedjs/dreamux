'use strict';

/**
 * Import-direction gate for @excitedjs/dreamux's src/ tree. Two rule
 * families, both `severity: 'warn'` for now:
 *
 *   1. A coarse layer order (LAYERS below) - a module in an earlier layer
 *      must not import a module from a later layer ("nothing imports
 *      upward"). Same-layer imports are unrestricted.
 *   2. no-circular, plus a handful of specific same-tier/cross-cutting bans
 *      a generic layer order does not express on its own (see
 *      "namedEdgeRules" below).
 *
 * Warn, not error: a large share of today's real files already cross these
 * boundaries (see the report from a clean run), so failing the build on them
 * now would block unrelated changes on pre-existing code, not on anything a
 * change introduces. Once the codebase actually conforms to this order,
 * raise the affected rules to 'error' so a new violation fails the build
 * instead of only being reported.
 *
 * Two required options, without which this gate would silently miss most of
 * what it exists to catch:
 *   - tsPreCompilationDeps: many of the real cross-layer edges in this
 *     codebase are type-only imports (e.g. an `import type` naming another
 *     layer's class or interface) that TypeScript erases at compile time.
 *     Without this flag dependency-cruiser resolves post-erasure and never
 *     sees them.
 *   - tsConfig: this repo's ESM convention writes relative imports with a
 *     `.js` suffix resolving to a `.ts` file (`import './foo.js'`). Without
 *     pointing dependency-cruiser at tsconfig.json every such import looks
 *     unresolvable and the report is noise instead of real violations.
 */

// Ordered coarse layers, using the real directory names in src/ today. Two
// entries below are file-level splits inside a single directory, not
// whole-directory placements - both were set from a real dependency-cruiser
// run against this file's own layer list, not by eyeballing the source tree:
//
//   - state/dispatcher-store.ts imports config/config.ts and is consumed
//     starting at the service-primitives tier, so it sits there instead of
//     with the directory it's declared in (state/, now this file's only
//     member - dispatcher-id.ts moved to platform/ as a plain file, not a
//     special case, since it had no state-tier dependency of its own).
//   - src/mcp/{catalog,server,failure-text}.ts are the transport-level
//     protocol/validation primitives service/mcp/leases.ts (a different,
//     service-domain "mcp" directory) depends on - foundation-tier.
//     src/mcp/shim.ts is a distinct file: it bridges a stdio MCP client to
//     the admin socket (imports src/admin/client.ts) and is consumed only by
//     cli/commands/mcp.ts, so it sits at the composition tier with admin/
//     and cli/, not beside catalog.ts.
const LAYERS = [
  {
    name: 'platform',
    path: ['^src/platform/'],
  },
  {
    name: 'command',
    path: ['^src/command/'],
  },
  {
    name: 'foundation',
    path: [
      '^src/config/',
      '^src/registry/',
      '^src/plugin/',
      '^src/agent-runtime/',
      '^src/channel/',
      '^src/mcp/(catalog|server|failure-text)\\.ts$',
    ],
  },
  {
    name: 'service-primitives',
    path: [
      '^src/service/worktree/',
      '^src/service/mcp/',
      '^src/service/completion-router/',
      '^src/service/dispatcher-core-events/',
      '^src/service/(submission-sources|name-allocator|dispatcher-workspace|channel-submission)\\.ts$',
      '^src/state/dispatcher-store\\.ts$',
    ],
  },
  {
    name: 'service-mid',
    path: ['^src/service/workflow-service/', '^src/service/scheduler/'],
  },
  {
    // service/agent/ holds the neutral identity/activity/runtime-state
    // stores, the per-entity AgentService, and TeammateCollection in one
    // directory: one physical directory can only occupy one layer, so it
    // takes the highest (outermost) rank of the tiers it merges -
    // service/team/ depends on it (constructing against its outermost file,
    // index.ts's TeammateCollection), never the reverse, so it must sit
    // strictly before the reduced service-team layer below.
    name: 'service-agent',
    path: ['^src/service/agent/'],
  },
  {
    // service/team/ is the sibling directory-merge to service/agent/ above,
    // holding TeamStore, TeamService, and TeamCollection in one directory
    // ordered by R7's declared direction: store -> service -> collection.
    name: 'service-team',
    path: ['^src/service/team/'],
  },
  {
    name: 'service-orchestration',
    path: ['^src/service/dispatcher-service/', '^src/service/channel-service/'],
  },
  {
    name: 'service-dispatchers',
    path: ['^src/service/dispatchers/'],
  },
  {
    name: 'service-barrel',
    path: ['^src/service/index\\.ts$'],
  },
  {
    name: 'composition',
    path: [
      '^src/admin/',
      '^src/cli/',
      '^src/onboard/',
      '^src/daemon/',
      '^src/server/',
      '^src/provider-diagnostics\\.ts$',
      '^src/server-commands\\.ts$',
      '^src/server\\.ts$',
      '^src/mcp/shim\\.ts$',
    ],
  },
];

// One rule per layer boundary: layer[i] must not import anything from
// layer[i+1..]. The last layer needs no rule (nothing comes after it).
const layerOrderRules = LAYERS.slice(0, -1).map((layer, index) => {
  const laterLayers = LAYERS.slice(index + 1);
  return {
    name: `layer-order-${layer.name}`,
    comment:
      `'${layer.name}' is an earlier layer than ` +
      `${laterLayers.map((l) => `'${l.name}'`).join(', ')} and must not ` +
      'import from it or them.',
    severity: 'warn',
    from: { path: layer.path },
    to: { path: laterLayers.flatMap((l) => l.path) },
  };
});

// Specific named edges the layer order above does not, on its own, express
// precisely enough - same-tier bans and a single-importer restriction, not
// "wrong direction" facts. Each one mirrors an existing behavior test's
// contract exactly (scope taken from the test, not widened), so a change
// this gate now reports the same way a change to that test file's source
// text would have.
const namedEdgeRules = [
  {
    name: 'channel-not-to-team-or-teammate',
    comment:
      'Channel decides where a message goes by naming a Team; it must not ' +
      "reach into a Team/TeamMate owner's internals to implement lifecycle " +
      'policy itself (see tests/collection-ownership.test.ts).',
    severity: 'warn',
    from: { path: ['^src/channel/', '^src/service/channel-service/'] },
    to: {
      path: ['^src/service/team/', '^src/service/agent/'],
    },
  },
  {
    // R7's "one declared direction" for the merged service/agent/ directory:
    // store <- service <- collection. Store-tier files never reach into the
    // service or collection tier; service-tier files never reach into the
    // collection tier. Regex groups partition every file the directory holds
    // (the plan's own file map plus service-types.ts and dissolve-members.ts,
    // which the plan's file map table omitted but which still live in one of
    // the three tiers), each anchored with `\.ts$` so a name never
    // prefix-matches a longer sibling (e.g. `service` must not match
    // `service-types`, `mcp` must not match `mcp-tool-descriptors`).
    name: 'service-agent-store-not-to-service-or-collection',
    comment:
      'service/agent/ store-tier files (identity, store, runtime-state, ' +
      'activity, records, requests, runtime-id) must not import the ' +
      'service- or collection-tier files in the same directory.',
    severity: 'warn',
    from: {
      path: '^src/service/agent/(identity|store|runtime-state|activity|records|requests|runtime-id)\\.ts$',
    },
    to: {
      path: '^src/service/agent/(runtime-generation|turn|admission|submission|completion-renderer|factory|service|service-types|index|commands|mcp|mcp-tool-descriptors|system-prompt|errors|types|dissolve-members)\\.ts$',
    },
  },
  {
    name: 'service-agent-service-not-to-collection',
    comment:
      'service/agent/ service-tier files (runtime-generation, turn, ' +
      'admission, submission, completion-renderer, factory, service, ' +
      'service-types) must not import the collection-tier files in the ' +
      'same directory.',
    severity: 'warn',
    from: {
      path: '^src/service/agent/(runtime-generation|turn|admission|submission|completion-renderer|factory|service|service-types)\\.ts$',
    },
    to: {
      path: '^src/service/agent/(index|commands|mcp|mcp-tool-descriptors|system-prompt|errors|types|dissolve-members)\\.ts$',
    },
  },
  {
    // R7's "one declared direction" for the merged service/team/ directory:
    // store <- service <- collection, mirroring service/agent/'s own two
    // rules above. Store-tier files never reach into the service or
    // collection tier; service-tier files never reach into the collection
    // tier. Regex groups partition every file the directory holds, each
    // anchored with `\.ts$` so a name never prefix-matches a longer sibling
    // (e.g. `service` must not match a hypothetical `service-types`).
    name: 'service-team-store-not-to-service-or-collection',
    comment:
      'service/team/ store-tier files (types, requests, create-request, ' +
      'store, errors) must not import the service- or collection-tier ' +
      'files in the same directory.',
    severity: 'warn',
    from: {
      path: '^src/service/team/(types|requests|create-request|store|errors)\\.ts$',
    },
    to: {
      path: '^src/service/team/(roster|leader|completion-targets|closing|team-summary|service|read-model|index|commands|mcp)\\.ts$',
    },
  },
  {
    // Named "core", not "service", so the rule id does not read as a
    // reference to the old team-service/ directory this merge deleted.
    name: 'service-team-core-not-to-collection',
    comment:
      'service/team/ service-tier files (roster, leader, ' +
      'completion-targets, closing, team-summary, service) must not import ' +
      'the collection-tier files in the same directory.',
    severity: 'warn',
    from: {
      path: '^src/service/team/(roster|leader|completion-targets|closing|team-summary|service)\\.ts$',
    },
    to: {
      path: '^src/service/team/(read-model|index|commands|mcp)\\.ts$',
    },
  },
  {
    name: 'workflow-service-not-to-team',
    comment:
      'workflow-service/ only ever gets Team access through the narrow ' +
      'capability it is handed at construction, never by importing ' +
      'service/team/ directly (see tests/workflow-service.test.ts).',
    severity: 'warn',
    from: { path: '^src/service/workflow-service/' },
    to: {
      path: ['^src/service/team/'],
    },
  },
  {
    name: 'channel-service-mcp-delegates-single-importer',
    comment:
      'channelMcpDelegates() (service/channel-service/mcp-delegates.ts) is ' +
      'consumed only by the Dispatcher-agent/TeamLeader role assembly ' +
      '(service/dispatcher-service/mcp-delegates.ts), never the ordinary ' +
      "TeamMate one, so Channel MCP cannot leak into an ordinary TeamMate's " +
      'tool set (see tests/channel-service.test.ts, ' +
      'tests/mcp-delegate-catalog.test.ts).',
    severity: 'warn',
    from: { pathNot: '^src/service/dispatcher-service/mcp-delegates\\.ts$' },
    to: { path: '^src/service/channel-service/mcp-delegates\\.ts$' },
  },
  {
    name: 'types-file-not-to-command',
    comment:
      'A file named types.ts declares data contracts; it must not import ' +
      "command/'s Command-wiring machinery.",
    severity: 'warn',
    from: { path: 'types\\.ts$' },
    to: { path: '^src/command/' },
  },
];

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment:
        'A real import cycle. Revise the two sides so one owns the ' +
        'dependency direction (dependency inversion, or a shared module ' +
        'both can import instead of importing each other).',
      severity: 'warn',
      from: {},
      to: { circular: true },
    },
    ...layerOrderRules,
    ...namedEdgeRules,
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^(tests|dist)/' },
  },
};
