# Provider plugin load-session hardening

- **Status:** Proposed follow-up for PR #308
- **Date:** 2026-08-04
- **Affects:** npm provider materialization, config loading, update promotion,
  diagnostics, uninstall, plugin-store persistence
- **Background:** [Local provider plugin store](../archive/proposals/local-provider-plugin-store.md)

## Intent

Keep the operator-requested local `npm:` provider experience while correcting
the ownership and lifecycle problems found in the PR #308 architecture review:

- first use may block while Dreamux installs a missing provider;
- a running server checks npm `latest` no more than once every four hours;
- a later process may apply a downloaded update, but only after the whole
  provider/config contract validates;
- a bad update never replaces the last known good generation;
- config inspection and dry-run paths remain non-materializing;
- the implementation becomes smaller by removing duplicated policy and
  speculative cancellation/symlink state machinery.

This proposal is an incremental correction to the archived plugin-store
proposal. Where they differ, this proposal owns candidate promotion, config
phases, updater error state, staging cleanup, and uninstall result semantics.

## Decisions

### 1. Selected means fully validated

`selected_version` is the last known good generation. Filesystem completeness,
package name, and package version are necessary but are not sufficient to
select a generation.

A generation may become selected only after one strict load has successfully:

1. imported the generation-local ESM bridge;
2. selected every referenced default or named factory export;
3. validated every provider factory and provider contract;
4. registered the implementations through the existing provider loader; and
5. completed all provider `readConfig` calls.

For onboard, successful candidate provider `onboard.collect` and the final
strict resolution of the collected config are also inside the commit gate.
Provider-independent host and cross-reference validation is complete before a
session is prepared and is never a reason to reject a candidate or fall back.

The generic provider loader keeps its single ref loop and provider-neutral
contract checks. It does not write plugin metadata.

### 2. One explicit load session owns prepare, pin, and commit

Introduce one config-facing `ProviderPluginLoadSession` capability. The
plugin-store layer owns generation files, npm commands, metadata, exact-version
import, and the session's persistence operations. Config orchestration owns the
definition of a successful whole-config load and therefore decides when to call
`commit()`.

A session:

- de-duplicates packages across Agent Runtime and Channel refs;
- prepares one exact version per package;
- exposes one package importer shared by both provider-kind loaders;
- pins those exact versions for the whole load;
- commits prepared candidates only after the strict config load succeeds; and
- rejects candidate-backed attempts through `rejectCandidates()`, which clears
  candidate pointers without changing `selected_version`.

The store/session owns metadata reads and writes. Config orchestration never
parses or mutates plugin metadata directly. The session also exposes an explicit
selected-only fallback plan; it does not own provider registries.

No catalog, wizard, command, or Server layer adds a second npm-aware loader.
The store/session seam stays narrow and injectable for tests.

### 3. Background updates stage candidates; they never select

Metadata records, per package:

- the fully validated `selected_version`;
- an optional published `candidate_version`;
- `last_check_completed_at`; and
- an optional `last_check_error` owned only by the background update-check
  lifecycle.

The updater may query, install, verify package identity/version, publish an
immutable generation, and record it as `candidate_version`. It must not change
`selected_version`, import provider code, or validate config.

Every completed update attempt records its completion time. Success clears
`last_check_error`; registry, install, verification, or publication failure
records a concise error and preserves both selected and candidate generations.
Abort does not advance the completion time or error.

Each successful lookup applies this state table:

| Registry result | Metadata transition |
|---|---|
| `latest == selected_version` | clear a stale candidate and clear the error |
| `latest == candidate_version` | retain the candidate and clear the error |
| a different latest version | publish/reuse it, replace only the candidate pointer, and clear the error |

Replacing or clearing a candidate pointer never deletes its immutable
generation. A failed lookup/install keeps both pointers and records the error;
abort changes no metadata field.

### 4. Startup applies or rejects a candidate as one config attempt

