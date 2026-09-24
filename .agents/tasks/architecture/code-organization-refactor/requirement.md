# Code organization refactor: requirement

## Request

The operator, 2026-09-24 (verbatim in [rulings.md](rulings.md#scope-and-source-of-the-task)):
agents built this repository with one structural harness, a 700-line
per-file ESLint cap. Code style made files hit that cap, and the usual
response was to carve a piece into a new file. This refactor must leave no
logic that was split out only to get under the cap — the single files under
`packages/dreamux/src/service` are the prime suspects — put every piece where
its responsibility belongs, split module responsibilities sensibly, and clean
up the repository's code organization and design patterns. The first step was
to survey the current state and find every ugly pattern.

An earlier operator ruling already states what the cap is for: "不要搞什么机械拆分。700
行就是为了卡架构重构的。是不是有共性的模块可以拆出来？"

## Current state

The survey is [artifacts/audit.md](artifacts/audit.md): a read-only audit of
every package in 14 slices, each finding checked by an adversarial verifier
(281 raised, 278 kept, 58 added by verifiers), concluded into one report.
Headline facts, each with file references in the audit:

- At least 35 files are cap-driven carve-outs: a single-importer sibling fed
  the parent's private state through a bag or callbacks (audit §5).
- Twelve source files sit between 648 and 700 lines.
- All 33 directories of `packages/dreamux/src` form one import cycle; nothing
  enforces direction.
- Whole mechanisms exist twice and have drifted (dispatcher teardown vs
  failed-start rollback, history paging, workspace placement, provider
  activity primitives, the managed-service install pipeline).
- Line count is inflated by style, not concepts: about 180 conditional spreads,
  validation repeated at three or four layers, restated comment prose, 22
  private `isRecord` copies.
- At least 7 tests read source text and pin file paths, so a correct move
  looks like a regression.

The audit ran on the `feat/plugin-system-mvp` branch of
[PR #453](https://github.com/excitedjs/dreamux/pull/453); its findings about
that branch's plugin code are part of this task's input.

## Desired outcome

The target below is the audit's proposal (§6) as amended by the
[rulings](rulings.md). Where they differ, the rulings decide.

### Harness

- `max-lines` stays at 700 and counts code lines only (R1).
- `prettier --check` joins `rush lint` after the deletion stage, applied in one
  dedicated commit (R2).
- `exactOptionalPropertyTypes` is enabled (R3).
- dependency-cruiser declares the layer order of `packages/dreamux/src` and
  forbids cycles, in warn mode first and error mode at the end (R5).
- A knowledge-base chapter states which unit tests to write. Source-text and
  file-path tests are removed, each recorded guard they carry replaced by a
  behavior test or a dependency-cruiser rule in the same change (R4).

Audit recommendations the operator has not ruled on, to be proposed with the
technical solution: the filename rule (H4), the unused-export check (H5), the
package-wide re-export ban (H6), the ownership-doc path check (H10), and the
compiler-based replacements for two type-surface tests (H11).

### Domain shape

- One directory per aggregate. `service/agent/` replaces `agent-entity/`,
  `teammate-service/`, and `teammate-collection/`; `service/team/` replaces
  `team-collection/` and `team-service/`. Inside a directory, files follow one
  declared direction (store ← service ← collection). No separate entity layer
  (R7).
- `TeammateService` becomes the Agent service; error messages are worded by
  the actual role and the completion push-back text is rewritten under the
  model-facing writing rules; public `@excitedjs/dreamux-types` names and the
  `.tm.` segment stay (R6).
- The audit's per-domain file template (§6.2) applies inside each directory.
- Every file judged a carve-out in audit §5 either folds back into its owner
  or becomes a real owner of named state, as that table says, adjusted to the
  directories above.

### Lifecycle

- Closing is self-contained per Agent and batched upward, layer by layer; the
  dispatcher-level second sweep and the separate failed-start rollback go
  (R10).
- Every Dispatcher starts at daemon start and stops only with the daemon;
  `dispatcher.start`, its CLI verb, and the reopen logic are deleted (R11).
- While a Dispatcher stops, reads are refused like writes (R12), with one
  stated refusal code for every closed scope (R13).

### Storage and configuration

- The [#448](https://github.com/excitedjs/dreamux/issues/448) solution — one
  transactional store for every runtime store, a Config Service, and the
  `config.agents.get` / `config.agents.replace` Commands — is part of this
  refactor, as the [rulings](rulings.md#scope-and-source-of-the-task) record.
- Every persisted file, `config.json` included, tolerates unknown fields and
  rejects only wrong types and missing fields (R21).
- Facts no code reads go to logs, not persisted files (R22).
- `DREAMUX_ROOT` is the only relocation variable (R26).

### Behavior changes the rulings accept

Each is a user-visible or model-visible change that needs a change note:
R6 (messages and push-back text), R11, R12, R13, R14, R15, R16, R17, R20, R21, R22,
R23, R24, R25, R26 (`BREAKING:` with `Rebuild:` for a non-default config
directory), R28, R29, R30, R31, R35, R36, R37, R38, R39, R41.

### Unchanged on purpose

R8 (plugins receive the real objects), R19 (the Codex-worded replace prompt),
R33 (runtime supervisors create the cwd), R34 (the uninstall refusal stays;
its protected directory names come from the providers), R40 (the notification
retry), R41's
TeamLeader COT after a restart, R42 (no handling of a Dispatcher cwd inside a
repository).

## Sequencing

The audit's stages (§8), amended. Every stage keeps build, lint, test, and
`typecheck:tests` green and updates `.agents/` and the maintenance skill for
what it moves.

1. Harness preparation: the testing chapter, classification of source-text
   tests, dependency-cruiser in warn mode, code-only line counting.
2. Deletions and required dependencies (audit stage 1 plus R11, R23, R24,
   R25, R28, R29, R30, R39, and R35/R36 if PR #453 has merged; otherwise they
   belong in PR #453), with `exactOptionalPropertyTypes` enabled.
3. The formatting commit (R2).
4. Storage: the #448 pull requests (store and Feishu; core stores; Config
   Service) with R21 and R22, before directories move so #448's paths stay
   valid while it lands.
5. Leaf layering (audit stage 2).
6. Domains, one pull request each: `service/agent/`, `service/team/`,
   Workflow, scheduler, Dispatcher and Channel (R6, R7, R10, R12, R13,
   R15–R17).
7. Adapters and schemas (audit stage 4 plus R14, R18, R20).
8. Providers, Feishu, and host shell (R9, R26, R31, R32, R34, R37, R38,
   R41).
9. Lock the harness: dependency-cruiser in error mode, remaining text tests
   removed.

## Open items to settle in the technical solution

- R18: whether every Agent's completions have exactly one possible recipient
  (decides one layer or two).
- R32: whether unifying the two activity shapes is a net deletion.
- R22: the inventory of persisted diagnostic-only fields beyond `access.json`.
- R21: which loader rules change, and the PR #453 plugin `config` block rule.
- Audit §9 items the session did not rule on: the `teammate:` result keys
  (item 4); renaming Workflow `closeAdmission()` (item 11); the owner of the
  shared-tmp socket check and collapsing the legacy-state doctor rows
  (item 16); deleting `access.json` `kind` / `replies` and the Feishu
  `space_id` / per-channel keying (item 26).
