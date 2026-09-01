# Archived Decision Records

The standalone `decisions/` tree was dissolved on 2026-09-01 (operator ruling):
task records under [/.agents/tasks/](/.agents/tasks/README.md) are the single
derivation layer, and still-current records were backfilled there as task-form
history. The records below were already historical or superseded in fact at
dissolution time, so they were archived as-is with a status banner. Original
content is preserved verbatim.

| Record | Current pointer |
|---|---|
| [Agent Runtime providers](agent-runtime-provider.md) | Superseded in contract shape by the minimize-provider-boundaries refactor (#350); the providerization direction stands. Current seam: [/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/final.md](/.agents/tasks/architecture/minimize-provider-boundaries/technical-design/final.md) §1. |
| [Channel plugin seam and built-in Feishu channel](channel-provider.md) | Historical channel-provider boundary; superseded by the package split (now backfilled at [/.agents/tasks/architecture/npm-package-split/requirement.md](/.agents/tasks/architecture/npm-package-split/requirement.md)) and by #350's Channel seam. |
| [Dispatcher tm Boundary](dispatcher-tm-boundary.md) | Superseded via server-hosted-teammate, then provider-architecture-realignment, and finally the #350 minimal seam. Final destination: [/.agents/tasks/architecture/minimize-provider-boundaries/](/.agents/tasks/architecture/minimize-provider-boundaries/README.md). |
| [Dispatcher tm packaging](dispatcher-tm-packaging.md) | Superseded by MCP-only workflow skills and removal of the tm package surface. |
| [Server-hosted TeamMate](server-hosted-teammate.md) | Superseded for current implementation by provider-architecture-realignment and later #350. Final destination: [/.agents/tasks/architecture/minimize-provider-boundaries/](/.agents/tasks/architecture/minimize-provider-boundaries/README.md). |
| [Global config in `~/.dreamux/config.json`](global-config-dir.md) | Superseded by the state/config domain pages and providerized config decisions. |
| [Global `dreamux` bin owns onboarding and serving](global-bin-onboard-serve.md) | Partly current, partly reversed: the single-bin, onboard, and foreground serve decisions stand; the two service-management decisions were reversed by issue #78 (`dreamux daemon install|uninstall|start|stop|restart` exists); path/state ownership moved to the domains pages. |
| [Agent activity capability (busy/idle) on the neutral runtime contract](agent-activity-capability.md) | Superseded by #350: the whole capability this record decided (one optional `waitIdle` method) was deleted, and the scheduler asks no idle question (`/packages/dreamux/src/service/scheduler/types.ts`). |
| [Channel-scoped collaboration operations and core events](channel-scoped-collaboration-and-core-events.md) | Largely superseded by #350: the Core Collaboration Space container and the ChannelRoutes capabilities (ensureCollaborationTarget, deliverExact, targetLifecycle) were deleted; only the dispatcher-scoped core event source survives as `ChannelEventSource`. |
| [Feishu binding notification events](feishu-binding-notification-events.md) | Superseded in mechanism by #350: the binding store moved into the Channel and the `binding.*` core event kinds do not exist (`removed-surfaces.test.ts` locks this); the Feishu notification cards survive as Channel-internal behavior. |
| [Dispatcher-local aggregate and TeammateRoster](dispatcher-local-aggregate.md) | The aggregate direction stands; the `TeammateRoster` shape was superseded by the service topology refactor (`TeammateCollection`) and later #350. |
| [Issue 110 Epic closure check](issue-110-epic-closure.md) | Historical point-in-time Phase 1 closure checklist; several checks (npm refs reserved-only, `dispatchers[].runtime`, the TeamMate task ledger) no longer describe the system. |
| [Dispatcher Agent Entity Isomorphism](dispatcher-lazy-start-isomorphic.md) | Direction implemented (PR #282); most of its Required End State list was overtaken by stronger #350 deletions (`ChannelRoutes.deliver`, `channelInput`, `team_member`). |
