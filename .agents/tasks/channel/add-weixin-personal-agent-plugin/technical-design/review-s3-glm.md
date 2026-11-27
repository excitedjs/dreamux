# Review — slice 3: `dreamux plugin` and `dreamux channel add` (tests and correctness)

Reviewed on 2026-11-25 against `requirement.md` behaviors 9 to 13 and acceptance
criteria 9 to 15, `technical-design/final.md` Section 12, and the "Slice 3"
section of `verification.md`. Slice 2 files were left out.

**Summary: 0 blocking, 6 should-fix, 9 nits.** Focused run of the eight named
suites: 8 files, 133 passed, 0 failed. Whole package with `npx vitest run`:
118 files (7 failed, 106 passed, 5 skipped), 7 failed, 1385 passed, 46 skipped;
all seven are `Test timed out in 5000ms` under file parallelism. The same
whole package with the flag its own `test` script uses
(`--fileParallelism=false`): 118 files (113 passed, 5 skipped), 1392 passed,
46 skipped, 0 failed.

No mutation was applied to the repository. The mutations below were applied one
at a time to a scratch copy of `packages/dreamux/src` under the system temp
directory, with copies of the suites, and run from `packages/dreamux`. 62
mutations were applied: 48 were caught by at least one test and 14 survived.

## Should-fix

### S1. The word "only" in the lookup rule is pinned by no suite (test finding; questions 2 and 3)

- Files: `src/plugin/resolve.ts:39-50`, `tests/plugin-commands.test.ts:129-172`,
  `tests/helpers/npm-packages.ts:16-19`,
  `tests/official-provider-entries.test.ts:94-141`,
  `tests/channel-service.test.ts:265-268`.
- Mutation that survives: in `resolveNpmPackageEntry`, when the plugin
  directory has no such package, fall back to
  `require.resolve(packageName, { paths: [<Dreamux's own src/plugin directory>] })`.
  That is the old lookup kept as a second place, which Section 12 lists under
  "Not in this slice: … a second lookup place". All 133 tests in the eight
  suites pass with it. Replacing the lookup instead of adding to it is caught
  (14 tests fail), so the suite pins "the plugin directory is tried first",
  not "nowhere else".
- Why the suite cannot see it: under vitest, `require.resolve` is not answered
  by Node's lookup from the directory given to `createRequire`. In a vitest
  worker with `DREAMUX_ROOT` pointing at an empty directory,
  `hasNpmPackage('yargs')`, `hasNpmPackage('vite')` and
  `hasNpmPackage('@excitedjs/agent-runtime-codex')` all return `true`
  (`vite` is not even a dependency of this package). I describe the effect
  only: I did not find where the installed runner substitutes the resolver.
  `process.getBuiltinModule('node:module').createRequire` is the same function
  and behaves the same, so there is no in-process way back to Node's lookup.
