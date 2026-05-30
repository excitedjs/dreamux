# @excitedjs/feishu-transport

Shared **Feishu platform-I/O core** for the dreamux + claudemux channel layers.
The single place that imports the Feishu SDK.

> **Status: PR0 scaffold.** No business logic yet — this PR establishes the
> package skeleton, build, and rush wiring. Platform I/O and policy are ported
> from claudemux (the source of truth) in PR1. See
> [issue #25](https://github.com/excitedjs/dreamux/issues/25).

## Scope (when filled in by PR1+)

- **transport** — connect / receive / send / `addReaction` / `removeReaction` /
  `editText` / `fetchDocComment` / `fetchDocMeta` / bot open_id resolution /
  auth. (react/edit/doc-fetch all bind the lark SDK, so they live here even
  though dreamux leaves them dormant — see issue #25 §7.1.)
- **render** — markdown → Feishu v2 card (incl. inline `<@open_id>` parsing).
- **parse** — Feishu message content → text (incl. `interactive`).
- **policy** — stateless `gate()` / pairing-code / `pruneExpiredPending`, plus
  the `AccessStore` interface (each host implements its own store).

## Engineering rules this package honors

- Ships compiled `dist/` (`tsc`), **no `tsx` runtime dependency**.
- Consumed as a **published, version-pinned package** by both repos; the two
  hosts never depend on each other.
- Built via rush in topological order (`rush build` builds this before any
  dependent).

## Build / test

Built and tested through the monorepo (rush) path — the only supported install
path (see [decision 0006](../../../.agents/decisions/0006-install-model.md)).
From the repo root:

```sh
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
```
