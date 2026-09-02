# dreamux repository operating rules

Always loaded. Keep this file to guardrails that must be present in every
agent context. On-demand architecture and reference material lives in
[`.agents/root.md`](.agents/root.md).

When this file and `.agents/` disagree, this file is authoritative for operating
rules. For architecture facts, read the current source first, then the linked
KB entry.

## Architecture Discipline

**Entropy reduction is this repository's highest standing rule.** The system's
history is a small number of features and countless refactors, and the motive
of every refactor is lowering complexity. Entropy means what a maintainer must
hold to reason about the system — concepts, entities, mechanisms, persisted
facts, states, special cases, cross-layer hops. It is **not** line count or
duplication count. Judge every change by three questions: does explaining the
affected area now take fewer concepts? does the next feature or provider need
to know less? what exactly was removed, and is every addition paid for by a
requirement someone actually stated? Two fakes are banned by name:
"deduplicating" through a new indirection layer while both original sides
survive (that adds a mechanism, it removes nothing), and deleting
user-visible capability and calling it simplification (that is a requirement
change and the operator's decision).

Refactoring is never "done" — it is always on the road. Treat the architecture
as a living thing every task must leave at least as clean as it found it.

- **Refactor-first, not glue-first.** Before implementing any non-trivial
  requirement, ask: *does this need an architecture change, or a new/extended
  capability?* If the clean home for the logic does not exist yet, create or
  reshape it. Do **not** stitch behavior together with ad-hoc glue (magic-string
  prefixes, target data smuggled through prompts/free-text fields, state
  re-derived in core that a lower layer already owns authoritatively,
  responsibilities bolted onto whatever class is nearest). Glue is how a
  codebase rots into a mess.
- **Self-check layering every time.** For each change, verify the module
  boundaries still hold: is this logic in the layer that owns it? Does it honor
  the neutral seams (core stays behind `AgentRuntimeProvider` / `ChannelProvider`;
  no runtime/channel specifics leak into shared/core layers)? Would a new
  capability/contract be the right home instead of a special case? If a change
  fights the layering, the layering — or the change — is wrong; stop and fix the
  boundary, don't force it through.
- **Prefer a capability over a special case.** When two features want the same
  underlying fact or action (e.g. "is the agent idle", "where does this egress
  go"), design one foundational capability the whole core depends on, rather
  than re-solving it ad hoc each time.
- **Leave the cleanup trail.** When a task reveals a boundary that should move,
  either fix it or record it (`.agents/`, an issue, or the knowledge-delta
  update) — never silently pile another layer of glue on top.
- **No defense without a named failure scenario.** Do not add validation, caps,
  retries, fallbacks, recovery paths, allowlists, or new entities without
  naming the concrete real scenario that reaches them. Defensive code found in
  review is deleted, not corrected. The full taste with cases:
  [`engineering-whitepaper`](.agents/skills/engineering-whitepaper/SKILL.md).
- **Change anything — knowingly.** No knowledge or design is absolutely
  authoritative; existing code, decisions, and docs are evidence of how the
  system got here, and any of them may be changed to fit the current product
  scenario. What is prohibited is the unknowing change: name what you are
  changing, why its original rationale no longer holds, and update its record
  in the same change. A change to user-visible behavior is a requirement
  decision for the operator — diff refactors against
  [`.agents/product/README.md`](.agents/product/README.md).
- **Operator rulings are quoted, never stretched.** Restate an operator ruling
  verbatim or narrower — a named entry point is not a category, and a ruling on
  one object does not extrapolate to its neighbors. Anything recorded as a
  confirmed operator decision must carry the operator's actual words;
  inferences are labeled and confirmed before implementation or review cites
  them.
- **Do not weaken a load-bearing test to make a change pass.** Some tests encode
  a locked contract (e.g. the issue #63 non-blocking-inbound live gate). If a
  change makes such a test fail, the change is usually wrong — fix the change,
  not the assertion. When a diff edits a test's assertions, "the tests pass" is
  circular: review the test diff against the source contract, never trust a
  green run produced by a rewritten test. When reviewing a fix, review the whole
  current change holistically (a narrow "did it fix X" pass hides regressions
  the fix introduced).

The goal is explicit: this repo must not degrade into a spaghetti/"big ball of
mud" codebase. Cleanliness of module layering is a standing acceptance criterion,
not an optional nicety.

## Communication

- Reply to the user in **Chinese**.
- Write all repo docs, `.agents/` docs, code comments, commit messages, and PR
  descriptions in **English**.

## Current Source Of Truth

- Product behavior catalog (user-visible behavior refactors must diff against):
  [`.agents/product/README.md`](.agents/product/README.md).
- Operator engineering taste:
  [`.agents/skills/engineering-whitepaper/SKILL.md`](.agents/skills/engineering-whitepaper/SKILL.md).
- Current architecture entry point: [`.agents/domains/current-architecture.md`](.agents/domains/current-architecture.md).
- Repository/package layout: [`.agents/domains/current-architecture.md`](.agents/domains/current-architecture.md) (package map) and [`.agents/domains/repository-operations-and-release.md`](.agents/domains/repository-operations-and-release.md).
- State/cache/run/log paths: [`.agents/domains/state-config-and-files.md`](.agents/domains/state-config-and-files.md).
- Channel/Feishu runtime: [`.agents/domains/channel.md`](.agents/domains/channel.md).
- Task routing and KB index: [`.agents/root.md`](.agents/root.md).
- KB writing rules: [`.agents/CONTRIBUTING.md`](.agents/CONTRIBUTING.md).

Before answering architecture/domain questions, verify against source code. The
KB explains intent and history; code is the current behavior.

## Build And Test

`excitedjs/dreamux` is a Rush + pnpm monorepo. Use the monorepo path only:

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
node common/scripts/install-run-rush.js test
```

A stage or change is not "green" until build, lint, and test all pass; `rush
lint` is a first-class gate, not an afterthought.

Do not use per-package `npm install`; workspace dependencies use `workspace:*`.

## Always-Binding Rules

- **Public repo red line:** never commit internal identifiers, secrets, private
  registry URLs, internal hostnames, or real Feishu ids/tokens. `.gitleaks.toml`
  and `.npmrc` are shared canonical guardrails with the sibling repo; if a
  guardrail false-positives, stop and ask rather than editing a local allowlist.
- **The anti-leak pre-commit gate is mandatory.** `common/git-hooks/pre-commit`
  runs gitleaks over staged changes and `common/scripts/check-internal-content.sh`
  over staged content, and it fails the commit when gitleaks is not installed.
  Skipping is not permitted: never commit with `--no-verify`, and never work
  around a missing binary. Install it — `common/scripts/install-gitleaks.sh` —
  and retry. This applies to CI and release automation too; the release bot
  commits through the same hook on purpose.
- **No synchronous blocking IO in package source:** `/packages/*/src/**` must
  use async fs/process APIs. `rush lint` enforces the shared
  `@excitedjs/eslint-config` no-sync-IO gate.
- **No runtime dependencies on dev tools:** bin launchers execute compiled
  `dist/` with plain `node`; do not reintroduce `tsx`.
- **Launcher path handling:** new bin launchers must follow the
  `/packages/dreamux/bin/dreamux` symlink-walk shape.
- **Path contracts:** host-owned path builders belong in
  `/packages/dreamux/src/platform/paths.ts`; volatile runtime socket allocation
  belongs in `/packages/dreamux/src/platform/runtime-sockets.ts`; runtime-owned
  path derivation belongs in the runtime package that uses it (for example
  `/packages/agent-runtime/codex/src/paths.ts`).
- **No legacy architecture rollback:** do not reintroduce `runtime_dir`,
  SQLite-backed dispatcher state, `~/.codex-host/`, legacy global CLI aliases,
  or workspace `.codex/skills` installation unless a new operator ruling,
  recorded in a task record, explicitly supersedes the current architecture.
- **Codex protocol bumps:** update the
  `@excitedjs/agent-runtime-codex` package first. Core must stay behind the
  neutral `AgentRuntimeProvider` interface.
- **Codex minimum version:** Dreamux requires codex 0.137+ (`thread/start`,
  `thread/resume`, `turn/start`, and thread-level instruction overrides);
  older versions fail loudly at the provider's version gate
  (`packages/agent-runtime/codex/src/version.ts`) instead of misbehaving
  silently. Completion delivery rides the ordinary provider submit path.
- **Live Codex tests:** tests that require a real Codex install fail loudly when
  Codex is missing. Use `DREAMUX_SKIP_LIVE_CODEX=1` only when the environment
  intentionally lacks Codex.
- **Config/state maintenance synchronization:** every change to the shape,
  validation, default, ownership, or meaning of a Dreamux config or persisted
  state file must update
  `/packages/dreamux/skills/dispatcher/dreamux-maintenance/` in the same change:
  keep `SKILL.md` routing accurate and update the single owning reference. Name
  fully server-owned state and prohibit direct editing; for mixed state, state
  the field boundary exactly. The root and every reference except
  `references/self-upgrade.md` are current-state-only: they may name the one
  accepted schema/version but must not contain upgrade detection, historical
  formats, migrations, `Rebuild:` recipes, or delete/recreate instructions.
  The self-upgrade reference is the narrow generic exception: it reads concrete
  transition work from a validated staged target's changelog and owning
  references instead of embedding release-specific history. Put historical
  details in change notes, public docs, loader errors, and decision trails.

## Knowledge Delta

Before finishing a non-trivial PR, ask:

> Did this move a package boundary, CLI surface, settled design decision,
> Codex / Feishu protocol contract, state/config format, or cross-process
> invariant?

If yes, update `.agents/` in the same PR and run:

```bash
.agents/scripts/check.sh
```

## Changelog Responsibility

Dreamux 0.x handles incompatible config/state shape, version, or path changes by
fail-loud plus manual rebuild. Any change that can block or break a user's
upgrade needs a Rush change file. Use `rush change`; never hand-edit generated
changelogs.

Typical upgrade blockers include config/state/cache/run/log path semantics,
persisted file formats, onboard/daemon behavior, bundled skills, dispatcher
cwd/work directory contracts, and any manual rebuild requirement.

For incompatible shape, version, or path changes, breaking notes lead with
`BREAKING:` and include `Rebuild:` with the exact manual action. A same-shape
semantic change may retain its state version only when the operator explicitly
approves that tradeoff; its breaking note must lead with `BREAKING:`, immediately
include `Review:` with the required operator check, explicitly say no rebuild is
needed, and contain no `Rebuild:` instruction.

While a package stays on the 0.x version line, its change files must never
use type `major` — Rush bumps a 0.x package straight to 1.0.0 on a pending
major. Record breaking changes for 0.x packages as type `minor` with the
`BREAKING:` note leading. Packages already past 1.0.0 (for example
`@excitedjs/feishu-channel`) use real semver majors. CI enforces the 0.x rule
(`ci.yml`, "Forbid major change files on the 0.x line"); the operator decides
when a package leaves 0.x.

## Commits

- Use real author identity. If git reports an auto-detected email, set
  `user.email` / `user.name` explicitly for the commit.
- Commit messages: short subject, wrapped body, explain why, reference issues or
  PRs when relevant.
- Co-author trailer: credit the actual model doing the work, for example
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
