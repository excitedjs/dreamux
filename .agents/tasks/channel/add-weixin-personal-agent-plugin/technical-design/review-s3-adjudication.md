# Slice 3 review adjudication — the plugin commands

Status: adjudicated by the TeamLeader on 2026-11-25; no correction is applied
until the operator rules on it by card. Target reviewed: the uncommitted slice
3 change (the files named in `final.md` Section 12) against `requirement.md`
behaviors 9 to 13 and criteria 9 to 15 and Section 12.

Reviews, as delivered:

- [review-s3-complexity.md](review-s3-complexity.md) — gpt-sol, complexity
  adversary: 76 items (delete 19, fold 33, move 8, keep 16) and two blockers.
  Read-only Node probes; the suites were not run.
- [review-s3-kimi.md](review-s3-kimi.md) — kimi, correctness: 4 blocking,
  5 should-fix, 2 nit. Ran the four plugin suites (79 tests); plain Node
  probes on resolution and paths; exercised the built CLI's help paths.
- [review-s3-glm.md](review-s3-glm.md) — glm, correctness and tests: 0
  blocking, 6 should-fix, 9 nit. Ran eight suites (133 tests), the whole
  package (1392 passed with the package's own `--fileParallelism=false`; seven
  load timeouts without it), and 62 mutations on a scratch copy (48 caught).

Coverage limits common to all three: no real `npm install` from a registry,
no Windows run, no live daemon, and no run of `channel add` at a real
terminal.

The three reports agree on every finding they share. The TeamLeader
reproduced the two blockers in plain Node in scratch directories.

## Dispositions

"Card" marks a correction that waits for the operator's ruling; "record" is a
task-record correction, which needs no ruling.

### Card 1 — the lookup

| # | Finding (source) | Disposition | Evidence and reason |
| --- | --- | --- | --- |
| L1 | The lookup reaches outside the plugin directory: a bare `createRequire(...).resolve(name)` walks up through every ancestor's `node_modules` and resolves Node built-in names (complexity 1, glm N6) | Accept | Reproduced: with `<dreamux root>/node_modules/@scope/other` present, the current code resolves it; `fs` resolves to the built-in; the `paths` option changes neither. This breaks the ruling “只认插件目录”. The earlier hand check missed it because that scratch directory's ancestors held no `node_modules`. |
| L2 | A package that exposes only an `import` condition cannot be resolved, and a dual-format package loads its CommonJS build (kimi 5, complexity 50) | Accept | `require` resolution selects the `require` conditions: `exports: { ".": { import: "./index.js" } }` gives `ERR_PACKAGE_PATH_NOT_EXPORTED`, where the former plain `import()` loaded it. The recorded limitation understated this. |
| L3 | A relative `DREAMUX_ROOT` breaks `createRequire` (kimi 7) | Accept, folded | It needs an absolute filename. Falls away with the correction to L1 and L2. |
| L4 | A present package whose entry file is missing is reported as absent (kimi 9) | Accept, folded | With the correction, "installed" means the package's manifest is at its slot; a missing entry file is then reported by the import with its path. |
| L5 | The `Rebuild:` action and the missing-package message name `dreamux plugin add` for every package, including a provider a `channels[].provider` or `agents[].provider` names directly, and for a `#export` entry (kimi 4, complexity 28 and 46, glm N5 and N7) | Accept | `plugin add` installs such a package and then fails its proof, because a provider's default export is not a plugin; the package is in place but the command exits with an error. The note and the message must give the action that works. |
| L6 | No suite pins "nowhere else": restoring the old lookup as a second place passes every test (glm S1) | Accept | Vitest answers `require.resolve` from its own resolver. A child Node process needs no dependency: `tests/bin-launcher.test.ts` already runs the built CLI. |

