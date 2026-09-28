'use strict';

/**
 * Import-direction gate for @excitedjs/dreamux's src/ tree. Two rule
 * families, both `severity: 'error'`:
 *
 *   1. A coarse layer order (LAYERS below) - a module in an earlier layer
 *      must not import a module from a later layer ("nothing imports
 *      upward"). Same-layer imports are unrestricted.
 *   2. no-circular, plus a handful of specific same-tier/cross-cutting bans
 *      a generic layer order does not express on its own (see
 *      "namedEdgeRules" below).
 *
 * Error, not warn: every real file in `src/` conforms to this order, so a
 * violation this gate reports is always introduced by the change under lint,
 * never inherited from pre-existing code - failing on it blocks nothing but
 * that change. `npm run lint` runs depcruise with `&&`, so a violation fails
 * the whole lint step. An edge that resists a clean fix gets a narrow,
 * explicitly justified named-edge rule at this same `'error'` severity
 * scoped to exactly that edge, not a directory-wide ignore and not a
 * severity drop back to `'warn'`.
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

// Ordered coarse layers, using the real directory names in src/ today.
// Several entries below are file-regex splits inside a single directory, not
// whole-directory placements - all were set from a real dependency-cruiser
// run against this file's own layer list, not by eyeballing the source tree:
//
//   - state/dispatcher-store.ts imports config/config.ts and is consumed
//     starting at the service-primitives tier, so it sits there instead of
//     with the directory it's declared in (state/, now this file's only
//     member - dispatcher-id.ts moved to platform/ as a plain file, not a
//     special case, since it had no state-tier dependency of its own).
//   - src/mcp/{server,launch}.ts are foundation-tier: server.ts is the
//     official-SDK protocol/validation primitive, and launch.ts (the MCP
//     shim's argv/env launch shape, formerly service/mcp/descriptor.ts) has
//     only a platform/ dependency of its own, not a service-domain one.
//     Catalog validation used to live beside them as src/mcp/catalog.ts, but
//     its only production caller is service/mcp/leases.ts's mint-time pass,
//     so it now sits beside that caller as service/mcp/catalog.ts
//     (service-primitives tier); src/mcp/shim.ts, at the composition tier,
//     reaches it there for its own defensive re-validation of wire bytes.
//     src/mcp/shim.ts is a distinct file: it bridges a stdio MCP client to
//     the admin socket (imports src/admin/client.ts) and is consumed only by
//     cli/commands/mcp.ts, so it sits at the composition tier with admin/
//     and cli/, not beside server.ts/launch.ts.
//   - service/agent/ is one directory holding three real tiers (R7's
//     declared direction: store -> service -> collection), and a directory
//     can only be placed by matching one or more file regexes, not by
//     matching itself once - so it gets three regex-scoped entries instead
//     of one. The store tier (identity/store/runtime-state/activity/records/
//     requests/runtime-id/types) is folded directly into service-primitives'
//     own path list rather than given a separate entry: worktree/, mcp/, and
//     dispatcher-core-events/ read it, and it reads nothing outside itself,
//     so same-tier is the accurate relationship, not "earlier". The service
//     tier (runtime-generation/turn/admission/submission/channel-submission/
//     completion-renderer/factory/service/service-types) sits in its own
//     entry between service-primitives and service-mid, because
//     workflow-service/ and scheduler/ construct and type against it
//     (SpawnTeamMateRequest, Turn, TurnAdmission, LockedTeammate,
//     CreateLockedTeammateOptions) - the reverse of what a single merged
//     entry after service-mid could express. The collection tier
//     (index/commands/mcp/system-prompt/errors) keeps the
//     directory's original slot, after service-mid: nothing before it needs
//     TeammateCollection, and agent/mcp.ts genuinely needs
//     workflow-service/mcp.ts's WORKFLOW_TOOL_RECORDS (a real, non-cyclic
//     forward dependency - workflow-service/mcp.ts imports nothing from
//     service/agent/), which is why the collection tier cannot also move
//     ahead of service-mid.
//   - service/scheduler/commands.ts is the one file in that directory
//     needing a later tier than its siblings: a cron job can be Team-scoped,
//     so its Command definitions read service/team/'s TeamsPort and
//     optionalTeamNameParam, which sit at service-team, after service-mid
//     (where the rest of scheduler/ - store/types/index/mcp/errors/
//     cron-validation - stays). Nothing in service/team/ imports
//     scheduler/commands.ts back, so this is a one-directional forward need,
//     not a cycle.
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
      '^src/mcp/(server|launch)\\.ts$',
    ],
  },
  {
    name: 'service-primitives',
    path: [
      '^src/service/worktree/',
      '^src/service/mcp/',
      '^src/service/completion-router/',
      '^src/service/dispatcher-core-events/',
      '^src/service/(submission-sources|name-allocator|dispatcher-workspace)\\.ts$',
      '^src/state/dispatcher-store\\.ts$',
      '^src/service/agent/(identity|store|runtime-state|activity|records|requests|runtime-id|types)\\.ts$',
    ],
  },
  {
    // The middle tier of service/agent/'s own three (see the file-level
    // comment above LAYERS): AgentService plus the submission/turn/admission
    // machinery it is built from. Positioned before service-mid, not after,
    // because workflow-service/ and scheduler/ construct and type against
    // this tier, not the other way around.
    name: 'service-agent-service',
    path: [
      '^src/service/agent/(runtime-generation|turn|admission|submission|channel-submission|completion-renderer|factory|service|service-types)\\.ts$',
    ],
  },
  {
    // scheduler/commands.ts is listed in its own layer below instead of
    // here (same "one file needs a different tier than its siblings" reason
    // as state/dispatcher-store.ts and src/mcp/(server|launch).ts$): a cron
    // job can be Team-scoped, so it reads service/team/'s TeamsPort and
    // optionalTeamNameParam, a later-layer need the rest of scheduler/ does
    // not share.
    name: 'service-mid',
    path: [
      '^src/service/workflow-service/',
      '^src/service/scheduler/(cron-validation|errors|index|mcp|requests|store|types)\\.ts$',
    ],
  },
  {
    // The outermost tier of service/agent/'s own three: TeammateCollection
    // plus its supporting files. Stays after service-mid: agent/mcp.ts
    // genuinely needs workflow-service/mcp.ts's WORKFLOW_TOOL_RECORDS (see
    // the file-level comment above LAYERS), and service/team/ depends on
    // this tier (constructing against its outermost file, index.ts's
    // TeammateCollection), never the reverse, so it must sit strictly before
    // the reduced service-team layer below.
    name: 'service-agent-collection',
    path: [
      '^src/service/agent/(index|commands|mcp|system-prompt|errors)\\.ts$',
    ],
  },
  {
    // service/team/ is the sibling directory-merge to service/agent/ above,
    // holding TeamStore, TeamService, and TeamCollection in one directory
    // ordered by R7's declared direction: store -> service -> collection.
    name: 'service-team',
    path: ['^src/service/team/'],
  },
  {
    // scheduler/commands.ts's own Command definitions, carved out of the
    // service-mid entry above: a cron job can be Team-scoped, so this file
    // (unlike the rest of scheduler/) reads service/team/'s TeamsPort and
    // optionalTeamNameParam and must sit after service-team, not before it.
    name: 'service-scheduler-commands',
    path: ['^src/service/scheduler/commands\\.ts$'],
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
    severity: 'error',
    from: { path: layer.path },
    to: { path: laterLayers.flatMap((l) => l.path) },
  };
});

// Specific named edges the layer order above does not, on its own, express
// precisely enough - same-tier bans (the service/agent/ and service/team/
// store/service/collection direction, R7's declared direction), a
// cross-domain boundary two rules state directly (channel must reach a Team
// only by naming it, workflow-service must reach a Team only through the
// capability it is handed), and a single-file naming convention
// (types-file-not-to-command) - not "wrong direction" facts a coarse layer
// order already captures.
const namedEdgeRules = [
  {
    name: 'channel-not-to-team-or-teammate',
    comment:
      'Channel decides where a message goes by naming a Team; it must not ' +
      "reach into a Team/TeamMate owner's internals to implement lifecycle " +
      'policy itself.',
    severity: 'error',
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
    // (including service-types.ts, which no prose file map named), each
    // anchored with `\.ts$` so a
    // name never prefix-matches a longer sibling (e.g. `service` must not
    // match `service-types`). `types.ts` is in the store tier's own `from`
    // group, not either `to` group: it is store-tier data, so service- and
    // collection-tier files read it freely, the same as any other store-tier
    // file.
    name: 'service-agent-store-not-to-service-or-collection',
    comment:
      'service/agent/ store-tier files (identity, store, runtime-state, ' +
      'activity, records, requests, runtime-id, types) must not import ' +
      'the service- or collection-tier files in the same directory.',
    severity: 'error',
    from: {
      path: '^src/service/agent/(identity|store|runtime-state|activity|records|requests|runtime-id|types)\\.ts$',
    },
    to: {
      path: '^src/service/agent/(runtime-generation|turn|admission|submission|channel-submission|completion-renderer|factory|service|service-types|index|commands|mcp|system-prompt|errors)\\.ts$',
    },
  },
  {
    name: 'service-agent-service-not-to-collection',
    comment:
      'service/agent/ service-tier files (runtime-generation, turn, ' +
      'admission, submission, channel-submission, completion-renderer, ' +
      'factory, service, service-types) must not import the ' +
      'collection-tier files in the same directory.',
    severity: 'error',
    from: {
      path: '^src/service/agent/(runtime-generation|turn|admission|submission|channel-submission|completion-renderer|factory|service|service-types)\\.ts$',
    },
    to: {
      path: '^src/service/agent/(index|commands|mcp|system-prompt|errors)\\.ts$',
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
    severity: 'error',
    from: {
      path: '^src/service/team/(types|requests|create-request|store|errors)\\.ts$',
    },
    to: {
      path: '^src/service/team/(leader|team-summary|service|teams-port|index|commands|mcp)\\.ts$',
    },
  },
  {
    // Named "core", not "service", so the rule id does not read as a
    // reference to the old team-service/ directory this merge deleted.
    name: 'service-team-core-not-to-collection',
    comment:
      'service/team/ service-tier files (leader, team-summary, service, ' +
      'teams-port) must not import the collection-tier files in the same ' +
      'directory.',
    severity: 'error',
    from: {
      path: '^src/service/team/(leader|team-summary|service|teams-port)\\.ts$',
    },
    to: {
      path: '^src/service/team/(index|commands|mcp)\\.ts$',
    },
  },
  {
    name: 'workflow-service-not-to-team',
    comment:
      'workflow-service/ only ever gets Team access through the narrow ' +
      'capability it is handed at construction, never by importing ' +
      'service/team/ directly.',
    severity: 'error',
    from: { path: '^src/service/workflow-service/' },
    to: {
      path: ['^src/service/team/'],
    },
  },
  {
    name: 'types-file-not-to-command',
    comment:
      'A file named types.ts declares data contracts; it must not import ' +
      "command/'s Command-wiring machinery.",
    severity: 'error',
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
      severity: 'error',
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