For each referenced package, a strict materializing session prefers its
candidate generation; otherwise it uses the selected generation. A newly
referenced package with neither version performs a blocking `latest` lookup and
installation. Before provider validation, one metadata write records the
published generation as `candidate_version` and records the successful lookup
in `last_check_completed_at`. Commit and rejection both preserve that completed
check time; rejection clears only the candidate pointer. An updater started by
the same successful serve therefore does not immediately repeat the lookup,
while a later explicit no-selected/no-candidate retry still ignores the
background gate as specified below.

If the candidate-backed whole config load succeeds, the session commits every
prepared candidate as selected and clears its candidate pointer. Commit is
not a cross-file transaction: packages are written sequentially, and each
package metadata document is atomic and idempotent through
`JsonDocumentStore`/`writeFileAtomic`. If the process stops after a partial
commit, every committed version was already validated by the same complete
config attempt; remaining candidates are validated again on the next start.
A commit write failure fails strict loading and is not classified as candidate
validation failure.

If candidate-backed loading fails, Dreamux first calls `rejectCandidates()` for
every candidate used by that attempt. Config orchestration retains the attempt
error in memory for immediate warning/error output. Rejection does not persist
that error in the updater-owned `last_check_error` field and does not claim that
the package itself was necessarily defective, because provider config may also
have changed.

For non-interactive `serve` and `daemon install`, if every required package
then has a selected generation, Dreamux:

1. discards the partially populated provider registry;
2. retries once with a fresh registry pinned only to selected versions; and
3. starts with the last known good set if that strict retry succeeds, while
   logging the rejected candidate clearly.

The fallback is all-or-nothing for the config load. It does not mix a partially
validated candidate registry with selected implementations.

If any required package has no selected version, rejection still clears the
candidate pointer and then config loading fails loudly. The next explicit start
queries `latest` again; if it resolves to an already published complete
generation, the store reuses it without another install and performs a fresh
whole-config validation attempt. If the selected-only retry also fails, config
loading fails loudly. First installation therefore remains fail-loud, while an
automatic background update cannot brick a previously working configuration.

An explicit materializing strict load with both `selected_version == null` and
`candidate_version == null` always performs a registry lookup immediately,
regardless of `last_check_completed_at`. The four-hour gate constrains only the
background updater; it never delays first use or an explicit retry after
candidate rejection.

Only errors from candidate provider import/export selection, factory/contract
validation, or candidate provider `readConfig` enter reject/fallback. Host and
cross-reference errors fail before session preparation. If selected-only retry
also fails, Dreamux throws one aggregate error preserving both the candidate
attempt and selected/config attempt causes; it never hides the first error.

Onboard does not replay provider-owned interaction against a different
generation. Failure in candidate `onboard.collect` or final strict config
resolution rejects candidates and fails loudly without automatic selected-only
fallback. Previously collected answers remain ordinary data but are not
automatically handed to another provider version.

### 5. Host config validation precedes plugin side effects

Config loading has explicit phases:

1. parse JSON and validate the Dreamux-owned envelope and declarations;
2. extract canonical provider refs from the validated declarations;
3. prepare a plugin load session;
4. load provider implementations through the existing loaders;
5. run provider-owned `readConfig` and finish strict config resolution; and
6. commit the session only after the complete strict result exists.

The host phase validates all structure Dreamux owns: top-level keys,
`agents[]`, `dispatchers[]`, IDs and duplicates, provider-ref syntax,
dispatcher/runtime/channel relationships, workspace fields, collaboration
space fields, and provider config object shape. It treats the contents of each
provider config object as opaque until provider `readConfig` runs.

No npm lookup, filesystem materialization, or provider code execution occurs
before the host-owned phase succeeds.

Strict-load options accept a provider-registry factory, not one mutable
registry instance. The default factory creates a builtin-seeded registry. Each
candidate and selected-only attempt calls the factory and returns only the
successful attempt's registry to Server/catalog consumers. Tests may inject a
factory with additional seed descriptors.