Correction for L1 to L4: a package is the directory
`<plugin directory>/node_modules/<name>`, a real directory or a link. Dreamux
reads its `package.json` and selects the entry itself: `exports["."]` under
the conditions `import`, `node`, `default`, in the manifest's order; else
`main`; else `index.js`. A shape that rule cannot select fails loud. This
replaces `createRequire` in `plugin/resolve.ts` with one manifest read, so no
ancestor and no built-in name can be found; it loads the `import` entry of a
dual-format package and an `import`-only package; and `plugin run`, which
already reads the manifest for `bin`, reads the same file through the same
function. Probed in plain Node on twelve manifest shapes, on a linked
package, and on an `import`-only package.

This corrects Section 12 rule 1 (resolved as `require` resolves it) and
removes the first known limitation.

### Card 2 — `channel add`

| # | Finding (source) | Disposition | Evidence and reason |
| --- | --- | --- | --- |
| C1 | `channel add` discards every key onboarding does not know, in the file and on existing entries (kimi 1, complexity 32, glm S2) | Accept | It writes through `runOnboard`, whose `stringifyConfig` reconstructs `plugins`, `agents`, and `dispatchers` only. Criterion 10 says the file keeps every key the commands did not add. glm ran the success case with one extra key: the key was gone and the test still passed. |
| C2 | `channel add` can replace an agent runtime an existing Dispatcher uses (complexity 33) | Accept | The agent answer accepts `id=provider`, and onboarding overwrites `agents[id]`. The approved design said an existing agent id is updated; that sentence is wider than behavior 12, "never changes an existing Dispatcher". |
| C3 | The onboarding doctor runs after the write and its failure suppresses the restart line (complexity 52) | Accept | For a channel whose provider is not ready — Weixin before `login` — `channel add` would write the Dispatcher and then fail, in the order criterion 10 rules: `channel add` before `login`. |

Correction: `channel add` writes as `plugin add` does. It asks what it asks
today, builds the answers through `answersFromOptions`, which validates the
selections and collects the channel's configuration, and then appends one
Dispatcher and one agent entry to the file as it is. The new Dispatcher's
agent has the new Dispatcher's id; an agent of that id that already exists is
refused, and an existing Dispatcher id is refused. Every other byte of the
file stays. It ensures the working directory exists, as onboarding does, and
runs no doctor: `dreamux doctor` and the next start check as they always have.
`runOnboard`, `printOnboardResult`, and the `RunOnboardOptions` pass-through
are no longer used by it. This revises Section 12 rule 6.

### Card 3 — `plugin remove` and `plugin list`

| # | Finding (source) | Disposition | Evidence and reason |
| --- | --- | --- | --- |
| R1 | The commands match the whole ref `npm:<name>`, so an entry spelled `npm:<name>#<export>` is reported unregistered, and `plugin add` appends a second entry (kimi 2, complexity 22, glm S4) | Accept | `readPluginEntries` accepts the suffix. An entry is this plugin's when its ref is `npm:` and its package is the name. `remove` removes every entry of the package. |
| R2 | `list` and `remove` load the entry without its `config` block and never run `config.read` (kimi 3) | Accept | A plugin whose `config` block is refused shows in `list` as loadable and is refused by `remove`, while `dreamux serve` rejects it. |
| R3 | `remove` uninstalls a package a Dispatcher still addresses by an `npm:` provider ref (glm S3) | Accept, and simplified | Section 12 defined a use as a contributed provider only. An `npm:<package>` provider ref is a use too, and it is seen without loading the plugin at all. The in-use check reads the provider refs through `config/load.ts`'s own collectors and matches by kind: `npm:<name>` in an agent or a channel, or `builtin:<name>` of a provider the plugin contributes. |
| R4 | A failed uninstall hides that the entry is already unregistered, and the restart line (kimi 6) | Accept | The file is written before `npm uninstall`; an npm error then skips both printed lines. |
| R5 | After a failed uninstall `remove` cannot be repeated (complexity 27) | Reject | What remains is an installed package that nothing references. |
| R6 | Entries are loaded concurrently in `list` (complexity 6) | Accept; card 4 | A sequential loop is the smaller code. It is code shape, ruled with the simplifications. |
| R7 | The built-in clash is said to be invisible from one entry (complexity 7, glm N7) | Accept, record and comment | `loadPlugins` loads the always-loaded plugins first, so `plugin add` refuses a plugin that clashes with a built-in provider. The comment and Section 12 say the opposite. |

