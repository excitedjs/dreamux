# Slice 3 correctness review

**Summary: 4 blocking findings, 5 should-fix findings, and 2 nits.** I ran `npx vitest run tests/plugin-commands.test.ts tests/onboard-channel-add.test.ts tests/plugin-loader.test.ts tests/doctor-plugins.test.ts` from `packages/dreamux`: all 4 files and 79 tests passed. I also exercised the built CLI's plugin help/no-package paths and used plain Node probes in temporary directories for package resolution and path normalization. I did not run a real npm install or any network operation.

## Findings

### 1. Blocking — `channel add` discards configuration keys it did not add

**Location:** `packages/dreamux/src/onboard/channel-add.ts:76`, through `packages/dreamux/src/onboard/run.ts:70,183-188` and `packages/dreamux/src/onboard/config-files.ts:61-65`.

**Concrete sequence:** Start with a valid `config.json` containing a registered channel plugin and an unrelated key such as:

```json
{
  "x_handwritten": { "note": "keep me" },
  "plugins": ["npm:@acme/channel"],
  "agents": [],
  "dispatchers": []
}
```

Run `dreamux channel add @acme/channel` and complete the prompts.

**Wrong outcome:** The new Dispatcher is created, but `x_handwritten` disappears. Unknown keys on existing wrapper entries are likewise reconstructed rather than preserved. This violates acceptance criterion 10: "`config.json` keeps every key the commands did not add."

**Evidence:** `addChannel` delegates the write to `runOnboard`. `readExistingDreamuxConfig` returns only `(await loadConfig()).config`, not the raw object. `dreamuxConfigFromAnswers` then constructs a new object containing exactly `plugins`, `agents`, and `dispatchers`; there is no spread of the raw top-level object. The new raw-file preservation used by `plugin add` is therefore bypassed. The pre-existing rule that `dreamux onboard` may discard unknown wrapper fields does not satisfy the new command's explicit acceptance criterion.

### 2. Blocking — package-name commands cannot address a plugin registered with `#export`

**Location:** `packages/dreamux/src/plugin/manage.ts:74,100,112` and `packages/dreamux/src/onboard/channel-add.ts:31-37`.

**Concrete input:**

```json
{
  "plugins": [{ "ref": "npm:@acme/channel#createPlugin" }],
  "agents": [],
  "dispatchers": []
}
```

Then run `dreamux channel add @acme/channel` or `dreamux plugin remove @acme/channel`.

**Wrong outcome:** Both commands say that `npm:@acme/channel` is not registered, although the package's plugin is registered through a spelling the loader explicitly accepts. Behavior 12 makes the argument the npm package name of the registered plugin; it does not exclude named-export plugins. Running `plugin add @acme/channel` can additionally append a second, default-export entry rather than recognizing the existing package registration.

**Evidence:** `readPluginEntries` accepts `npm:<package>#<export>` (`plugin/loader.ts:105-137`), and `constructPlugin` selects that export (`plugin/loader.ts:227-258`). The new commands instead construct only `npm:${name}` and compare whole strings. If multiple export entries from one package are meant to be unsupported by `remove`, that ambiguity needs an explicit rule; silently reporting that the registered package is absent is incorrect.

### 3. Blocking — `list` and `remove` skip the entry's `config.read` load phase

**Location:** `packages/dreamux/src/plugin/manage.ts:103,123-137,166-172,183-189`.

**Concrete input:** Register an object entry whose plugin contributes `channel:acme` and whose `config.read` rejects the supplied value:

```json
{
  "plugins": [
    { "ref": "npm:@acme/channel", "config": { "size": "bad" } }
  ],
  "agents": [{ "id": "main", "provider": "builtin:codex" }],
  "dispatchers": [
    {
      "id": "personal",
      "cwd": "/srv/personal",
      "agentRuntime": "main",
      "channels": [
        { "id": "primary", "provider": "builtin:acme" }
      ]
    }
  ]
}
```

**Wrong outcome:**

- `dreamux plugin list` prints the plugin name and providers as though it were loadable, while `dreamux serve` and `dreamux doctor` reject its `config` phase. This contradicts behavior 10 and acceptance criterion 14.
- `dreamux plugin remove @acme/channel` refuses because it sees the configured provider use. Section 12, rule 4, says a plugin that does not load contributes nothing a running Dispatcher can use and is removed. The import/factory/contribute failure paths take that approved removal path; the config failure path does not.