Host declarations are immutable input to an attempt. Each retry receives a
fresh snapshot of provider-owned raw config so a candidate provider cannot
mutate objects later observed by selected providers. The session never carries
a registry or mutable raw declarations between attempts.

### 6. Strict loading and inspection are different APIs

The default/serve path is strict and returns `DreamuxConfig` only when every
referenced provider is runnable and every provider config is resolved.

Doctor and no-write command paths use an explicit inspection result with
`available | unavailable` package/provider entries. They do not register
missing descriptors, synthesize implementations, write empty identities, or
place unresolved raw provider config inside a normal-looking `DreamuxConfig`.

- `doctor` reports unavailable plugins and `last_check_error` without
  installing. It imports selected generations only for available declarations
  and may run their provider diagnostics, but it never imports candidates,
  commits metadata, or requires a fabricated full config.
- `onboard --dry-run` and `daemon install --dry-run` use the same centralized
  missing-plugin policy and never materialize. A selected missing provider is
  an error; unrelated pre-existing missing refs are reported consistently, not
  silently filtered by a second command-local implementation.
- `uninstall` performs only raw host-envelope inspection for warnings.

Remove `providerPluginLoadMode` from generic config overrides. Materializing
strict load, installed-only strict load, and inspection are named operations,
so command behavior is selected by the operation rather than a mode flag.

The command matrix is load-bearing:

| Command/phase | Imports provider code | Version source | May install | Runs `readConfig` | May commit |
|---|---:|---|---:|---:|---:|
| `serve` strict load | yes | candidate preferred, then selected fallback | yes | yes | yes |
| `daemon install` | yes | candidate preferred, then selected fallback with returned warning | yes | yes | yes |
| `daemon install --dry-run` | yes, only when all required selected versions exist | selected only | no | yes | no |
| `doctor` | available entries only | selected only | no | available entries only | no |
| `onboard` provider collection + final strict load | yes | one shared session; candidate preferred; no automatic selected fallback | yes | final config only | after collect + final strict success |
| `onboard --dry-run` | yes, only when required selected versions exist | selected only | no | final preview only | no |
| `uninstall` | no | none | no | no | no |
| `config path/show` | no | none | no | no | no |

The two dry-run rows import providers and run `readConfig` only after inspection
has confirmed that every required selected generation exists; otherwise they
return the centralized missing-plugin error before either action.

The onboard CLI composition root creates one non-serializable provider context
containing the load session and registry factory. The wizard incrementally
prepares newly selected refs and uses the session importer for provider-owned
onboarding. Final config resolution reuses that same session and commits only
after strict success. The context is passed beside `OnboardAnswers`; it is
never stored in answers or written to config. The existing wizard and run
orchestrations are merged rather than retaining a second `ProviderPluginPlan`.
If onboard candidate collection or final validation fails, the context rejects
its candidates and the command fails; it never replays prompts with selected
providers.

`serve` logs every candidate rejection/fallback warning. `daemon install`
returns the same warnings from strict loading and prints them before any service
mutation, so a successful selected-only fallback is never silent.

### 7. Staging has bounded lifecycle; generations remain immutable

Each install attempt removes its own staging directory in a `finally` path on
ordinary success, failure, or abort. Abort-owned cleanup remains part of the
in-flight operation and may run after updater close has signaled cancellation.
A later install may remove orphan staging directories older than 24 hours by
mtime before creating its own staging path.
It must never remove a recent staging directory or anything outside that
package's staging root.

Published generations are retained indefinitely in this change. That
retention is deliberate: a running process and a load session may pin an older
generation after metadata changes. Generation garbage collection requires a
separate design with a cross-process lease or equivalent evidence of liveness;
it is not added here.

### 8. Update diagnostics are observable

Doctor exposes the last completed update error as a warning while continuing
to report the selected generation as usable.

Candidate rejection is reported immediately by the command that attempted the
load. It is not persisted as an updater check error, and a later successful npm
check therefore cannot erase or misrepresent a candidate-rejection record.