- Consequence for two unchanged suites:
  `official-provider-entries.test.ts:94` ("loads configured unqualified official
  npm providers alongside always-loaded plugins") loads
  `npm:@excitedjs/agent-runtime-codex` and two more from a `DREAMUX_ROOT` with
  no plugin directory, and `channel-service.test.ts:265` does the same for
  `npm:@excitedjs/feishu-channel`. Both are green only under the runner, and
  both now state the opposite of the change note's `BREAKING:` sentence.
  `final.md` records this as a known limitation, on the premise that no suite
  can observe the rule. That premise is wrong (next bullet).
- The delivered behavior is right. Run in plain Node: the current
  `resolve.ts`, bundled from the working tree, refuses `@excitedjs/dreamux-utils`
  and `yargs` from a root with no plugin directory, imports a copy written into
  the plugin directory, and the old lookup from Dreamux's own directory does
  reach the same packages. The built CLI agrees: `plugin list` on a root with
  no plugin directory prints `cannot be loaded: … is not in the Dreamux plugin
  directory; run: dreamux plugin add …` for `npm:@excitedjs/feishu-channel` and
  `npm:@excitedjs/agent-runtime-codex`.
- A real child Node process, with no dependency, is available in a shape this
  package already uses: `tests/bin-launcher.test.ts:34-43` requires the built
  `dist` (and fails with "run 'rush build'" without it) and `:56` runs
  `bin/dreamux` with `process.execPath`. A vitest worker has `NODE_OPTIONS`
  unset and passes no loader to children, so such a child is plain Node. A case
  there — a scratch `DREAMUX_ROOT`, a `config.json` naming a workspace package
  under an `npm:` ref, `plugin list` expected to print the `plugin add` message
  — would fail on S1's mutation. The same lane fits the commands in N6.
- A second, in-suite option pins the other half without a child: write a decoy
  into `<root>/plugins/node_modules/` under the name of a package that exists
  elsewhere (`@excitedjs/dreamux-utils`), and assert `importNpmPackage` returns
  the decoy. I checked that this holds under vitest today (the plugin
  directory's copy is the one resolved and imported), so the case would be
  discriminating rather than vacuous.
- Not viable: bundling or type-stripping the source for a child needs a tool
  this package does not declare, and a test-local copy of the three lookup
  lines is the "local mirror" `.agents/domains/unit-testing.md` bans.

### S2. `channel add` deletes every top-level key other than `plugins`, `agents`, `dispatchers` (correctness, separate from tests)

- Files: `src/onboard/channel-add.ts:58-76`, `src/onboard/run.ts:69-87`,
  `src/onboard/config-files.ts:61-65`.
- Input: `config.json` with `plugins`, `agents`, `dispatchers` and one more
  top-level key (`x_handwritten`), then `channel add`. Output: the file has
  keys `plugins`, `agents`, `dispatchers` only. I ran the success case of
  `onboard-channel-add.test.ts` with that key added to its input: the command
  succeeds and the key is gone, and the test still passes, so nothing in the
  suite notices.
- Cause: `channel add` writes through `runOnboard`, which builds the typed
  configuration and writes `stringifyConfig` of it. `plugin add` and
  `plugin remove` write the raw object and keep unknown keys; `channel add`
  does not. `src/config/raw-file.ts:7-9` names only those two commands.
- Against the record: acceptance criterion 10 says "`config.json` keeps every
  key the commands did not add", and it names both commands. The criterion's
  stated scenario is a fresh installation, where `dreamux onboard` created the
  file and there is no other key to lose, and `dreamux onboard` behaves the
  same today. So this is a requirement decision rather than a defect in the
  code: either `channel add` keeps the other keys, or the criterion, the
  product entry and the maintenance reference say it writes the file as
  `dreamux onboard` does. Section 12's "As implemented, beyond the boundary as
  approved" records what the command does to existing Dispatchers, not this.
- Either way no test covers the answer.

### S3. `plugin remove` uninstalls a package that a Dispatcher still addresses by an `npm:` provider ref (correctness, separate from tests)

- Files: `src/plugin/manage.ts:179-211` (`useOf`), `:114`.
- Input: `plugins: ["npm:@acme/chan"]` and a Dispatcher whose channel is
  `{ provider: "npm:@acme/chan#createSession" }`; or `plugins: ["npm:@acme/chan"]`
  and `agents: [{ id: "main", provider: "npm:@acme/chan" }]`. Then
  `plugin remove @acme/chan`.
- Output (both inputs, run): `removed`, `plugins` becomes `[]`, and
  `npm uninstall @acme/chan --prefix <plugin directory>` runs while the
  Dispatcher's channel (or the agent) still names the package. At the next
  start that Dispatcher fails with the `plugin add` message, which is the
  outcome behavior 10's refusal exists to prevent.
- Cause: `useOf` compares against `builtin:<provider name>` only. An `npm:`
  provider ref is a second legal way to address the same package, and the
  change note puts "provider package" under the same lookup rule.
- `final.md` rule 4 defines a use as a contributed provider, so the code
  matches the approved design; the design did not consider this form. No test
  covers it.

### S4. No test has the command's own plugin registered as `{ ref, config }` (test finding)

- Files: `src/plugin/manage.ts:74`, `:100`, `:158-160`;
  `tests/plugin-commands.test.ts:175-208` (the object-form entry at `:180` is
  another plugin), `:323-346` (the removed entry is the string one).
- Mutations that survive: `registered` computed with
  `pluginItems(raw).includes(ref)` (a string-only match), 79 of 79 pass; the
  same for the "is it registered" check of `remove`, 79 of 79 pass.
- What that hides: under the first mutation `plugin add` on a plugin that is
  already listed as `{ ref, config }` appends a second entry, and the daemon
  then refuses the file ("declared by both"). Under the second, `plugin remove`
  answers "is not registered" for such an entry.
- The current behavior is right: I ran it — `registered: false`, file
  byte-identical, no `npm` call. The gap is in the suite only.

### S5. `plugin-loader.test.ts` no longer fakes the bootstrap plugin; two tests now load the real package (question 1)

- Files: `tests/plugin-loader.test.ts:5-9` (header), `:139-143`
  (`BUILTIN_PACKAGE_NAMES`), `:218-219`, `:821-822`.
- Before the change `installModules` called `vi.doMock` for every name it was
  given. Now only the three names in `BUILTIN_PACKAGE_NAMES` are mocked;
  `@excitedjs/dreamux-plugin-bootstrap` is not among them and is not an `npm:`
  entry either, so the fake written for it at `:218-219` and `:821-822` is
  never used. `builtin:bootstrap` goes through the plain import and loads the
  real dev-dependency package.
- Evidence: renaming both fakes to `bootstrap-fake` leaves the suite at 42 of
  42 passing; the `bootstrap` name in the assertion at `:228` comes from the
  real package.
- Effect: the two tests named below depend on a real package load, and the
  header's "no real plugin package is imported" is no longer true. No
  assertion changed (see "Verified", question 1). Adding the package name to
  `BUILTIN_PACKAGE_NAMES` restores the old supply.

### S6. The command layer has no suite, and the restart hint has no recorded evidence (questions 2 and 7)

- Files: `src/cli/dreamux.ts:24-28`, `src/cli/commands/plugin.ts:16-17`,
  `:57-70`, `:79-82`, `src/cli/commands/channel.ts:35-40`.
- No test file imports `createPluginCommand`, `createChannelCommand` or
  `createDreamuxCommands`. Mutations that survive (79 of 79 each): `plugin add`
  prints no restart hint; `plugin remove` prints the result object instead of
  its ref (the defect the hand run found, `verification.md:174-176`); `plugin
  run` left to the argument parser.
- Behavior 9's last sentence ("The command's output says so and names
  `dreamux daemon restart`") is therefore covered by no suite, and the hand run
  recorded at `verification.md:166-176` does not say the line was observed.
- I observed it through the built CLI in a scratch root with a stand-in `npm`
  on `PATH`: `plugin add` prints `installed and registered npm:@acme/cli` and
  the hint line, exit 0; a second `plugin add` prints `is already registered`
  with no hint; `plugin remove` prints `unregistered npm:@acme/cli` and the
  hint; `plugin run @acme/cli --version` reaches the plugin (exit 3) rather
  than Dreamux's version. `channel add` needs a terminal and was not driven.
- The built-CLI shape from S1 covers this layer too, stand-in `npm`
  included. `verification.md:199-200` lists the console lines as a limit;
  whether a requirement sentence may rest on that is the TeamLeader's call.

## Nits

- **N1. The mode assertion cannot fail.**
  `tests/plugin-commands.test.ts:205-207`. The fixture is created `0600`,
  `assertConfigFileMode` refuses any other mode before the command runs, and
  `writeFile`'s `mode` applies only to a new file. Mutation: `mode: 0o644` in
  `writeConfigJson` (`src/config/raw-file.ts:41`), 79 of 79 pass. The behavior
  is right; the claim at `verification.md:130-131` ("mode `0600` unchanged")
  is not something the test shows.
- **N2. Assertions inside the fake, and the recorded config text (question 4).**
  `tests/plugin-commands.test.ts:68` (`expect(command).toBe('npm')` inside
  `FakeNpm.run`) is effective but indirect: with `install` run as `npx`, five
  tests fail; with `uninstall` as `pnpm`, three fail. Each fails on a
  rejected `addPlugin` or `removePlugin` carrying a runner assertion, not on
  an assertion of the test. Recording the command in `calls` and asserting it
  in the tests that expect a call would say the same thing where it reads.
  The config text recorded at an `npm` call is read by exactly one test,
  `:339-345`, and there it is meaningful: with the uninstall moved before the
  write, that test fails. No `add` test compares the text recorded at call
  time; the order install, proof, write is pinned there by the two failure
  tests instead (`:253-266`; a mutation writing the entry first fails both).
- **N3. The prompt answers are a queue, not answers to prompts (question 5).**
  `tests/onboard-channel-add.test.ts:76-81`, `:131-137`. The fake ignores
  `options.message` and shifts. Insertion and reorder are caught all the same:
  a prompt asked before the agent runtime one, one asked after the write, and
  the working directory asked before the id each fail the success case (the
  one asked after the write because the queue runs out and the fake throws),
  and every answer is observed in a distinct output slot. What survives: the
  agent runtime prompt's label emptied or listing channel providers, its
  default dropped, the working directory default dropped, `startService: true`
  (harmless: nothing starts without the registration that is pinned), and a
  multi-channel plugin silently taking its first channel (the `askChannel`
  path has no test). Answering by message would make a failure name the
  prompt.
- **N4. Two claims wider than their assertions.**
  `tests/plugin-commands.test.ts:444-453` is titled "…and starts nothing" but
  asserts only the rejections; nothing checks that the child's output file was
  not written. `:316-321` ("refuses while an agent uses a runtime…") asserts
  the message and no `npm` call, not that the file is unchanged, unlike its
  channel twin at `:302-314`.
- **N5. `plugin add` on a package that is a provider module installs it and
  then fails.** `src/plugin/manage.ts:69-73`. Input: a package whose default
  export returns a provider. Output (run): `npm install` runs, then
  `failed during factory: plugin factory must return an object with a
  non-empty string name`, exit 1, package left installed, `plugins[]`
  unchanged, and the `npm:<package>` provider ref then loads. So the change
  note's `Rebuild: dreamux plugin add <package>` does repair an `npm:`
  provider, but through an error that reads as the opposite. Section 12's
  table describes this outcome; only the wording misleads.
- **N6. A package in a `node_modules` above the Dreamux root counts as "in
  the plugin directory".** `src/plugin/resolve.ts:41`. `createRequire` walks
  up from `<dreamux root>/plugins`, so a package in `<dreamux root>/../node_modules`
  is found (run in plain Node), and `plugin add` then says it is already
  there. `NODE_PATH` is not honored. Low likelihood; it is the one gap between
  the rule's wording and the code.
- **N7. Two comments and one message are wider or narrower than the code.**
  `tests/helpers/npm-packages.ts:18-19` says a suite names only packages that
  exist nowhere; `channel-service.test.ts` and
  `official-provider-entries.test.ts` name real workspace packages. The
  missing-file message reused by the plugin commands (`src/config/raw-file.ts:17-22`)
  ends "before starting the server". `final.md:687-689` says a clash with a
  built-in provider is not visible from one entry; it is, and `plugin add`
  refuses such a plugin (run: `provider "feishu" is contributed by plugin
  "clash" and by plugin "feishu"`), which is the better outcome.
- **N8. `verification.md:116` says "nine suites … 136 tests".** The eight
  suites named for this review total 133 (25, 5, 42, 7, 16, 7, 11, 20). The
  ninth is not named, so that number cannot be checked.
- **N9. "Installed" means the entry file resolves, not that the package
  loads.** `src/plugin/manage.ts:69`. If an install was interrupted and the
  entry resolves while a dependency is missing, `plugin add` refuses at the
  proof load and does not install again. Read from the code, not run.

## Verified

- **Question 1.** `git diff` of `plugin-loader.test.ts` and
  `doctor-plugins.test.ts` contains no added or removed `expect`, `toThrow`,
  `toEqual`, `toBe`, `toContain` or `toMatch` line. No assertion changed in
  text. Two changed in what reaches it:
  - `plugin-loader.test.ts:406-412` and `:485` ("a failing import",
    `npm:@acme/missing`): before, the bare import failed because no mock was
    installed for that name; now `importFakeNpmPackage` throws because the
    map has no entry. Same phase (`import`), same message pattern. Neither
    version runs the resolver.
  - `plugin-loader.test.ts:218-219`, `:821-822`: see S5.
  - `doctor-plugins.test.ts:297-331`: the fake module became a real package
    written into the test's real plugin directory (`DREAMUX_ROOT` is set at
    `:191`), so the case now runs the real lookup. The `try/finally` around
    `doUnmock` went with the mock. Confined to supply, and stronger.
  - Against the source contract: the old supply could not have survived the
    source change — under the new `constructPlugin` the bare-name mocks are
    never consulted — so the rewrite was forced, and the assertions are the
    old ones. Reverting `constructPlugin` to a bare import fails 43 of the
    79 tests in the four suites, nearly all of them in `plugin-loader.test.ts`,
    so it still discriminates.
- **Question 2.** Every test in the two new suites fails under at least one
  mutation of the behavior it names, except where S1, S4 and N1 to N4 say
  otherwise. Caught, among others: proof load skipped or run on another plugin;
  install always run or run without `--prefix`; entry written before the
  install and proof; each half of the in-use check; uninstall before the write;
  entry left in `plugins[]` or other entries dropped; unknown key dropped by
  `plugin add`; malformed `plugins[]` not refused; the entry's plugin read as
  the first loaded one; an entry that does not load listed as loaded; the
  lookup moved to Dreamux's own module or back to a bare import; the missing
  package message; child started elsewhere, with an empty environment, without
  its arguments, or with its exit code replaced; multi-entry and absent `bin`
  accepted; each refusal of `channel add`; the wrong provider written; the
  provider's collected value not reached; the wrong registry passed to
  onboarding; service registration left on.
- **Question 3.** The account is accurate in effect and understated (S1): the
  runner's resolution reaches this package's dependencies, vitest's own, and
  the workspace. A child-process suite is possible with no dependency (S1).
- **Question 4.** See N2.
- **Question 5.** See N3.
- **Question 6.** Counts are in the summary line. The seven timeouts of the
  parallel run include four suites this slice does not touch (`uninstall`,
  `daemon`, `state-schemas`, `channel-service`) and disappear with
  `--fileParallelism=false`; the one I compared, in `doctor-plugins`, took
  0.5 s there against 5.2 s when it timed out. They are load on this machine,
  not this change.
- **Question 7.** Behaviors 9 to 12 and criteria 10, 12 (repair), 13 and 14
  are each covered by a suite, by the recorded hand run, or by S2's pending
  decision. What is not: the restart hint (S6); criteria 11 and 15 with the
  daemon running; the first half of criterion 12; criterion 9. See "Coverage
  limits".
- **Question 8.** S2, S3, N5, N6, N9.
- `src/config/load.ts`: `readConfigFile` now calls `readConfigJson`; the
  existence, mode and parse messages are the same strings moved, nothing else
  in the function changed.
- The change file leads with `BREAKING:`, carries `Rebuild:`, and is type
  `minor` on a 0.x package. The maintenance reference, `SKILL.md`,
  `.agents/domains/plugins.md`, `.agents/domains/state-config-and-files.md`
  and the package `CLAUDE.md` state the plugin directory, the commands that
  write `config.json` while the daemon runs, and the lost-entry window in
  place of the stopped-daemon rule.
- `dreamux uninstall` removes the config directory, which is the Dreamux
  root, so the new `plugins/` directory goes with it.

## Coverage limits

- No suite runs a command with the daemon running (criteria 11 and 15). No
  command reads daemon state, so the risk is low, but no run is recorded.
- Criterion 9 (the operator's live end-to-end check) is not automated by
  design and is not recorded for this slice.
- No suite runs `dreamux serve` or `dreamux doctor` against a registered
  plugin whose package is missing (criterion 12, first half). I ran `plugin
  list` in that state, not `doctor`.
- `channel add` was not driven through the built CLI or real prompts; its
  multi-channel path is untested (N3).
- `plugin run`: inherited standard streams, exit by signal, and a `bin` that
  is not a JavaScript file are not observed.
- Real `npm`, its `--prefix` layout, and `npm` as a PATH command on Windows
  are not exercised by any run of mine. My CLI runs used a stand-in `npm`.
- The lost-entry window is untested by the operator's ruling.
- The mutations were run on a copy, with the four suites of this slice for
  most and all eight for S1; the whole package was not run under mutation.
- The record's "nine suites, 136 tests" could not be reproduced from the
  eight suites named (N8).