**Evidence:** `listPlugins` reduces each object entry to `itemRef(item)` and `loadAlone` constructs `entries: [{ ref }]`, discarding the entry's `config`. Neither caller invokes `readPluginConfigs`. The real config pipeline does invoke it after provider resolution (`config/load.ts:70-71`), and `readPluginConfigs` raises `PluginLoadError` with phase `config` (`plugin/loader.ts:200-224`). The maintenance and product statements that `list` says whether each listed plugin loads inherit this incorrect result.

### 4. Blocking — the `BREAKING:` rebuild action does not repair standalone npm providers

**Location:** `common/changes/@excitedjs/dreamux/dreamux-team-space-dreamux-vaei_2026-11-25-11-49.json:4`; the same incomplete recovery assumption appears in `.agents/domains/state-config-and-files.md:185-189`.

**Concrete sequence:** An existing installation has a standalone provider ref such as `npm:@excitedjs/feishu-channel` in `dispatchers[].channels[].provider`, with that package reachable only from Dreamux's old install lookup. After the upgrade, follow the note literally: run `dreamux plugin add @excitedjs/feishu-channel`, then start the daemon.

**Wrong outcome:** The npm install step may place the package in the right directory, but `plugin add` then fails its plugin proof because this package's default export is a ChannelProvider factory, not a Dreamux plugin factory. An attended upgrade following the change file therefore stops on a failed recovery command rather than obtaining a confirmed rebuild. The note covers every npm package named by config, so it must also give provider-only refs a valid installation action.

**Evidence:** `addPlugin` always calls `loadAlone(ref)` after installation (`plugin/manage.ts:69-74`). That path requires a plugin factory and a returned plugin object with a `name` (`plugin/loader.ts:227-305`). In contrast, standalone providers select the default export as a provider factory (`registry/provider-loader.ts:158-171`). The maintenance reference itself documents the official packages' package-root default provider factories (`references/config-envelope.md:120-126`). The `BREAKING:` classification and `minor` change type are correct: the new reader cannot start with an affected package until its location is repaired. It is the `Rebuild:` action that is insufficient.

The domain page's statement that `plugins/` is rebuildable from `plugins[]` by rerunning `plugin add` is also too broad: standalone providers are not in `plugins[]`, and a named-export entry cannot be restored unchanged by a command that appends only the default `npm:<package>` ref.

### 5. Should-fix — import-only ESM packages cannot be resolved

**Location:** `packages/dreamux/src/plugin/resolve.ts:39-49`.

**Concrete input:** Install a package in the plugin directory with this manifest:

```json
{
  "name": "@acme/esm-plugin",
  "type": "module",
  "exports": { ".": { "import": "./index.js" } }
}
```

**Wrong outcome:** `plugin add` and daemon loading fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although the previous plain dynamic `import(packageName)` supports this standard ESM package shape. This is more than the approved dual-format limitation (choosing a CommonJS entry when both exist): a package with only an import condition has no loadable entry at all under the new lookup.

**Evidence:** `createRequire(...).resolve(packageName)` selects require resolution conditions before the code dynamically imports the resulting file. A plain Node probe against the manifest above produced `ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined`. The focused tests use packages with a plain `main`, so they do not cover this shape.

### 6. Should-fix — an uninstall failure hides the completed config removal and restart requirement

**Location:** `packages/dreamux/src/plugin/manage.ts:110-115` and `packages/dreamux/src/cli/commands/plugin.ts:78-82`.

**Concrete sequence:** Run `dreamux plugin remove @acme/channel` when the config write succeeds but `npm uninstall` fails, for example because the plugin directory cannot be modified.

**Wrong outcome:** `plugins[]` has already lost the entry, but the CLI prints only the npm error. It does not say that unregistration completed and does not print `RESTART_HINT`. Section 12's test contract explicitly says that a failed uninstall "leaves the entry removed and says so"; the unit test checks only the thrown error and file state, not the required reporting. The maintenance statement that the command's last line states the next-start rule is also untrue on this path.

**Evidence:** `removePlugin` awaits `writeConfigJson` and then awaits `runner.run('npm', ['uninstall', ...])`. The two success `console.log` calls are after that awaited function returns, so an npm rejection skips both even though the config mutation is durable.