Installation remains sequential. Parallel npm work is out of scope because it
is not required for correctness and would add scheduling/error-order
complexity. This change adds no public progress event, provider ABI,
`ServerOptions` field, or new event entity.

### 9. Metadata compatibility and corruption

The metadata document stays at format version 1. `candidate_version` and
`last_check_error` are backward-compatible optional fields: parsing an existing
document defaults each missing field to `null`, preserving its selected version
and completed-check time. Writers include the new fields thereafter. Do not
bump the document version and trigger warn-rebuild for this additive schema
change.

Malformed or incompatible metadata keeps the existing `warn-rebuild` policy:
Dreamux warns, treats the package as first use, and does not delete or scan
published generation directories to guess a selected version. A later lookup
may reuse the exact complete generation resolved by npm, but there is no
speculative generation-directory recovery scan.

### 10. Uninstall reports physical deletion and alias cleanup honestly

Keep the proven uninstall requirements:

- canonicalize and safety-check both logical roots before service mutation;
- collapse recursive deletion by canonical physical containment;
- disclose the physical removal target in dry-run/ledger output;
- remove the logical leaf symlink so a dangling alias cannot block re-onboard;
- never follow a newly retargeted logical path during deletion.

Remove the speculative identity snapshot (`dev`, `ino`, `ctimeNs`, `mtimeNs`)
and readlink-equality state machine. At execution time, unlink the captured
physical leaf only if `lstat` still says that exact captured path is a symlink;
unlink never follows its target.

Recursive physical removal status and logical leaf cleanup status are separate
ledger facts. A removed physical target is never reported as skipped merely
because alias cleanup was skipped or failed.

Uninstall collects per-operation failures, prints/returns the partial ledger,
and exits unsuccessfully when any service or filesystem operation fails. A
failure after service removal must not discard the already completed service
entry.

`UninstallRunResult` carries the ledger plus an explicit failure collection.
The CLI prints the whole result, then sets a non-zero exit/throws a summary when
the collection is non-empty; partial results are never available only inside a
discarded exception.

## Simplification requirements

- Centralize missing-plugin diagnostics/formatting used by wizard, onboard, and
  daemon; do not keep three filter-and-format branches.
- Remove duplicate onboarding provider preparation. One prepared load session
  supplies all catalogs/config work for one command attempt.
- Remove discarded diagnostic DTO construction and constant-true package
  filtering.
- Remove the envelope-level `JSON.stringify` -> `JSON.parse` config round trip.
  This does not remove the fresh per-attempt snapshot of provider-owned raw
  config required for candidate/selected retry isolation.
- Reuse existing `isRecord`/error helpers and move generally useful filesystem
  predicates to their existing platform owner only when there is more than one
  real consumer.
- Keep cancellation tests at observable lifecycle boundaries. Do not monkey
  patch private methods or lock every internal `await` ordering. Retain runner
  pre-spawn abort, no metadata writes or newly started side effects after
  updater close wins, no candidate/selection on abort, non-importable staging,
  and updater close tests.
- Define updater close at setting `closed`, clearing the timer, and aborting the
  active controller. After that point no new lookup, install, bridge write,
  publish, or metadata write may start; already-started I/O may settle and the
  aborted attempt may remove its own staging. `closeUpdater()` waits for the
  flight and that cleanup, and no updater work remains after it returns.
- Remove unreachable single-flight branches or make the invariant explicit;
  do not add a second timer, queue, or lock.

## Hard constraints

- `npm:` never falls back to ambient, global, cwd, `NODE_PATH`, or Dreamux's own
  dependency resolution.
- `builtin:` never enters the plugin store or triggers network work.
- Published generations are immutable and generation-local ESM import
  semantics remain intact.
- Runtime and Channel loaders stay behind the neutral provider registry seam.
- No synchronous filesystem/process APIs under `packages/*/src/**`.
- Path composition remains owned by `platform/paths.ts`.
- Metadata remains a versioned `JsonDocumentStore` document written atomically.
- First install and a config with no last known good provider fail loudly.
- Do not add speculative cross-process locks, a general scheduler, hot reload,
  sandboxing, or a public plugin-management CLI.