### Card 4 — shape, tests, and records

Deletions and folds in the source, each named by the adversary:

- `plugin/resolve.ts`: the exported entry resolver and the unread
  `packageName` field (2); the impossible `source !== 'npm'` check and the
  `notAName` wrapper (3); the package-name parser moves to
  `registry/provider-ref.ts`, the grammar's owner (55); the manifest is read
  once for `run` too, which removes the separate "not an object" check (9, 20).
- `plugin/manage.ts`: the exported result types (4); the empty `providers`
  array on a failed row (5); the policy narration in comments (7); the walk
  over `dispatchers[]` and `agents[]` replaced by the config module's
  collectors (53, 54).
- `plugin/run.ts`: the local `ENOENT` cast replaced by `isNotFound` (57).
- `platform/paths.ts`: the unused `root` argument of `pluginRoot` (10).
- `config/raw-file.ts`: the write goes through the existing
  `writeFileAtomic` instead of a truncating write (31).
- `cli/dreamux.ts`: the two-word match runs before the version manifest is
  read, and one comment says why (13, 38).
- `cli/commands/`: the restart sentence moves to `service-output.ts` (39);
  the redundant `demandOption` goes (37); `config/commands.ts` keeps the one
  ownership fact (14).
- `registry/provider-loader.ts`: the redundant package argument (56).

Tests:

- The bootstrap fake in `plugin-loader.test.ts` is installed again; the change
  to that suite had stopped faking `builtin:bootstrap` (kimi 11, glm S5).
- A built-CLI suite in the shape of `tests/bin-launcher.test.ts`: a scratch
  root whose config names a workspace package under an `npm:` ref prints the
  missing-package message; the restart line after `plugin add` and `plugin
  remove`; `plugin run` reaches the plugin with its options (glm S1, S6).
- `channel add`: an unknown key and an existing Dispatcher stay byte-identical;
  an existing agent id is refused; a plugin with several channels asks which
  (glm N3).
- `plugin remove` and `plugin add` with `{ ref, config }` and `#export`
  spellings; a `config` block that is refused (glm S4, kimi 2 and 3).
- The mode assertion that cannot fail goes; "starts nothing" asserts the
  child's output file is absent; the agent-in-use case asserts the file is
  unchanged (glm N1, N4).

Records:

- `final.md`: Sections 3, 4, and 10 still say Dreamux has no plugin install
  command and no plugin directory (complexity 19); Section 12's contradicted
  claims are corrected (49).
- The change file is written again with the accurate `Rebuild:` action (L5).
- `.agents/domains/state-config-and-files.md`: the plugin directory is not
  rebuildable from `plugins[]` alone (L5).
- `docs/configuration.md`, `docs/operations.md`, and
  `.agents/domains/provider-runtime.md` still describe the old lookup and do
  not list the commands (complexity 47).
- The product bullet and the maintenance reference each keep their own part
  once (complexity 44, 45, 60).
- `verification.md`: the ninth suite is named; the hand run records that the
  restart line was seen (glm N6, N8).

### Rejected, with the reason