### 7. Should-fix — a relative `DREAMUX_ROOT` breaks package resolution

**Location:** `packages/dreamux/src/plugin/resolve.ts:40-43`, with the unrestricted root override at `packages/dreamux/src/platform/paths.ts:79-82,131-133`.

**Concrete input:** Set `DREAMUX_ROOT=.dreamux` and place a valid package under `.dreamux/plugins/node_modules`.

**Wrong outcome:** npm plugin/provider lookup throws Node's invalid-argument error before it can resolve the package. `plugin add` can fail before its install step, and configured plugins/providers fail to load. Other file operations derived from the same relative root work, and neither the root builder nor its documentation requires an absolute override.

**Evidence:** `join(pluginRoot(), 'package.json')` remains `.dreamux/plugins/package.json`, while `createRequire` requires an absolute filename or file URL. A plain Node probe produced `ERR_INVALID_ARG_VALUE ... Received '.dreamux/plugins/package.json'`. The focused tests always use an absolute `mkdtemp` root.

### 8. Should-fix — a `bin` path can escape the package directory

**Location:** `packages/dreamux/src/plugin/run.ts:24-28,62-68`.

**Concrete input:** An unscoped installed package declares:

```json
{ "name": "acme-cli", "bin": "../../../outside.js" }
```

**Wrong outcome:** `plugin run acme-cli` normalizes the path outside `<plugin root>/node_modules/acme-cli` and executes that outside file with Node. The command is specified as running the installed package's own command line, not an arbitrary path selected outside that package. This is reachable for packages placed by a copy or symbolic link as well as for a malformed manifest.

**Evidence:** `commandLine` accepts every string without checking that it is a nonempty package-relative path, and `join(dir, script)` normalizes `..` components without enforcing containment. A path-normalization probe confirmed that `../../../outside.js` escapes an unscoped package directory. No subsequent check compares the resulting path with `dir`.

### 9. Should-fix — an installed package with a missing entry file is misreported as absent

**Location:** `packages/dreamux/src/plugin/resolve.ts:43-47`.

**Concrete input:** The plugin directory contains `node_modules/acme-cli/package.json` with `"main": "dist/index.js"`, but `dist/index.js` does not exist.

**Wrong outcome:** Resolution throws `NpmPackageMissingError`, saying the package "is not in the Dreamux plugin directory" and directing the operator to `plugin add`. The package is present; its declared entry is broken. This misdiagnosis can send the operator through an unnecessary reinstall instead of identifying the actual defect.

**Evidence:** Node's `require.resolve` uses `MODULE_NOT_FOUND` both for an unresolvable package and for a present package whose `main` target is missing. A plain Node probe of the manifest above returned `MODULE_NOT_FOUND: Cannot find module '.../node_modules/acme-cli/dist/index.js'. Please verify that the package.json has a valid "main" entry`. The catch at lines 45-46 rewrites both cases to the same missing-package message.

### 10. Nit — `dreamux plugin run --help` is treated as a package name

**Location:** `packages/dreamux/src/cli/dreamux.ts:22-27` and `packages/dreamux/src/cli/commands/plugin.ts:42-49`.

**Concrete invocation:** `dreamux plugin run --help`.

**Wrong outcome:** The command exits 1 with `expected an npm package name ... got "--help"` rather than showing the forwarder's usage. There is no package here to receive the option, so this is a reasonable help invocation for the pre-parser branch to recognize.

**Evidence:** The two-word match forwards every token after `run`; `forwardPluginRun` treats the first token as `name` unconditionally. The built CLI produced the error above.

### 11. Nit — the bootstrap fake in `plugin-loader.test.ts` is not installed

**Location:** `packages/dreamux/tests/plugin-loader.test.ts:126-143`.

**Concrete test path:** A test passes `@excitedjs/dreamux-plugin-bootstrap` with a custom default factory to `installModules`, as the load-order and config round-trip tests do.

**Wrong outcome:** The supplied fake is put into `fakeNpmModules`, but `builtin:bootstrap` continues through the real built-in dynamic import. Assertions can therefore pass without exercising the supplied module, and the suite depends on the real workspace bootstrap package being built and resolvable despite its header saying no real plugin package is imported.