## Acceptance

- Invalid Dreamux-owned config fails before npm lookup, store writes, or
  provider import.
- A missing first-use package installs once, is used by both provider kinds,
  and is selected only after factory/contract/config validation succeeds.
- First-use preparation atomically records its candidate plus completed lookup
  time before validation; commit preserves the time, and the updater in the
  same serve process does not immediately query again.
- Missing named export, invalid factory/contract, or provider `readConfig`
  failure does not change `selected_version`.
- A due updater publishes and records a candidate without changing selection or
  the running module.
- Updater transitions cover latest equal to selected, equal to candidate, a new
  version, failure, and abort exactly as specified by the metadata state table.
- A later start validates a good candidate and commits it; runtime and channel
  refs use one exact generation for the whole load.
- A bad candidate is rejected, its error is observable, and a fresh selected-
  only registry/config attempt starts with the last known good generation.
- A bad first-install candidate with no selected version fails startup.
- Rejecting a bad first-install candidate clears its pointer and reports the
  load error immediately; a later explicit start ignores the four-hour updater
  gate, performs a fresh lookup, and may reuse the already published generation
  before revalidation.
- Host/cross-reference failure occurs before session preparation and never
  triggers fallback. Candidate provider failure may fall back for serve/daemon;
  if selected loading also fails, the aggregate error preserves both causes.
- Onboard candidate `onboard.collect` or final validation failure rejects and
  fails loudly without replaying interaction against the selected provider.
- Candidate and selected-only attempts use distinct fresh registries and fresh
  provider-config snapshots; only the successful registry is returned.
- Multi-package commit is per-package atomic. A partial commit is safe on the
  next start, while a metadata write failure fails strict loading without being
  treated as candidate validation failure.
- Existing version-1 metadata without candidate/error fields preserves its
  selection/check time and defaults the fields to null. Malformed metadata
  warns and rebuilds empty without deleting or scanning generation files.
- Background lookup/install failure records timestamp plus error and preserves
  selected/candidate state; success clears the error; abort records neither.
- Candidate rejection does not reuse or overwrite the updater-owned
  `last_check_error`; serve and daemon surface the in-memory rejection warning.
- Ordinary install failure/abort removes its own staging directory. A later
  install prunes only orphan staging entries older than 24 hours. Published
  generations are never automatically removed.
- Strict config APIs never return unresolved provider entries. Inspection APIs
  never materialize and represent unavailable providers explicitly.
- Wizard/onboard/daemon share one missing-plugin policy and one preparation per
  command attempt.
- Uninstall preflights before service mutation, reports partial failures, keeps
  physical removal separate from leaf cleanup, and leaves no dangling owned
  leaf that blocks a later onboard.
- Uninstall returns an explicit failure collection with its partial ledger; the
  CLI prints that ledger and exits unsuccessfully when failures exist.
- Closing an updater from a blocked abortable runner starts no new lookup,
  install, bridge, publish, or metadata work, waits for abort-owned staging
  cleanup, and returns with no remaining flight.
- Contract-level tests cover the above without private-method monkeypatching or
  per-await artifact assertions.
- The final change has fewer production and test lines than `ff24482` while
  preserving the requested first-install and four-hour update behavior.
- Rush build, typecheck, test typecheck, lint, full tests, change verification,
  built CLI smoke, KB check, and diff check pass.
- Update current architecture, provider runtime, state/path, the
  provider-reference decision, README, and the existing Rush change entry so
  each describes candidate staging, validation-before-selection, command
  modes, metadata compatibility, and last-known-good fallback accurately.

## Out of scope

- Parallel package installation.
- Automatic deletion or garbage collection of published generations.
- A public plugin install/list/remove/pin/update command.
- Provider hot reload or live migration.
- Changes to provider-ref grammar, provider factory ABI, or provider config
  schema.
- Marketplace, sandbox, signature, or trust-policy work.