| Finding (source) | Reason |
| --- | --- |
| A `bin` path can point outside the package (kimi 8) | The command runs the package's own code, which can already load any file. No boundary is crossed that running the plugin does not cross. |
| `plugin run --help` is taken as a package name (kimi 10) | The error says what was expected. A package name comes first, so a plugin's own `--help` must not be intercepted. |
| `windowsHide` and the signal fallback in `plugin run` (complexity 8) | Both are the launcher's own shape (`bin/dreamux`). |
| Extract the loader's per-plugin work so an entry loads without the built-ins (complexity 23) | It adds a seam to the loader for three callers; the built-ins are what makes a clash visible (R7). |
| The boolean pair of `PluginAddResult`, and the `CommandRunner` port (complexity 25, 26) | The command prints a change differently from a no-op; the runner is the existing seam every fake implements. |
| The existence probe before the read (complexity 30) | Code moved verbatim; not this change's. |
| The missing-config message's last clause (complexity 51) | One reader, one message. |
| Reuse onboarding's prompt collection and a selection primitive (complexity 34, 35, 59) | Onboarding's collection asks for the channel and for service registration too; a free-text choice with a membership check is the smaller code for a case no plugin needs today. |
| Earlier task records that state the stopped-daemon rule (complexity 48) | Task records are history. |
| The raw write must not re-encode with two spaces (complexity 17, in part) | The daemon's own write uses that encoding; values and order are what the tests pin. |

## Rulings so far

- Card 4 (shape, tests, and records), 2026-11-25: approved in full
  (“全部采纳”). Applied with the other cards, once they are ruled.
- Card 1 (the lookup), 2026-11-25, first answer: not ruled. The operator
  asked what keeping the current lookup would cost and stated a wider rule —
  the plugin directory is where `plugin add` installs, and a package the
  operator installed elsewhere may still be resolved. The TeamLeader probed
  the current lookup against that description: a package in npm's global
  directory is not found; what is found beyond the plugin directory is every
  ancestor's `node_modules` and `$HOME/.node_modules`. The card is sent again
  with three rules: the plugin directory first and Node's own resolution
  tolerated; two named places; the plugin directory only.
- Card 2 (`channel add`), 2026-11-25, first answer: “channel add 应该只改指定
  dispatcher 的 channel吧？其他所有配置项都不应该变”. Read as the correction
  proposed, the command touching only the Dispatcher it creates; the reading
  is played back on the second card.
- Card 3 (`plugin remove` and `plugin list`), 2026-11-25, first answer: not
  ruled; the operator asked for each item spelled out. Item R6 is code shape
  and falls under card 4.
- Card 1, second answer, 2026-11-25: ruled — “只认插件目录”. Correction L1 to
  L6 stands as written above.
- Card 2, second answer, 2026-11-25: “我很想告诉你不对，应该给已有 dispatcher
  加，不过按照咱们这样设计，其实 feishu channel 不应该出现在 onboard 里才对。不过
  这里我们还是先给已有 dispatcher 加吧。后面再梳理这块”. `channel add` adds
  the channel to an existing Dispatcher. This changes requirement behavior 12
  and Section 12 rule 6, so the requirement and the solution are confirmed
  again by card before the correction. C1 and C3 stand (the file is kept as
  it is, no doctor is proposed); C2 falls away, because no agent entry and no
  runtime are written for an existing Dispatcher. That the Feishu channel
  does not belong in onboarding is a follow-up outside this task.
- Card 3, second answer, 2026-11-25: not ruled; the operator asked what the
  problem is (R1, R2) and why an `npm:` prefix exists (R3). A third card
  states each from the configuration's shape. R4 is asked with the solution
  card.

## Cards

- **Card 1 — the lookup**: the package at its slot only; the entry selected
  from the manifest; the `Rebuild:` action and the missing-package message
  corrected.
- **Card 2 — `channel add`**: it appends to the file as it is, refuses an
  existing Dispatcher or agent id, and runs no doctor.
- **Card 3 — `plugin remove` and `plugin list`**: entries matched by package,
  the `config` phase, `npm:` provider refs in use, and the failed-uninstall
  report.
- **Card 4 — shape, tests, and records**: the deletions and folds above, the
  added suites, and the record corrections.
