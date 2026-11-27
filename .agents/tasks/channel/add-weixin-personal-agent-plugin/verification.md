# Verification

## Slice 2 — `team.last` (implemented and corrected after review, 2026-11-25)

Change: `packages/dreamux/src/service/team/` (`types.ts`, `teams-port.ts`,
`service.ts`, `index.ts`, `mcp.ts`),
`packages/dreamux/src/service/agent/activity.ts` and `agent/mcp.ts` (by the
operator's review rulings); `packages/dreamux/tests/team-last.test.ts` (new),
`team-mcp-results.test.ts`, `mcp-public-failures.test.ts`,
`mcp-result-projections.test.ts`, `tests/helpers/command-harness.ts`;
`.agents/domains/dispatcher-skill.md`, `.agents/domains/dispatcher-orchestration.md`,
`.agents/product/README.md`. What the review changed and why is in
`technical-design/review-s2-adjudication.md`.

### Commands and results

Run from the repository root on the worktree after `rush update`, after all
four review rulings were applied:

| Command | Result |
|---|---|
| `node common/scripts/install-run-rush.js build` | passed |
| `node common/scripts/install-run-rush.js lint` | passed |
| `node common/scripts/install-run-rush.js typecheck:tests` | passed |
| `node common/scripts/install-run-rush.js test` | passed; the live Codex model cases were excluded by default (`DREAMUX_RUN_LIVE_MODEL_GATE` unset), which the run reports |
| `node .agents/scripts/check.mjs` | exits 1 with one notice only: this task record is in an in-flight state, as expected until it becomes `done` |

The first run, before the review, passed the same four gates. The reviews
were then run on that state: three independent reports, adjudicated in
`technical-design/review-s2-adjudication.md`, with every correction applied
only after the operator's card ruling.

### What the tests prove

`packages/dreamux/tests/team-last.test.ts` constructs the real
`DispatcherService` and `TeamCollection`:

- a held TeamLeader is read mid-turn over two pages under one filter; the
  first page holds a completed and an in-progress message; `include_tools`
  is opt-in; after the reads the leader's turn is still unsettled, with one
  runtime and one input;
- an open Team is read before the Dispatcher starts, from its persisted
  leader identity, and `TeamService.rebuild` is not called;
- a closed Team is read from its record both while it is still held during
  teardown (its leader's stop held open) and after it is gone, and the held
  leader's read view is not consulted;
- a held leader with no session answers `ACTIVITY_SESSION_UNAVAILABLE`, and
  the provider is not asked;
- a closed record whose leader identity file is gone answers the same;
- a missing Team answers `TeamNotFoundError` through the tool, and `limit: 0`
  is the caller's mistake (`BAD_REQUEST`);
- after the Dispatcher closes, the read is refused with
  `ServerShuttingDownError`, like every other `TeamsPort` read.

The test edits in existing suites, each made under a review ruling:

- `team-mcp-results.test.ts`: `last` is added to the tools that must publish
  an output schema.
- `mcp-public-failures.test.ts` and `tests/helpers/command-harness.ts`: the
  sweep that poisons every owning entry point and calls every advertised tool
  covers `team` `last`; each server's `last` now gets its own arguments, where
  one shared entry carried both addressees. The `teammate.last` row states the
  tool's narrowed result through the table's existing `expectedMcp` column; the
  Command's expected value is unchanged.
- `mcp-result-projections.test.ts`: the `teammate` `last` projection expects
  activity and paging only; the assertion is still an exact `toEqual`.
- Unchanged and passing: `team-leader-status.test.ts`,
  `core-command-registry.test.ts`, `team-collection-read-path.test.ts`,
  `team-dissolve-behavior.test.ts`, `agent-activity-metadata.test.ts`,
  `failure-classification.test.ts`.

### Coverage limits and residual risks

- No test observes a real runtime's in-progress turn through `team.last`; the
  provider boundary is stubbed, as it is for `teammate` `last`.
- No test observes that a held leader's read uses the launch's provider and
  config rather than the current configuration; the read passes the launch,
  as `teammate.last` does, but the fixture's two sources are the same object.
- The window in which a Team is still being created is not pinned by a test.
- The live Codex model cases were not run.
- `teammate last` returning activity only is a model-facing contract change
  for every Dispatcher and TeamLeader; it is recorded in the product catalog
  and needs its change note at closeout.

## Slice 1 — the plugin

Not implemented; not authorized.

## Slice 3 — `dreamux plugin` and `dreamux channel` commands (implemented 2026-11-25, before review)

Change, under `packages/dreamux/src/`: `platform/paths.ts` (`pluginRoot`);
`plugin/resolve.ts`, `plugin/manage.ts`, `plugin/run.ts` (new) and
`plugin/loader.ts`; `registry/provider-loader.ts`; `config/raw-file.ts` (new),
`config/load.ts`, `config/commands.ts` (a comment); `onboard/channel-add.ts`
(new), `onboard/wizard.ts` (one export); `cli/commands/plugin.ts`,
`cli/commands/channel.ts` (new), `cli/commands/onboard.ts` (one export),
`cli/commands/index.ts`, `cli/dreamux.ts`. Tests, under `packages/dreamux/tests/`:
`plugin-commands.test.ts`, `onboard-channel-add.test.ts`,
`helpers/npm-packages.ts` (new), `plugin-loader.test.ts`,
`doctor-plugins.test.ts`. Records: the change file, the maintenance reference
and `SKILL.md`, `.agents/product/README.md`, `.agents/domains/plugins.md`,
`.agents/domains/state-config-and-files.md`, `packages/dreamux/CLAUDE.md`.
What is outside the boundary listed on the authorization card is named in
the task README and in `technical-design/final.md` Section 12.

### Commands and results

| Command | Result |
|---|---|
| `node common/scripts/install-run-rush.js build` | passed |
| `node common/scripts/install-run-rush.js lint` | passed (ESLint, Prettier, the import-direction gate, and the unused-export check) |
| `node common/scripts/install-run-rush.js typecheck:tests` | passed |
| `node common/scripts/install-run-rush.js test` | passed; the live Codex model cases were excluded by default |
| `init_task.py check --allow-in-flight` | passes for this record |

The nine suites related to this slice pass together: 136 tests.

Before formatting, the first lint run failed on Prettier in five new files
and the first `typecheck:tests` failed on two type errors in
`onboard-channel-add.test.ts`; both were corrected and the gates were re-run.

### What the tests prove

`plugin-commands.test.ts` writes real plugin packages under a temporary
Dreamux root's `plugins/node_modules/` and fakes only `npm`:

- the lookup: an `npm:` plugin and an `npm:` channel provider are imported
  from the plugin directory, and a missing package fails at phase `import`
  naming `dreamux plugin add`;
- `plugin add`: the `npm` arguments; the entry appended once, with every other
  key, key order, the two-space encoding, and mode `0600` unchanged;
  `plugins[]` added when absent; a package already present not installed
  again; a registered plugin with no package repaired; a registered and
  installed one left alone; nothing registered for a package that is not a
  plugin or when `npm` fails; an argument that is not a package name refused
  before `npm` runs; a missing `config.json` named; a malformed `plugins[]`
  refused with the daemon's own message and nothing rewritten;
- `plugin remove`: a channel in use and an agent runtime in use refused with
  nothing changed; the entry removed and the others left as spelled; the
  file written before the uninstall; a plugin that does not load removed; an
  unregistered plugin refused; the entry left removed when the uninstall
  fails;
- `plugin list`: one row per entry with its providers, or why it does not
  load;
- `plugin run`: a string `bin` and a one-entry `bin` run with the arguments
  exactly as given (options, numbers, and slashes included), in the calling
  directory and environment, and the child's exit code returned; `bin` with
  several entries or none refused; a package that is installed but not
  registered run; the forwarding without a package name refused.

`onboard-channel-add.test.ts` (real plugin package, faked prompts and
runner):

- a new Dispatcher is written with the channel, the provider's configuration
  as its `onboard.collect` asked it, and its own agent, and the existing
  Dispatcher keeps its configuration;
- an existing Dispatcher id, a plugin with no channel, an unregistered
  plugin, and the absence of a terminal are each refused.

A second defect was found by reading the code before review: a `plugins[]`
item that was neither a string nor an object was skipped on rewrite, so the
command would have dropped it silently. `plugins[]` is now checked with the
daemon's own parser before any command changes the file, and a suite covers
it.

Through the built CLI, by hand, in a scratch Dreamux root with one plugin
package linked into the plugin directory by hand (`node
packages/dreamux/bin/dreamux`): `plugin add` registered it and left the other
keys as written; a second `plugin add` changed nothing; `plugin run … login
--qr -n 5 a/b` reached the plugin's command line with those arguments and
the child's exit code 3 came back; `plugin run` on an absent package and
`plugin add acme@1.0.0` were refused with the expected messages; `plugin
list` showed the entry; `plugin remove` unregistered it and a real `npm
uninstall` (npm 10.9.2) removed the link. That run found a third defect, in
a line no suite covers: `plugin remove` printed the returned object instead
of its ref (`unregistered [object Object]`). Corrected and re-run.

The first run of this suite found a defect: `plugin list` and the in-use
check of `plugin remove` read the first plugin `loadPlugins` returned, which
is the always-loaded Feishu plugin, not the entry's. Loading one entry now
selects the entry's plugin.

### Coverage limits and residual risks

- No suite observes that plain Node refuses a package outside the plugin
  directory. Vitest resolves `require.resolve` through its own resolver,
  which also reaches the workspace's packages. Checked by hand in plain Node:
  from an unrelated directory, a package installed only globally and one
  present only in the workspace are both `MODULE_NOT_FOUND`, with and without
  an explicit `paths` option.
- `npm` itself never runs in a suite. Its `--prefix` layout (`package.json`,
  lock file, `node_modules/<package>`), uninstall of a package it did not
  record, and resolution through `createRequire` from that directory were
  checked by hand with npm 10.9.2 in a scratch directory.
- `npm` as the command `npm` on PATH is not verified on Windows.
- `channel add`'s prompts are faked; no suite drives the real terminal
  prompts, the exit code through `bin/dreamux`, or `dreamux plugin run` from
  the built CLI.
- `plugin run` is read before the argument parser, and the command modules'
  `console.log` lines, are covered by the hand run above, not by a suite.
- The lost-entry window is not tested, by the operator's ruling.


### 2026-11-27 — the tree as submitted

- The four gates (build, lint, test, `typecheck:tests`) pass on the tree the
  pull request carries, which is slice 3 as implemented before review: no
  review correction is applied.
- The first coverage limit above overstates what the hand check showed. It
  ran from a scratch directory with no `node_modules` above it. The reviews
  found, and the TeamLeader reproduced in plain Node, that the lookup reaches
  every ancestor's `node_modules` and Node built-in names
  (`technical-design/review-s3-adjudication.md`, L1); the correction is ruled
  (“只认插件目录”) and not applied. The same goes for `channel add`
  discarding configuration keys it did not add (C1).