**Evidence:** `BUILTIN_PACKAGE_NAMES` contains Codex, Claude Code, and Feishu only. The loader selects `BUILTIN_PLUGIN_PACKAGES[ref.id]` and calls `defaultImportModule` for a builtin (`plugin/loader.ts:233-248`), so the npm-fake map is never consulted for bootstrap. Adding bootstrap to the builtin set would restore the previous mocking behavior.

## Verified correct

- **`plugin add` ordering and ordinary writes:** It validates the package name and raw `plugins[]`, skips npm when the package is already resolvable, proves the plugin before writing, and leaves config unchanged when npm or the proof fails. A repair of an already registered missing package does not rewrite the entry.
- **`plugins[]` rewrite preservation:** For the exact default refs the commands recognize, `pluginItems` retains the original string/object items and their order. Object-entry `config` and unrecognized keys survive because the original parsed items are reused; unrelated top-level keys and key order survive `plugin add` and successful `plugin remove`. Removal filters matching entries without reordering the rest. The defect is named-export identity matching, not serialization of accepted items.
- **Ordinary `remove` use checks:** In a valid raw config, contributed agent runtimes are matched against `agents[].provider`, and contributed channels against `dispatchers[].channels[].provider`. A configured use refuses before either write or npm. Import, factory, and contribute failures are caught as `PluginLoadError` and follow the approved remove-broken-plugin path.
- **`plugin run` ordinary behavior:** String and single-entry object `bin` forms run with inherited terminal, cwd, and environment; no/multiple bins are refused; arguments after the package name arrive unchanged. Numeric exit codes are returned, and signal termination uses the conventional `128 + signal number` mapping. Running non-JavaScript executables would not work, but Section 12 explicitly approves `process.execPath`, no shebang, and no shell, so I did not count that approved restriction as a defect.
- **Other pre-parser paths:** `dreamux plugin --help` reaches yargs and names `plugin run` in the group description; `dreamux plugin run` with no package prints the explicit usage line; options following a real package name are forwarded rather than consumed by yargs.
- **`channel add` interaction boundaries:** An existing Dispatcher id is refused before `runOnboard` writes anything. Multiple contributed channels produce a validated selection prompt; one is selected automatically; none is refused. An unknown agent runtime fails provider resolution before the config write. Cancelling any of the reused prompts throws before `runOnboard`, so cancellation does not write config or create onboarding directories. Service registration and start are disabled.
- **Existing Dispatcher values:** Apart from finding 1's unknown-key loss, existing Dispatchers remain in order and retain their resolved values; the newly approved `enabled` and `workspace` fields are stated explicitly. The new Dispatcher is appended with the selected `builtin:<channel>` provider and collected provider config.
- **`readConfigFile` extraction:** The move into `config/raw-file.ts` preserves the existence check, mode check, JSON parse, and both error messages verbatim. The remaining load order is unchanged.
- **Records and safety:** The lost-entry window, daemon-restart routing, plugin-directory layout, command routing in `SKILL.md`, and package-layout rows agree with the implementation except where findings 1, 3, 4, and 6 note overclaims or incomplete recovery guidance. The change file uses `minor` as required on the 0.x line, and its `BREAKING:` classification is justified. I found no real service identifiers, credentials, private registry URLs, or internal hostnames in the reviewed slice.
- **Focused regression suites:** All 79 tests passed; the findings above are paths those suites do not assert, not failures of the existing tests.

## Coverage limits

- I did not run the full Rush build, lint, complete test, or `typecheck:tests` gates; this review ran only the four authorized focused suites.
- I did not perform a real registry install, start or restart a daemon, run the operator's live Weixin flow, or execute native Windows process/signal behavior.
- Plugin `server` and api-publication phases are not run by `loadAlone`. Section 12 defines the add proof as factory plus `contribute`, so I did not infer an additional requirement for these commands to start plugin servers; the config-phase omission is separately reported because it is part of `readConfigFile` and contradicts rule 4.
- I treated the approved require-condition choice for dual-format packages, concurrent-command non-serialization, the accepted daemon lost-entry window, and Node-only plugin command lines as approved limitations rather than reopening them as findings.
- I did not test every possible malformed package manifest or every npm/platform-specific error. The reported resolution and `bin` cases were checked with plain Node probes; broader registry behavior remains unverified.
