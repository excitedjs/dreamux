# Builtin Skills Tasks

## Scope

- Bundled Dreamux skills shipped in the npm package: their routing, references, and model-facing contracts.

## Code signals

| Area | Current code signal |
| --- | --- |
| Bundled skill sources | `packages/dreamux/skills` |
| Bundled skill root resolution | `packages/dreamux/src/platform/paths.ts` |
| Runtime injection | `packages/dreamux/src/service/dispatcher-service/agent.ts` |

## Child Scopes

## Tasks
- [Adopt the lean managed-daemon self-upgrade SOP](/.agents/tasks/builtin-skills/adopt-lean-self-upgrade-sop/README.md) — `done`: Replace the unrunnable staged/independent-operator self-upgrade SOP with the lean four-step procedure, and realign every knowledge owner that documents the old contract
