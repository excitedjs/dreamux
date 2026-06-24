# Shared base store for versioned JSON documents

- **Status:** Accepted (design); implementation pending
- **Date:** 2026-06-24
- **Affects:** `/packages/dreamux/src/state/`,
  `/packages/dreamux/src/service/channel-binding/`,
  `/packages/dreamux/src/service/team-collection/`,
  `/packages/dreamux/src/service/teammate-collection/`,
  `/packages/dreamux/src/platform/`; any new durable single-document store
- **PR / Issue:** surfaced by the scheduled-tasks design
  ([`.agents/proposals/scheduled-tasks.md`](../proposals/scheduled-tasks.md))

## Context

Adding a `cron-jobs.json` store for scheduled tasks would have been the fifth
copy of the same persistence pattern. Every durable single-document store in
core re-implements it by hand: `readFile` → `isNotFound ⇒ default` →
`JSON.parse` → `version` envelope check → field validation → write =
`mkdir -p` + serialize + (atomic) write + trailing newline.

The duplication has already produced a latent inconsistency: `DispatcherStore`
writes **non-atomically** (`state/dispatcher-store.ts` uses plain `writeFile`),
leaving a torn-write window the other three stores avoid via
`writeFileAtomic`. The corrupt/version policy also drifts per store (warn +
rebuild vs `LegacyStateError` fail-loud). This is exactly the "stitch each case
by hand" glue the repo `CLAUDE.md` "Architecture Discipline" rule targets:
prefer a capability over a re-solved special case.

## Decision

Extract a neutral base — `JsonDocumentStore<TDoc>` in
`/packages/dreamux/src/platform/` (next to `atomic-write.ts` and `fs-errors.ts`,
the existing infra home) — that owns the single versioned-JSON-document
read/write contract, and build new stores on it. Shape:

```ts
class JsonDocumentStore<TDoc> {
  constructor(opts: {
    version: number;
    parse(raw: unknown, ctx: { path: string }): TDoc; // validate; throw on bad shape
    empty(): TDoc;                                     // value when file is absent
    corruptPolicy?: 'fail-loud' | 'warn-rebuild';      // default 'fail-loud'
  });
  read(path: string): Promise<TDoc>;
  write(path: string, doc: TDoc): Promise<void>; // mkdir -p → writeFileAtomic → pretty JSON + "\n" + mode 0600
  assertCurrent(path: string): Promise<void>;    // startup/doctor fail-loud probe
}
```

- The **path stays caller-supplied** (argument), so `platform/paths.ts` remains
  the sole path builder and the base never names a path or a provider field — it
  is pure runtime-neutral infrastructure (principle, not shape).
- Each concrete store keeps its domain methods (`bind`/`resolve`/`list`/…) and
  supplies `version` + `parse` + `empty`.

**Scope boundary (what the base does NOT absorb):**
- The append-only JSONL log (`teammate-collection/turns-store.ts`) — different
  access pattern (append, skip-corrupt-line, streaming read).
- Directory-of-entities blind-scan *listing* (`identity-store.ts`) — only the
  per-document read/write is unified; the dir scan stays in the concrete store.

**Sequencing:** introduce `JsonDocumentStore` carrying `CronJobStore` first;
migrate the four existing stores (`DispatcherStore`, `ChannelBindingStore`,
`TeamStore`, `TeamMateIdentityStore`) onto it in a separate
behavior-preserving PR so the feature and the cross-cutting refactor review
apart. The migration also fixes the non-atomic `DispatcherStore` write.

## Consequences

- **Enforcement / guards:** the base should ship with an executable contract
  test (round-trip, missing-file ⇒ empty, malformed ⇒ policy) mirroring the
  `no-sync-io-gate.test.ts` style. Migrations are behavior-preserving and must
  keep each store's existing version/policy semantics.
- **0.x no-migration policy holds:** `corruptPolicy: 'fail-loud'` is the default
  to match the repo's "old state fails loud, never migrated" rule; a store that
  intentionally rebuilds (recovery state, e.g. dispatcher status) opts into
  `'warn-rebuild'` explicitly.
- **Foot-gun:** the base unifies *mechanism*, not *schema*. Each store still
  owns its `version` and validation; bumping a store's schema is still that
  store's concern and still needs its own fail-loud/rebuild handling.
- **Refactor-robust scoping:** the base is keyed on a behavior (single versioned
  JSON document), not on the current set of stores, so new stores adopt it
  without touching the base.

## Alternatives considered

- **Copy the pattern a fifth time for cron.** Rejected — it is the glue the
  discipline rule forbids and would entrench the atomic-write inconsistency.
- **Base-first big-bang refactor of all stores before cron.** Rejected for
  sequencing only — larger blast radius on settled code; do it as a follow-up
  behavior-preserving PR instead.
