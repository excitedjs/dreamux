# Technical Design Draft — `dreamux plugin add`, `dreamux plugin setup`, and Slice 1 Login Revision

> Status: Architect draft (not yet reviewed or approved).
> Task record: [../README.md](../README.md)
> Baseline requirement & approved Slice 1/2 design: [../requirement.md](../requirement.md), [final.md](final.md), [draft-architect.md](draft-architect.md).
> Scope: Slice 3 (`dreamux plugin add <name>` and `dreamux plugin setup -p <name>`) and the resulting revision to Slice 1 (removing runtime QR login from `WeixinChannelSession`). Core learns zero Weixin concepts.

---

## 0. Summary of Recommended Design

1. **Isolated Dreamux-owned plugin install root (`~/.dreamux/plugins/`):** `dreamux plugin add <name>` installs the npm package into `~/.dreamux/plugins/` (relocatable via `DREAMUX_ROOT`, backed by a private `package.json` and `npm install --save --no-audit --no-fund`), validates the installed module as a `DreamuxPlugin`, and registers its `npm:<package>` ref in `config.json`'s `plugins[]` with the daemon stopped.
2. **Two-step external package resolution in `plugin/loader.ts` (and `registry/provider-loader.ts`):** For `npm:<package>` refs, Core resolves from `~/.dreamux/plugins/` first via `createRequire(join(pluginsDir(), 'package.json')).resolve(pkg)` + `import(pathToFileURL(resolved).href)`, then falls back to plain `import(packageName)` (preserving monorepo `devDependencies` and manual global installs). This works identically under `npm -g`, `pnpm -g`, `npx`, Homebrew, and source checkouts, and survives `dreamux` self-upgrades.
3. **Minimal `add` write scope:** `dreamux plugin add` writes **only** `plugins[]` in `config.json` (preserving untouched raw keys, `~` paths, and key order via raw-JSON splicing + atomic `0600` replace). It never mutates an existing Dispatcher and never guesses `dispatcher.id`/`cwd`/`agentRuntime`.
4. **Offline plugin setup capability (`DreamuxPlugin.setup`):** `DreamuxPlugin` gains one optional async method `setup?(context: PluginSetupContext): Promise<void>`. `dreamux plugin setup -p <name> [--dispatcher <id>]` enforces daemon-stopped via `admin.sock.lock`, loads config + plugins without running `server()` or constructing a `Server` or `Dispatcher`, optionally creates a dedicated Dispatcher interactively when a channel-contributing plugin has zero configured Dispatchers yet (Decision #2), and runs `plugin.setup(context)`.
5. **Slice 1 login revision:** `WeixinChannelSession` drops all runtime QR login machinery. Unauthenticated `start()` fails loud for that Dispatcher (other Dispatchers keep starting via `Dispatchers.start()`); `-14` clears `bot_token: null`, stops polling immediately, and logs an actionable error; `diagnostic` reports `ok: false` when not logged in; `reply` refusals and the Dispatcher prompt point at `dreamux plugin setup -p weixin` instead of a QR link in the channel log.

---

## 1. Verified Reference Evidence (DeepSeek Harness & Node/PM On-Disk Facts)

### 1.1 DeepSeek Harness (a local read-only checkout)

Key mechanisms extracted from source (and what we deliberately do **not** copy):

- **Home-owned install directory, decoupled from host install method:** `packages/boot/app-boot/src/profile.ts:5-20, 165-217` stores out-of-tree plugins inside `$DSH_HOME/profiles/<name>/` with its own private `package.json` and `node_modules/`. That decouples plugin installation from whether the host runs via `npm -g`, `pnpm -g`, `npx`, a packaged executable, or a source checkout.
- **Install vs. enable vs. user config separation:** `packages/boot/plugin-manager/README.md:40, 56, 126`, `packages/boot/plugin-manager/src/operations.ts:96-128`, and `packages/boot/app-boot/src/profile-plugins.ts:104-133` install the package, validate it declares a valid bundle, and register it in `dsh.profile.bundles` (the equivalent of Dreamux's `plugins[]`) **without** touching user-authored `cordis.patch.yml` overrides or running account authorization.
- **CLI inherits terminal & auth env:** `operations.ts:386-393` runs CLI package-manager commands with `stdio: 'inherit'` and inherited env so registry auth and live output work transparently.
- **Interactive auth flows stay separate from install and use a neutral interaction surface:** `packages/credentials/authorization/src/index.ts:87-143` separates credential acquisition from package install and hands each flow an `AbortSignal` plus surface-agnostic `notify`/`prompt` callbacks.
- **What we do NOT copy:** `dsh`'s Node internal ESM/CJS resolver interception (`packages/boot/app-boot/src/profile-resolution/resolver.ts`), Worker bootstrap, Cordis peer-sharing graph, HMR recomposition, `pnpm` hard requirement, `compatibility.json` exemptions, git/tarball install-spec probing (`install-spec.ts`), or multi-tab `AuthorizationService` registry. Dreamux plugins have no Cordis peer graph, no HMR, and no Web UI; a ~15-line standard resolver and a single optional `DreamuxPlugin.setup` method cover Dreamux's real requirements at a fraction of the entropy.

### 1.2 Verified On-Disk Package-Manager & Node 22.16 Facts

Verified directly on this machine (`node v22.16.0`, `npm 10.9.2`):

1. **Global `npm` leaves no lock/marker file beside packages:** Inspected the Node installation's global `lib/node_modules/` directory — it contains package directories (`@excitedjs/dreamux`, etc.) and **neither** `.package-lock.json` **nor** `.modules.yaml`.
2. **Global `pnpm` (v10/v11) isolates every global package into its own hashed directory:** Inspected pnpm v11's global directory (`pnpm/global/v11/`) — each global install lives under its own hashed subdirectory (`<hash>/node_modules/<pkg>`). Installing `@excitedjs/weixin-channel` via `pnpm add -g` puts it in a different hash directory that Node's ancestor walk from `@excitedjs/dreamux/dist/plugin/loader.js` can **never** reach. Even pnpm v9 global's non-hoisted `.pnpm/` symlink store hides sibling global packages from `@excitedjs/dreamux`.
3. **`npx @excitedjs/dreamux` runs from an ephemeral cache:** Unpacks into `~/.npm/_npx/<hash>/node_modules/@excitedjs/dreamux`; installing plugins next to it does not persist across cache refreshes or version changes.
4. **Dreamux self-upgrade (`packages/dreamux/skills/dispatcher/dreamux-maintenance/references/self-upgrade.md:18`):** Runs `npm install --global @excitedjs/dreamux@<version>`, which replaces `@excitedjs/dreamux/` cleanly and would wipe anything nested inside `@excitedjs/dreamux/node_modules/`.
5. **`import.meta.resolve(spec, parentURL)` in Node 22.16:** Verified empirically (`node --input-type=module -e ...`) that Node 22.16 **ignores the second `parentURL` argument** unless `--experimental-import-meta-resolve` is passed. It cannot resolve from an arbitrary directory without an experimental CLI flag.
6. **`createRequire(join(dir, 'package.json')).resolve(pkg)` in Node 22.16:** Verified empirically against `@excitedjs/feishu-channel` and `@excitedjs/dreamux-plugin-bootstrap` (`"type": "module"`, `"exports": { ".": { "types": ..., "import": ..., "default": ... } }`): returns the exact compiled `dist/index.js` path with zero flags, which `import(pathToFileURL(resolved).href)` then loads as native ESM on POSIX and Windows alike.
7. **Cross-copy `instanceof RuleViolation` hazard:** Verified at `packages/dreamux/src/command/errors.ts:101-104` and `packages/dreamux-utils/src/rule-violation.ts:27-32`: `throwCallerMistake` checks `error instanceof RuleViolation`. When an external plugin in `~/.dreamux/plugins/` installs its own copy of `@excitedjs/dreamux-utils` under `~/.dreamux/plugins/node_modules/`, `instanceof RuleViolation` would evaluate to `false` across module instances unless `RuleViolation` uses a `Symbol.for` brand with `static [Symbol.hasInstance]`. (`PublicInvokeFailure` has no such hazard because `settleJsonInvoke` runs inside the plugin's own copy, `packages/dreamux-utils/src/json-invoke.ts:45`.)
8. **Strict JSON config (`config.json` has no comment support):** Verified at `packages/dreamux/src/config/load.ts:69` and `packages/dreamux/src/config/config.ts:213` — Dreamux parses `config.json` with standard `JSON.parse`. Comments already fail `serve`, `doctor`, and `config show`.

---

## 2. `dreamux plugin add <name>`

### 2.1 Deriving the npm Package Name and `plugins[]` Ref

The operator's card answer invokes `dreamux plugin add weixin`, while the standing ruling fixes the package name as `@excitedjs/weixin-channel` (`ref: "npm:@excitedjs/weixin-channel"`) and forbids Core from learning any Weixin concept.

#### Candidate Comparison

| Candidate | Rule for `<input>` | Entropy & Boundary Verdict |
|---|---|---|
| **(N1, Recommended) Explicit npm spec + one deterministic short-name convention** | 1. Reject `builtin:*` loudly (built-ins ship with Dreamux, not npm).<br>2. Explicit `npm:<pkg>[@ver][#export]` or scoped `@scope/pkg[@ver][#export]` -> literal npm package name (`npm:<pkg>[#export]` written to `plugins[]`; `<pkg>[@ver]` passed to `npm install`).<br>3. Bare short name matching `BUILTIN_PROVIDER_ID_PATTERN` (`/^[a-z][a-z0-9-]*$/`, optional `@ver`) -> expands deterministically to `@excitedjs/<name>-channel` (`npm:@excitedjs/<name>-channel`). | **Lowest entropy, zero Weixin knowledge in Core, zero network probe.** 35-line pure parser; works offline in unit tests; supports pinned versions (`weixin@0.1.0`), scoped packages (`@excitedjs/weixin-channel`, `@acme/foo`), unscoped third-party packages (`npm:my-plugin`), and named exports (`npm:@acme/foo#create`). Trade-off: assumes bare short names map to `@excitedjs/<name>-channel` (so a future non-channel official plugin such as `@excitedjs/dreamux-plugin-foo` would either use its scoped name or adopt a unified convention — see Operator Decision #1). |
| **(N2) Multi-pattern registry probe (`@excitedjs/dreamux-plugin-<name>`, then `@excitedjs/<name>-channel`)** | Runs `npm view` probes against the registry to discover which naming convention exists. | **Worse.** Adds extra network round-trips, failure classification (`E404` vs offline vs private registry auth error), and ambiguity if two names exist. No second publishable short-name plugin exists today (`bootstrap` is `shouldPublish: false`, `rush.json:78-81`). |
| **(N3) Static Core shorthand table (`{ weixin: '@excitedjs/weixin-channel' }`)** | Hard-codes official short names in Core (like DeepSeek harness's `ON_DEMAND_BUNDLES`). | **Eliminated.** Violates the standing constraint that Core must learn no Weixin concept and couples every new official plugin to a Core release. |
| **(N4) Require full package name (`@excitedjs/weixin-channel`) only** | Rejects bare `weixin`. | **Eliminated.** Contradicts the operator's explicit card answer (`dreamux plugin add weixin`). |

**Exact grammar (`packages/dreamux/src/cli/plugin-spec.ts`):**
- Rejects empty input and `builtin:*` (error: `"built-in plugins are bundled with Dreamux and cannot be installed from npm"`).
- Strips optional leading `npm:` (recording `explicitNpm = true`).
- Splits optional `#<export>` suffix (validated against `PROVIDER_EXPORT_PATTERN`, `packages/dreamux/src/registry/provider-ref.ts:50`).
- Splits optional `@<version>` suffix (searching for `@` from index `1` so leading `@scope/` is preserved; rejects empty version after `@`).
- If `explicitNpm` or name starts with `@`: validate name against `NPM_PACKAGE_PATTERN` (`provider-ref.ts:42-44`) and use it verbatim.
- Else if name matches `BUILTIN_PROVIDER_ID_PATTERN` (`provider-ref.ts:31`): expand to `@excitedjs/${name}-channel`.
- Else: throw a clear usage error (`"expected a short name (e.g. 'weixin'), a scoped npm package (e.g. '@scope/pkg'), or 'npm:<pkg>[#export]'"`).
- Produces `{ packageName, installSpec, pluginRef }`:
  - `dreamux plugin add weixin` -> `{ packageName: '@excitedjs/weixin-channel', installSpec: '@excitedjs/weixin-channel', pluginRef: 'npm:@excitedjs/weixin-channel' }`
  - `dreamux plugin add weixin@0.1.0` -> `{ packageName: '@excitedjs/weixin-channel', installSpec: '@excitedjs/weixin-channel@0.1.0', pluginRef: 'npm:@excitedjs/weixin-channel' }`
  - `dreamux plugin add @excitedjs/weixin-channel` -> identical `pluginRef`.
  - `dreamux plugin add npm:custom-plugin#makePlugin` -> `{ packageName: 'custom-plugin', installSpec: 'custom-plugin', pluginRef: 'npm:custom-plugin#makePlugin' }`.

### 2.2 Installation Target and Module Resolution

#### Candidate Comparison

| Candidate | Install Mechanism & Resolver | Entropy & Portability Verdict |
|---|---|---|
| **(I2, Recommended) Dreamux-owned `~/.dreamux/plugins/` + two-step resolver** | `pluginsDir()` (`join(dreamuxRoot(), 'plugins')`) holds `{ "name": "dreamux-plugins", "private": true, "dependencies": {} }`. `dreamux plugin add` runs `npm install --save --no-audit --no-fund <installSpec>` with `cwd: pluginsDir()`. `importExternalPackage()` resolves via `createRequire(join(pluginsDir(), 'package.json')).resolve(pkg)` -> `import(pathToFileURL(resolved).href)`, falling back to plain `import(pkg)` when absent from `pluginsDir()`. | **Lowest entropy and universal portability.** Works identically across `npm -g`, `pnpm -g` (v9/v10/v11), `yarn global`, `npx`, Homebrew/Nix, Windows, and Rush monorepo dev checkouts. Survives `dreamux` self-upgrades (`npm i -g @excitedjs/dreamux@latest`). Respects `DREAMUX_ROOT` (trivial test isolation and clean `dreamux uninstall`). Zero Node internal APIs, ~15 lines of resolver code. |
| **(I1) Detect host's package manager & prefix, install next to `@excitedjs/dreamux`** | Inspect `PACKAGE_ROOT` (`platform/paths.ts:63`) to guess `npm -g --prefix ...` or `pnpm -g`, keeping `loader.ts:371` unchanged. | **Eliminated.** Proven broken on disk: npm global leaves no `.package-lock.json`/`.modules.yaml`; pnpm v10/11 isolates each global package in its own hashed dir so siblings are structurally unreachable; `npx` runs in an ephemeral `_npx` cache; system prefixes may be read-only; Rush source checkouts cannot be mutated with `npm install`. |
| **(I3) DeepSeek harness-style `installRuntimeInterception` + `pnpm` profile** | Intercept Node's internal ESM/CJS resolver and require `pnpm` on `PATH`. | **Eliminated.** Requires fragile Node internal APIs and forces operators to install `pnpm`; Dreamux plugins have no Cordis peer-sharing graph or HMR. |

#### Resolution Sub-Choice Inside (I2): `createRequire` vs. `.import.mjs` Bridge

- **R1 (Recommended): `createRequire(join(pluginsDir(), 'package.json')).resolve(packageName)` -> `import(pathToFileURL(resolved).href)`.**
  - Zero hidden executable files inside `~/.dreamux/plugins/` (only standard `package.json`, `package-lock.json`, `node_modules/`).
  - Read-only during `dreamux doctor` and `dreamux serve`, even if an operator ran `npm install` inside `~/.dreamux/plugins/` manually.
  - Verified on Node 22.16 for `@excitedjs/feishu-channel` and `@excitedjs/dreamux-plugin-bootstrap`, which both declare `exports["."]` with `import` and `default`.
  - **Known constraint:** A third-party ESM package whose `exports["."]` declares **only** `"import"` (omitting `"default"` and `"require"`) throws `ERR_PACKAGE_PATH_NOT_EXPORTED` from `createRequire.resolve`. Every Dreamux package exports `"default"` alongside `"import"`, and no `"import"`-only plugin exists today (Whitepaper §1: do not add an `.import.mjs` shim until that scenario exists).
- **Fallback behavior:** Only when `createRequire.resolve` throws `MODULE_NOT_FOUND` (or `pluginsDir()/package.json` does not exist) does `importExternalPackage` fall back to `await import(packageName)`. Any syntax error or load error inside a found package surfaces directly instead of being masked by the fallback.
- **Cross-copy `RuleViolation` fix (`packages/dreamux-utils/src/rule-violation.ts`):** Because a plugin installed in `~/.dreamux/plugins/node_modules/` resolves its own copy of `@excitedjs/dreamux-utils`, add a process-shared brand `const RULE_VIOLATION_BRAND = Symbol.for('@excitedjs/dreamux-utils/RuleViolation')` on `RuleViolation` instances plus a custom `Symbol.hasInstance` static method so `throwCallerMistake` (`packages/dreamux/src/command/errors.ts:102`) recognizes `RuleViolation` thrown across install roots.

### 2.3 Write Scope into `config.json` and How It Writes

#### Candidate Comparison for Write Scope

| Candidate | What `plugin add` writes to `config.json` | Entropy & Product Verdict |
|---|---|---|
| **(W-Add-Only, Recommended)** | **Only** adds `pluginRef` (`"npm:@excitedjs/weixin-channel"`) to top-level `plugins[]` (deduplicated by canonical `parseProviderRef(entry.ref).raw` so re-running is idempotent). Never touches `dispatchers[]` or `agents[]`. | **Lowest entropy, matches DeepSeek harness (`dsh plugin add` updates only `dsh.profile.bundles`, never `cordis.patch.yml`).** 100% plugin-agnostic (works identically for channel plugins, runtime plugins, and hook-only plugins). Never violates the standing ruling against putting Feishu and Weixin on the same Dispatcher. Never guesses `dispatcher.id`, `cwd`, or `agentRuntime`. |
| **(W-Add-Dispatcher)** | Also creates or mutates a `dispatchers[]` entry during `plugin add`. | **Eliminated for `plugin add`.** Conflates package installation with interactive Dispatcher provisioning; breaks non-channel plugins; cannot append to an existing Feishu Dispatcher (ruled out of scope) and cannot safely guess `cwd`/`agentRuntime` for a new Dispatcher. |

Where the new Weixin Dispatcher entry in `dispatchers[]` gets created (between `plugin add` and `plugin setup`) is settled cleanly in Section 3.3 (**W2 vs. W1** — also surfaced as Operator Decision #2).

#### How `config.json` Is Written (Preserving Hand-Shaped Files)

- Verified: `config.json` is strict JSON (`packages/dreamux/src/config/load.ts:69`), so comments are already rejected by `serve` and `doctor` (no JSONC parser is introduced).
- **Do NOT use `stringifyConfig(loaded.config)`** (`packages/dreamux/src/config/config.ts:179-208`), because `stringifyConfig` reconstructs only known wrapper fields, expands `~` paths in `cwd`, and drops unknown keys (`config-envelope.md:107-110`).
- **Use raw-JSON splicing + atomic replace**, matching `ConfigService.replaceAgents` (`packages/dreamux/src/config/service.ts:14-23, 86, 161`):
  1. Verify `config.json` exists and satisfies `assertConfigFileMode(file)` (`0600` on POSIX, `config/config.ts:225-232`).
  2. `raw = JSON.parse(await readFile(file, 'utf8'))` and assert `isPlainObject(raw)`.
  3. Build `candidateRaw = { ...raw, plugins: nextRawPlugins }`, appending `pluginRef` only if no existing entry in `raw.plugins` parses to the same canonical `ref.raw` (preserving existing `{ ref, config }` objects verbatim!).
  4. Validate `candidateRaw` through the real loader (`loadPlugins` + `resolveConfig` + `readPluginConfigs` on a fresh `ProviderRegistry`) **before** touching disk.
  5. Write `${JSON.stringify(candidateRaw, null, 2)}\n` via `writeFileAtomic(file, ..., { mode: 0o600 })` (`packages/dreamux-utils/src/fs.ts:87-105`, which handles POSIX `0600` and Windows current-user DACL atomically).
- Result: all untouched `agents[]`, `dispatchers[]`, unknown envelope keys, `~` paths, and key order survive verbatim; indentation normalizes to 2 spaces with a trailing newline (identical to `ConfigService.replaceAgents`).

### 2.4 Daemon-Stopped Requirement and Detection

- **Why the daemon must be stopped:** While `dreamux serve` runs, `ConfigService` holds `config.json` in memory on a `TransactionalStore` (`packages/dreamux/src/config/service.ts:11-23`; `.agents/product/README.md:794-802`). An out-of-band edit to `config.json` while `dreamux serve` is alive is neither read by the running server nor protected against a subsequent `config.agents.replace` overwriting it with the old in-memory copy.
- **How the command knows (single authoritative check):** Check the server's single-instance pidfile `adminSocketLockPath(adminSocketPath())` (`~/.dreamux/run/admin.sock.lock`, owned by `packages/dreamux/src/admin/socket.ts:88, 117` and `packages/dreamux/src/platform/instance-lock.ts:79-101`):
  - Read `pid = await readPidFile(lockPath)`.
  - If `pid !== null && isAlive(pid)` (`defaultIsPidAlive`, `process.kill(pid, 0)` with `EPERM` treated as alive): fail loud immediately **before** invoking `npm` or writing any file:
    `dreamux serve is running (pid <pid>). Stop it first ('dreamux daemon stop' or stop the foreground server) before running 'dreamux plugin add'.`
  - Why `admin.sock.lock` beats `getServiceStatus()` and `admin.sock` probing: it catches **both** managed service daemons (`systemd`/`launchd`/Windows Scheduled Task) and foreground `dreamux serve`, is a real filesystem pidfile on Windows too (`state-config-and-files.md:571-572`), ignores stale lockfiles from crashed processes, respects `DREAMUX_ROOT`, and spawns zero subprocesses.

### 2.5 Execution Order and Failure Semantics

Following Whitepaper §2 (*"Durable facts and recovery"* — no compensating rollback that invents a second failure path; retry converges):

1. **Pre-flight (zero side effects):** Parse `<name>`, check daemon stopped, verify `config.json` exists, is `0600`, and parses as a JSON object. **Crucially, pre-flight does NOT run `loadConfig()`** so a previously registered but uninstalled plugin can be repaired by running `dreamux plugin add <name>`.
2. **Install:** Ensure `pluginsDir()` and `pluginsDir()/package.json` exist (`publishFileExclusive` if absent), then run `npm install --save --no-audit --no-fund <installSpec>` in `pluginsDir()` via `CommandRunner`.
   - *Failure here:* `config.json` was never modified; Dreamux remains bootable. Retry after fixing the package name, auth, or network.
3. **Validate installed plugin:** Build `candidateRaw` with `pluginRef` (deduplicated) and run `loadPlugins` + `resolveConfig` + `readPluginConfigs` on a fresh `ProviderRegistry`.
   - *Failure here (e.g. package has no plugin factory export, throws in factory, bad `plugin.name`, duplicate plugin name or provider collision):* Fail loud and leave `config.json` untouched. Do **not** run a compensating `npm uninstall` (an unregistered package in `~/.dreamux/plugins/node_modules/` is inert because Dreamux only loads refs listed in `config.json` `plugins[]`).
4. **Commit registration:** Atomically write `candidateRaw` to `config.json` (`writeFileAtomic`, mode `0600`) only when `plugins[]` actually changed.
   - *Failure here (disk full / permission error):* Package is installed in `~/.dreamux/plugins/`; `config.json` is untouched and valid. Re-running `dreamux plugin add <name>` converges cleanly.
5. **Reverse state (registered in `config.json`, missing from `~/.dreamux/plugins/`):**
   - `dreamux serve` and `dreamux doctor` fail loud at plugin phase `import` naming the missing package (`packages/dreamux/src/plugin/loader.ts:244-249`).
   - Running `dreamux plugin add <name>` installs the package, validates `candidateRaw`, sees `pluginRef` is already present in `plugins[]`, and succeeds idempotently.

**CLI output on success:** Prints the installed package, `plugins[]` status (`added` or `already registered`), contributed providers (e.g. `channel:weixin`), and — if `loaded.plugin.setup !== undefined` — the exact next command: `Run 'dreamux plugin setup -p <loaded.name>' to configure this plugin.`

---

## 3. `dreamux plugin setup -p <name>`

### 3.1 Contract Placement (`DreamuxPlugin.setup`)

#### Candidate Comparison

| Candidate | Contract Home | Entropy & Boundary Verdict |
|---|---|---|
| **(S-A, Recommended) Optional `setup?(context: PluginSetupContext): Promise<void>` on `DreamuxPlugin` (`packages/dreamux-types/src/plugin.ts`)** | One optional async method beside `contribute?` and `server?`. | **Lowest entropy & exact semantic match.** The CLI addresses a plugin by `DreamuxPlugin.name` (`-p <name>`). Works uniformly for channel plugins (Weixin), future runtime plugins, and hooks-only plugins without touching `ChannelProvider`, `AgentRuntimeProvider`, or `onboard`. Zero registry or `server()` execution needed. |
| **(S-B) `ChannelProvider.setup`** (`packages/dreamux-types/src/channel.ts`) | Put `setup` on `ChannelProvider<TConfig>` and reverse-lookup from plugin name to contributed channel providers. | **Worse.** Adds indirection from plugin -> provider -> setup, cannot serve non-channel plugins without duplicating `setup` onto two other interfaces, and blurs `ChannelProvider.onboard`. |
| **(S-C) Reuse `ChannelProvider.onboard.collect`** | Have `onboard.collect` run QR login and write state files. | **Eliminated.** `onboard.collect` (`dreamux-types/src/provider.ts:146-151`) returns a raw config object for `config.json`, supports `--dry-run`, and receives no `state_root` or channel id. |
| **(S-D) Register setup flows inside `server(host)`** | Mirror DeepSeek harness's `AuthorizationService`. | **Eliminated.** `server()` is synchronous and runs under `dreamux serve`/`doctor`; offline CLI setup has no server, no Web UI, and no multi-client concurrency. |

#### Exact Contract Shapes (`packages/dreamux-types/src/plugin.ts`)

Every field passes Whitepaper §3's four-question test (named producer, named consumer, lost capability if deleted, not derivable without violating boundaries):

```ts
export interface PluginSetupChannel {
  readonly channel_id: string;
  readonly provider: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface PluginSetupDispatcher {
  readonly id: string;
  readonly cwd: string;
  readonly enabled: boolean;
  /** Per-dispatcher durable state root (same path ChannelSession receives). */
  readonly state_root: string;
  /** Per-dispatcher rebuildable cache root (same path ChannelSession receives). */
  readonly cache_root: string;
  readonly channels: readonly PluginSetupChannel[];
}

export interface PluginSetupSelectOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface PluginSetupSelectPrompt {
  readonly message: string;
  readonly options: readonly PluginSetupSelectOption[];
}

/**
 * Neutral terminal UI handed to `DreamuxPlugin.setup`. Extends
 * `ProviderOnboardPromptHost` so plugins never import `@clack/prompts`.
 */
export interface PluginSetupUi extends ProviderOnboardPromptHost {
  readonly interactive: boolean;
  info(message: string): void;
  warn(message: string): void;
  select(input: PluginSetupSelectPrompt): Promise<string>;
}

export interface PluginSetupContext {
  /** Validated `plugins[].config` from `config.read`, or `undefined`. */
  readonly config: unknown;
  /** This plugin's own durable state dir (`state/plugins/<name>/`). */
  readonly stateDir: string;
  /** Configured Dispatchers (narrowed to `--dispatcher` when passed). */
  readonly dispatchers: readonly PluginSetupDispatcher[];
  /** Neutral interactive terminal UI. */
  readonly ui: PluginSetupUi;
  /** Aborted on SIGINT / SIGTERM so long polls stop cleanly. */
  readonly signal: AbortSignal;
  /** Plugin-bound logger. */
  readonly logger: DreamuxLogger;
}
```

And on `DreamuxPlugin`:
```ts
/**
 * Optional offline interactive setup flow run by `dreamux plugin setup -p <name>`
 * with the daemon stopped. Unlike `contribute` and `server`, `setup` is async
 * and may perform network I/O and write plugin-owned or channel-owned state
 * under `context.stateDir` or a matching Dispatcher's `state_root`.
 */
setup?(context: PluginSetupContext): Promise<void>;
```

**Ownership & write boundaries for `setup()`:**
- **May write:** Plugin-owned files under `context.stateDir`, and Channel-owned files under a matching Dispatcher's `dispatcher.state_root` / `dispatcher.cache_root` (e.g., `weixin-state.<slug>.<digest>.json` at mode `0600`).
- **Must not write:** `config.json` (Core does not even pass `configFile` to `setup()`), Core-owned state (`identity.json`, `record.json`, `cron-jobs.json`, `workflow/`).
- **Must not start:** Any `ChannelSession`, `DispatcherService`, or `Server`.

### 3.2 How Core Runs `dreamux plugin setup -p <name>` (No Daemon, No Dispatcher)

`packages/dreamux/src/cli/commands/plugin.ts` registers:
- `dreamux plugin add <name>`
- `dreamux plugin setup -p <name> [--dispatcher <id>]` (`-p` / `--plugin`, required string).

Execution sequence in `packages/dreamux/src/cli/plugin-setup.ts`:

1. **Enforce daemon stopped:** Call `assertNoLiveInstance(adminSocketLockPath(adminSocketPath()))`.
   - *Why required:* While `dreamux serve` runs, a live Channel session (including `WeixinChannelSession`) holds its `TransactionalStore` in memory (`state-config-and-files.md:362-372`). Writing a new `bot_token` on disk while the daemon runs would neither be read by the running session nor be safe from overwrite, and any Dispatcher creation in `config.json` (W2 below) also requires `ConfigService` to be offline.
2. **Load config and plugins only:** Call `loadConfig()` (`packages/dreamux/src/config/load.ts:33-41`). This runs `loadPlugins` (`constructPlugin` + `contribute`), `resolveConfig`, and `readPluginConfigs`. Core does **not** call `startPlugins()` (`server()`), does **not** construct `Server` or `DispatcherService`, and does **not** build any `ChannelSession`.
3. **Resolve target plugin:** Match `-p <name>` against `loaded.plugins` ignoring ASCII case (`loaded.name.toLowerCase() === name.toLowerCase()`), matching `plugin/loader.ts:168`'s uniqueness rule.
   - Missing plugin -> fail loud listing loaded plugins and hinting `dreamux plugin add <name>`.
   - `loaded.plugin.setup === undefined` -> fail loud: `plugin "<loaded.name>" does not declare a setup flow.`
4. **Resolve `--dispatcher <id>` (if passed):** Validate `id` exists in `config.dispatchers` (fail loud naming configured Dispatcher ids if absent) and narrow `dispatchers` to `[matched]`.
5. **Provision a dedicated Dispatcher if none uses this plugin's contributed channel yet (W2 vs. W1 — see Section 3.3).**
6. **Build `PluginSetupContext` and invoke `loaded.plugin.setup(context)`:**
   - Map each `DispatcherConfig` to `PluginSetupDispatcher` with `state_root: dispatcherDir(d.id)` and `cache_root: dispatcherCacheDir(d.id)` (same path builders `ChannelService.build` and `provider-diagnostics.ts` already call).
   - Wire `SIGINT` and `SIGTERM` listeners to an `AbortController` (`signal`) and remove them in `finally`.
   - Build `PluginSetupUi` over `@clack/prompts` (`note`/`log.info`, `log.warn`, `text`, `password`, `confirm`, `select`, `isCancel`) when `process.stdin.isTTY === true`, or a non-interactive stub that prints `info`/`warn` and throws on interactive prompts.
   - `await loaded.plugin.setup(context)`.
   - On completion, print one line reminding the operator to run `dreamux doctor` and start/restart Dreamux (`dreamux daemon start` or `dreamux serve`).

### 3.3 Creating the Weixin Dispatcher Entry: W2 vs. W1

Because `dreamux plugin add weixin` writes only `plugins[]` (Section 2.3), a fresh operator who runs `dreamux plugin add weixin` followed by `dreamux plugin setup -p weixin` has zero Dispatchers referencing `builtin:weixin` yet. Compare the two options:

| Option | Behavior when 0 Dispatchers reference a channel provider contributed by the plugin | Entropy & UX Verdict |
|---|---|---|
| **(W2, Recommended) Core interactively offers to create one dedicated Dispatcher inside `plugin setup` before calling `plugin.setup(context)`** | When `loaded.providers` has a `channel` provider, `--dispatcher` was not passed, and 0 configured Dispatchers reference any of its `builtin:<id>` providers: in interactive TTY, Core asks (1) confirm creating a new Dispatcher, (2) `dispatcher id` (default: provider id, e.g. `weixin`, validated unique via `validateDispatcherId`), (3) `cwd` (default: `process.cwd()`), (4) `agentRuntime` (selected from existing `agents[]` — refuses if `agents[]` is empty, pointing to `dreamux onboard`). Splices the new Dispatcher (`channels: [{ id: providerId, provider: 'builtin:' + providerId, config: {} }]`) into raw `config.json`, re-validates via `resolveConfig`, writes atomically at `0600`, then runs `plugin.setup(context)`. **Never modifies any existing Dispatcher** (so Feishu+Weixin on one Dispatcher can never happen). On subsequent runs (e.g. `-14` re-login), a Dispatcher already exists, so step 5 is skipped completely and setup jumps straight to QR scan. | **Best user story, still 100% Weixin-agnostic.** Zero manual JSON editing (`plugin add weixin` -> `plugin setup -p weixin` -> `daemon start`), ~45 lines in `cli/plugin-setup.ts`, reuses `@clack/prompts` and raw-JSON atomic config update from `plugin-add.ts`. |
| **(W1, Alternative) `plugin setup` never edits `config.json`** | `plugin.setup(context)` finds 0 matching Dispatchers and fails loud printing the exact `dispatchers[]` JSON snippet the operator must add to `config.json` by hand before re-running `plugin setup`. | **Slightly smaller Core (~45 lines less), worse UX.** Forces hand-editing `~/.dreamux/config.json` between `plugin add` and `plugin setup`. |

Surfaced as **Operator Decision #2** (recommended: W2).

### 3.4 Weixin Setup Flow (`packages/channel/weixin-channel/src/setup.ts`)

1. **Target channel & state-file resolution:**
   - Collect all `{ dispatcher, channel }` pairs across `context.dispatchers` where `channel.provider === 'builtin:weixin'`.
   - `0` matches -> throw an Error instructing the operator to add a Dispatcher with `provider: "builtin:weixin"` (or pass a matching `--dispatcher <id>`).
   - `1` match -> select automatically.
   - `>1` matches -> if `!context.ui.interactive`, fail loud asking for `--dispatcher <id>`; otherwise call `context.ui.select(...)` listing each `<dispatcher.id> (channel <channel.channel_id>)`.
   - Derive the exact state-file path using the single shared builder `weixinStatePath(dispatcher.state_root, channel.channel_id)` (`<state_root>/weixin-state.<channel-slug>.<digest>.json` — identical to `WeixinChannelSession` and `diagnostic`).
   - Open `TransactionalStore` on that path (`await store.load()`):
     - Malformed file -> fail loud naming path, defect, and recovery (move/remove file and re-run `dreamux plugin setup -p weixin`).
     - Already authenticated (`bot_token !== null`) -> show current `bot_id`/`user_id` via `context.ui.info` and ask `context.ui.confirm({ message: 'Re-authenticate with a new QR scan?', initialValue: true })`; if `false`, return cleanly with zero network calls.
2. **Interactive QR scan loop (reusing `src/protocol.ts`):**
   - Calls `fetchQrCode(DEFAULT_BASE_URL, DEFAULT_BOT_TYPE, context.signal)`.
   - Renders the QR code in the terminal **and** prints the raw `qrcode_img_content` URL beneath it via `context.ui.info(...)`:
     - **Terminal QR rendering (Operator Decision #3):** Recommend one tiny, pure-JS, zero-dependency MIT QR encoder (such as `uqr` — ESM-native, zero transitive deps, renders compact UTF-8 half-block `▀▄█ ` matrices at half terminal height — or `qrcode-terminal`, which `@tencent-weixin/openclaw-weixin` itself uses) **plus** always printing the raw URL line beneath it so narrow terminals, non-Unicode fonts, and automated tests always have the verbatim link. Note: this is a knowing change to `final.md:117` (*"no third-party runtime package"*), justified by the new interactive terminal QR requirement. (Alternative: print only the URL for zero dependencies, at the cost of forcing the operator to open the URL in a browser to get a scannable QR.)
   - Polls `pollQrStatus(pollBaseUrl, qr.qrcode, context.signal)` until `context.signal.aborted`:
     - Client-side 35 s timeout -> treat as `'wait'`, continue polling.
     - `'wait'` -> continue polling.
     - `'scaned'` -> print once (`'QR code scanned; confirm login in WeChat...'`), continue polling.
     - `'scaned_but_redirect'` -> switch `pollBaseUrl = 'https://' + redirect_host`, continue polling.
     - `'expired'` -> print `context.ui.warn('QR code expired; fetching a new QR code...')`, break inner loop and fetch a fresh QR code + re-render it.
     - `'confirmed'` -> verify non-empty `bot_token` and `ilink_user_id`, commit via `store.update(...)`:
       - Write `bot_token`, `bot_id: resp.ilink_bot_id ?? null`, `user_id: resp.ilink_user_id`, `base_url: resp.baseurl?.trim() || DEFAULT_BASE_URL`.
       - Same-account preservation rule (unchanged from `final.md:335-336`): if `bot_id` or `user_id` changed from the previous state, reset `get_updates_buf: ''` and `context_token: null`; if the same account re-authenticated (e.g. after `-14`), preserve `get_updates_buf` and `context_token`.
       - `await store.drain()`.
       - Print confirmation (`'WeChat login confirmed (user: <user_id>, bot: <bot_id>). Credentials saved to <statePath>.'`) and return.
     - `'need_verifycode'` / `'verify_code_blocked'` / `'binded_redirect'` -> print `context.ui.warn(...)` naming the status and throw an Error (failing the interactive setup cleanly rather than looping blindly). Note: the wire endpoint to submit a verification code was not verified in `@tencent-weixin/openclaw-weixin` source; if live runs trigger `need_verifycode`, it can be wired to `context.ui.text(...)` in a follow-up without changing the `PluginSetupContext` contract.
     - Network or HTTP error -> throw immediately so the operator sees the exact error in the terminal instead of hanging in an infinite retry loop.
   - On `context.signal.aborted` (Ctrl-C): abort in-flight `fetch`, write nothing, print `'WeChat setup cancelled.'`, and exit cleanly.

---

## 4. Slice 1 Revision — Weixin Session with No Runtime QR Login

Supersedes the runtime-QR sections of `requirement.md:119-125, 299-303`, `final.md:323-342, 387-397, 423-424`, and `draft-architect.md:525-564, 603-611, 664-668` per the operator's 2026-11-25 ruling (*"只在 setup 里扫码"*).

### 4.1 `WeixinChannelSession.start()` with No Stored Credential

#### Candidate Comparison

| Candidate | Behavior when `store.current.bot_token === null` at `start()` | Entropy & Honesty Verdict |
|---|---|---|
| **(L2, Recommended) Fail loud in `start()`** | `start()` throws an Error: `Weixin channel "<channel_id>" on dispatcher "<dispatcher_id>" is not logged in. Stop Dreamux, run 'dreamux plugin setup -p weixin' to scan the WeChat QR code, and start again.` | **Honest and safe.** Verified at `packages/dreamux/src/service/dispatchers/index.ts:165-188`: `Dispatchers.start()` catches per-Dispatcher start failures, logs `'dispatcher failed to start'`, and **continues starting all other enabled Dispatchers** (so a Feishu Dispatcher is unaffected). `DispatcherLifecycle.doStart()` (`lifecycle.ts:175-185`) tears down that Dispatcher cleanly before `scheduler.start()` runs, so `ChannelService.list()` never falsely claims `live: true` and cron jobs never burn turns against a dead channel. |
| **(L1) Log a warning and stay idle (`start()` returns cleanly with no poll loop)** | Marks `entry.live = true` (`channel-service/index.ts:229`) and logs `'dispatcher ready'` even though the channel can neither receive nor send. | **Loses on honesty.** Causes misleading `live: true` / ready status and allows cron jobs to fire into a dead channel. (Multi-channel Feishu+Weixin on one Dispatcher is explicitly out of scope.) |

`initialize(port)` stays strictly about state loading and validation: a missing state file loads the default unauthenticated document (`bot_token: null`) without throwing, while a malformed/wrong-version/wrong-`channel_id` state file still fails loud in `initialize()`.

### 4.2 Handling `-14` (Stale Token) at Runtime

When either `getupdates` or `sendmessage` returns `errcode === -14` or `ret === -14`:

1. `handleStaleToken()` updates `TransactionalStore` to set `bot_token: null` (keeping `bot_id`, `user_id`, `base_url`, `get_updates_buf`, and `context_token` intact so a subsequent same-account `dreamux plugin setup -p weixin` resumes without replaying old messages or losing the reply context).
2. Logs at `error` to the per-dispatcher channel log (`~/.dreamux/logs/channel/<dispatcher-id>.log`):
   `log.error({ dispatcher_id, channel_id }, 'weixin session expired (-14); polling stopped. Stop Dreamux, run "dreamux plugin setup -p weixin" to scan a new QR code, and restart.')`
3. Aborts the poll loop's `pollAbortController` (separate from session `closing`) so any in-flight `getupdates` ends immediately and `runLoop()` exits (`while (!signal.aborted && this.store.current.bot_token !== null)`).
4. **Zero** `get_bot_qrcode`, `get_qrcode_status`, `getupdates`, or `sendmessage` HTTP calls are issued afterward.
5. On the next `dreamux serve` restart (if the operator has not yet run `dreamux plugin setup -p weixin`), `start()` sees `bot_token: null` on disk and fails loud per Section 4.1.

**What disappears from `session.ts`:** The entire `runQrLoginStep()`, QR polling loop, QR status branching, `qr_url` logging, and unauthenticated retry loop are deleted from `session.ts` (moved to `src/setup.ts`). `session.ts` now owns only the authenticated `getupdates` loop, detached inbound delivery, `sendReply`, and `close()`.

### 4.3 `diagnostic` Report (`src/provider.ts`)

`diagnostic.runDiagnostic(context)` remains read-only against `weixinStatePath(context.state_root, context.channel_id)` (safe while a daemon is live):

| State file on disk | `ok` | `detail` | `errors` |
|---|---|---|---|
| Valid, `bot_token !== null` and `user_id !== null` | `true` | `'authenticated'` | `[]` |
| Missing file, OR valid with `bot_token === null` | **`false`** | `'not logged in'` | `['Weixin is not authenticated. Stop Dreamux and run \`dreamux plugin setup -p weixin\` to scan the WeChat QR code.']` |
| Malformed JSON, wrong `version`, wrong `channel_id`, wrong field type, or unreadable | `false` | `'invalid state file'` | `['<path>: <defect>. Move or remove the file and run \`dreamux plugin setup -p weixin\` to re-authenticate.']` |

Because `dreamux serve` can no longer authenticate at runtime, an unauthenticated state file is now a real readiness failure (`ok: false`), aligning `dreamux doctor` with `start()`.

### 4.4 Updated `reply` Refusal Messages, State-Error Recovery, and Dispatcher Prompt

1. **`reply(text)` refusals (`src/session.ts` / `src/mcp.ts`):**
   - `state.bot_token === null || state.user_id === null`:
     `'Weixin is not logged in. The operator must stop Dreamux, run \`dreamux plugin setup -p weixin\` to scan the WeChat QR code, and restart Dreamux.'`
   - `-14` on `sendmessage`:
     `'Weixin session expired (-14) and polling has stopped. The operator must stop Dreamux, run \`dreamux plugin setup -p weixin\` to scan a new WeChat QR code, and restart Dreamux.'`
   - `state.context_token === null` and session closed: unchanged from `final.md:387-390`.
2. **Malformed state file recovery (`src/state.ts`):**
   - Replace *"restart to log in again"* with *"Move or remove the file and run `dreamux plugin setup -p weixin` to re-authenticate."*
3. **Dispatcher prompt (`packages/channel/weixin-channel/src/instructions.ts`, amending `# WeChat Channel` in `final.md:237-241`):**
   - Add one concise bullet right after the existing three bullets under `# WeChat Channel`:
     ```markdown
     - WeChat login and re-login happen only through `dreamux plugin setup -p weixin` (run by the operator with Dreamux stopped); Dreamux never fetches a QR code at runtime. If `reply` refuses because the session is not logged in or expired (-14), do not search logs for a QR link or retry `reply` — the operator must re-run `dreamux plugin setup -p weixin` and restart Dreamux.
     ```
   - All five personal-agent responsibilities and the rest of the replacement/append prompt in `final.md:234-292` stay unchanged.

---

## 5. Core Touch List (Slice 3 Only — Zero Weixin Concepts)

Combined with Slice 1's ~34 lines (`final.md:129-145`) and Slice 2's ~155 lines (`final.md:33-44`), Slice 3 adds the following Weixin-agnostic Core changes:

| File | Change | Approx. Lines |
|---|---|---|
| `packages/dreamux-types/src/plugin.ts` | `PluginSetupChannel`, `PluginSetupDispatcher`, `PluginSetupSelectOption`, `PluginSetupSelectPrompt`, `PluginSetupUi`, `PluginSetupContext`, and optional `DreamuxPlugin.setup?` | ~45 |
| `packages/dreamux-utils/src/rule-violation.ts` | Cross-realm `Symbol.for('@excitedjs/dreamux-utils/RuleViolation')` brand + `static [Symbol.hasInstance]` | ~10 |
| `packages/dreamux/src/platform/paths.ts` | `pluginsDir(root = dreamuxRoot())` (`~/.dreamux/plugins`) + layout comment update | ~10 |
| `packages/dreamux/src/platform/instance-lock.ts` | `assertNoLiveInstance(lockPath, isAlive?)` | ~18 |
| `packages/dreamux/src/registry/external-import.ts` *(new)* | Shared ~20-line `importExternalPackage(packageName)`: `createRequire(join(pluginsDir(), 'package.json')).resolve` -> `import(pathToFileURL(resolved).href)`, fallback to `import(packageName)` | ~25 |
| `packages/dreamux/src/plugin/loader.ts` | Call `importExternalPackage` in `defaultImportModule` (`loader.ts:368-372`) | ~4 |
| `packages/dreamux/src/registry/provider-loader.ts` | Call `importExternalPackage` in `defaultImportModule` (`provider-loader.ts:181-185`) | ~4 |
| `packages/dreamux/src/cli/plugin-spec.ts` *(new)* | Pure `parsePluginAddSpec(input)` -> `{ packageName, installSpec, pluginRef }` | ~60 |
| `packages/dreamux/src/cli/plugin-add.ts` *(new)* | `runPluginAdd`: pre-flight daemon/config checks, `plugins/package.json` init, `npm install` via `CommandRunner`, post-install `loadPlugins` + `resolveConfig` validation, raw-JSON splice + `writeFileAtomic(0600)` | ~120 |
| `packages/dreamux/src/cli/plugin-setup.ts` *(new)* | `runPluginSetup`: daemon-stopped check, `loadConfig`, plugin lookup, optional interactive Dispatcher creation (W2: ~45 lines; W1: 0 lines), `@clack/prompts` `PluginSetupUi`, `SIGINT`/`SIGTERM` `AbortController`, invoke `plugin.setup(context)` | ~135 (W2) / ~90 (W1) |
| `packages/dreamux/src/cli/commands/plugin.ts` *(new)* | Yargs `plugin <command>` module (`add <name>`, `setup -p <name> [--dispatcher <id>]`) | ~70 |
| `packages/dreamux/src/cli/commands/index.ts` | Register `createPluginCommand()` | ~2 |

- **`.dependency-cruiser.cjs`:** No change required (`src/cli/` is in `composition`; `src/registry/` and `src/plugin/` are both in `foundation`).
- **New file inside `@excitedjs/weixin-channel` (Slice 1 + 3):** `packages/channel/weixin-channel/src/setup.ts` (~110 lines, moving QR login out of `session.ts`, which shrinks by ~80 lines) + `plugin.ts` wires `setup: runWeixinSetup`.

---

## 6. Named Scenarios Only

Every check, branch, and failure path in Slice 3 and the Slice 1 revision maps to a concrete scenario:

| # | Concrete Scenario | Mechanism |
|---|---|---|
| 1 | `dreamux plugin add weixin` while `dreamux serve` is running (managed service or foreground) | `assertNoLiveInstance(adminSocketLockPath(adminSocketPath()))` fails loud with the live PID before `npm` or `config.json` runs. |
| 2 | Stale `admin.sock.lock` left by a crashed `dreamux serve` | `defaultIsPidAlive(pid)` returns `false`; `plugin add` / `plugin setup` proceed normally. |
| 3 | `dreamux` installed via `pnpm -g`, `npx`, Homebrew, or source checkout; operator runs `dreamux plugin add weixin` | Package installs into `~/.dreamux/plugins/` and resolves from there via `createRequire` + `pathToFileURL`, independent of host install location. |
| 4 | Monorepo integration tests or manually side-by-side global installs | `importExternalPackage` falls back to plain `import(packageName)` when absent from `~/.dreamux/plugins/`. |
| 5 | `npm install` fails (typo, offline, auth error) during `plugin add` | Exits non-zero before touching `config.json`; Dreamux stays bootable. |
| 6 | Installed package is not a valid `DreamuxPlugin` (no default factory, throws, bad name, duplicate name/provider) | Post-install `loadPlugins` + `resolveConfig` fails loud before writing `config.json`; no compensating `npm uninstall`. |
| 7 | `config.json` already lists `npm:@excitedjs/weixin-channel` (either re-running `plugin add` or repairing a missing `~/.dreamux/plugins/` install) | Pre-flight parses raw JSON (not `loadConfig`); `npm install` runs, validation passes, `plugins[]` stays deduplicated. |
| 8 | Hand-shaped `config.json` with unknown keys or `~` in `dispatchers[].cwd` | Raw-JSON splice + `writeFileAtomic(..., { mode: 0o600 })` preserves all untouched keys and `~` paths. |
| 9 | External plugin in `~/.dreamux/plugins/` throws `RuleViolation` during `config.agents.replace` | `Symbol.for` `Symbol.hasInstance` on `RuleViolation` preserves `BAD_REQUEST` classification across copies of `@excitedjs/dreamux-utils`. |
| 10 | `dreamux plugin setup -p weixin` when 0 Dispatchers use `builtin:weixin` yet | (W2) Interactively offers to create one dedicated Dispatcher without touching any Feishu Dispatcher, then runs `plugin.setup()`. |
| 11 | `dreamux plugin setup -p weixin` when >1 Dispatchers use `builtin:weixin` | Prompts via `ui.select` (or uses `--dispatcher <id>`); non-interactive mode asks for `--dispatcher <id>`. |
| 12 | Operator presses Ctrl-C during QR scan wait in `plugin setup` | `SIGINT`/`SIGTERM` aborts `context.signal`, cancels in-flight HTTP poll immediately, writes nothing to state file, exits cleanly. |
| 13 | QR expires (`expired`) or redirects (`scaned_but_redirect`) during `plugin setup` | `expired` fetches and prints a fresh QR code; `scaned_but_redirect` switches poll host. |
| 14 | `WeixinChannelSession.start()` with no stored `bot_token` | Throws loudly naming `dreamux plugin setup -p weixin`; `Dispatchers.start()` logs the failure and still starts other Dispatchers. |
| 15 | `-14` on `getupdates` or `sendmessage` at runtime | Clears `bot_token: null` (preserving cursor & `context_token`), logs error naming `dreamux plugin setup -p weixin`, stops poll loop immediately with zero further HTTP calls, and refuses `reply`. |
| 16 | `dreamux doctor` before `plugin setup` or after `-14` | `diagnostic` reads state file and returns `ok: false` naming `dreamux plugin setup -p weixin`. |

**Explicitly excluded (no named scenario):** `plugin remove`/`plugin update`/`plugin list` commands (not requested), `git:`/`file:`/tarball specs, multi-registry fallback chains, lockfile rollback/reinstall, `pnpm` build-script approval UI, hot-reloading plugins into a running daemon, or JSONC comment parsing.

---

## 7. Verification Plan

| Area | Tests |
|---|---|
| Spec parsing | `packages/dreamux/tests/plugin-cli-spec.test.ts`: bare `weixin`, `weixin@0.1.0`, `@excitedjs/weixin-channel`, `@scope/pkg@1.2.3#factory`, `npm:unscoped`, `builtin:feishu` refusal, malformed inputs. |
| `plugin add` + `~/.dreamux/plugins/` resolver | `packages/dreamux/tests/plugin-add.test.ts`: fake `CommandRunner` writing a real ESM plugin fixture into `DREAMUX_ROOT/plugins/node_modules/<pkg>`; proves `plugins/package.json` creation, `npm install` args/cwd, raw `config.json` preservation (unknown keys, `~` cwd, `0600` mode), idempotent re-run, repair of registered-but-uninstalled ref, daemon-running refusal (live PID in `admin.sock.lock`) vs stale PID, failed `npm` leaves `config.json` untouched, invalid plugin package rejected before writing `config.json`, `loadConfig()` resolves from `pluginsDir()` and falls back to workspace `devDependencies`, and cross-copy `RuleViolation` `instanceof` check. |
| `plugin setup` | `packages/dreamux/tests/plugin-setup.test.ts`: daemon-running refusal, unknown plugin refusal, plugin without `setup` refusal, `--dispatcher` filtering & invalid-id refusal, `server()` never called, (W2) interactive Dispatcher creation when 0 matching Dispatchers exist (never mutating an existing Feishu Dispatcher), `SIGINT` abort propagation to `context.signal`. |
| Weixin `setup` + revised Slice 1 | `packages/channel/weixin-channel/tests/setup.test.ts`: 0/1/>1 matching Dispatchers, re-auth confirmation when already logged in, `wait` timeout, `scaned`, `scaned_but_redirect`, `expired` refresh, `confirmed` persists `0600` state (same-account preserves cursor/`context_token`, different account resets them), `need_verifycode` fails cleanly, Ctrl-C abort writes nothing. Revised `session-login.test.ts` -> `session-auth.test.ts` & `session-outbound.test.ts` & `provider.test.ts`: `start()` throws when `bot_token === null` (zero QR calls), `-14` clears `bot_token` and stops polling with zero QR/poll/send calls, `diagnostic` returns `ok: false` when unauthenticated or after `-14` and `ok: true` after setup, `reply` refusal strings name `dreamux plugin setup -p weixin`. |
| End-to-end integration | `packages/dreamux/tests/weixin-plugin-integration.test.ts`: `plugin add` (fake runner installing fixture / workspace link) -> `plugin setup -p weixin` (mock HTTP) -> `dreamux doctor` passes -> `Server` starts Weixin Dispatcher with replacement prompt. |
| Gates | `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`, `node .agents/scripts/check.mjs`. |

---

## 8. Documentation, `CLAUDE.md`, `dreamux-maintenance`, and Change Files

### 8.1 Exact Sentences to Update (Knowing Changes)

1. **`packages/dreamux/CLAUDE.md:69-70`** and **`.agents/domains/channel.md:54-55`:**
   - *Current:* `"the public CLI is reserved for host lifecycle operations."`
   - *Reason:* Operator added `dreamux plugin add` and `dreamux plugin setup` to the public CLI on 2026-11-25.
   - *Update:* Keep `channel.list` without a public CLI wrapper; update the rationale clause to `"the public CLI is reserved for host lifecycle and plugin installation/setup operations."`
2. **`.agents/domains/plugins.md`:**
   - Ownership table (`lines 11-20`): add `DreamuxPlugin.setup` / `PluginSetupContext` (`dreamux-types/src/plugin.ts`), `pluginsDir` (`platform/paths.ts`), `registry/external-import.ts`, and `cli/plugin-{spec,add,setup}.ts` + `cli/commands/plugin.ts`.
   - Loading (`lines 118-171`): document `~/.dreamux/plugins/` two-step resolution, `dreamux plugin add <name>`, and offline `DreamuxPlugin.setup` via `dreamux plugin setup -p <name>` (daemon stopped, no `server()`/`Server`/`Dispatcher`).
   - Weixin plugin section: update to offline QR login via `dreamux plugin setup -p weixin` (no runtime QR).
3. **`.agents/domains/state-config-and-files.md`:**
   - Ownership layout (`lines 15-22`): add `plugins/` (Dreamux-managed npm plugin install root, relocatable with `DREAMUX_ROOT`).
   - Operator Config (`lines 122-135`): note `dreamux plugin add` (and W2 `plugin setup`) edits `config.json` with the daemon stopped via raw-JSON splicing + `writeFileAtomic(0600)`.
   - Channel-Owned State: record `weixin-state.<channel-slug>.<digest>.json` as written by both offline `dreamux plugin setup -p weixin` and the live session.
4. **`.agents/domains/current-architecture.md`:**
   - Lines `51-61` and `213-216`: include `~/.dreamux/plugins/` and `dreamux plugin add`/`setup`.
5. **`.agents/product/README.md`:**
   - Under `## Plugins` (`lines 825-858`): document `dreamux plugin add <name>` and `dreamux plugin setup -p <name>`, and update the Weixin personal-agent entry (QR login only in `plugin setup`; unauthenticated `start()` fails loud for that Dispatcher; `-14` stops polling; `doctor` fails until setup completes).
6. **`packages/dreamux/skills/dispatcher/dreamux-maintenance/`** (current-state-only per `CLAUDE.md:168-181`):
   - `SKILL.md`: routing row covering `dreamux plugin add`, `dreamux plugin setup`, and the Weixin plugin.
   - `references/config-envelope.md`: document `dreamux plugin add <name>` as the CLI way to install into `~/.dreamux/plugins/` and register in `plugins[]` (daemon stopped), and note `~/.dreamux/plugins/` as the first resolution root for `npm:` refs.
   - `references/weixin-plugin.md` *(new)*: `dreamux plugin add weixin`, `dreamux plugin setup -p weixin` (daemon stopped), `weixin-state.<slug>.<digest>.json` ownership, `-14` recovery (stop -> `plugin setup -p weixin` -> start), and no runtime QR.
   - `references/service-lifecycle.md`: add `~/.dreamux/plugins/` to the `~/.dreamux/` directory layout.
7. **Root `CLAUDE.md`:** Audited lines `1-245` — zero sentences conflict; no edit needed.

### 8.2 Rush Change Files

No `BREAKING:` note (all changes are additive; existing `config.json` and state files stay readable and compatible; never `major` on `0.x` per `CLAUDE.md:197-236`):

- `@excitedjs/dreamux`: `minor` — adds `dreamux plugin add` and `dreamux plugin setup` CLI commands, `~/.dreamux/plugins/` plugin install root and resolver (alongside Slice 1 `rolePrompt` and Slice 2 `team.last`).
- `@excitedjs/dreamux-types`: `minor` — adds optional `DreamuxPlugin.setup` and `PluginSetupContext`/`PluginSetupUi`/`PluginSetupDispatcher` contracts (alongside Slice 1 `Dispatcher.channels.list()` and `DispatcherLaunchDraft`).
- `@excitedjs/dreamux-utils`: `patch` — adds cross-realm `Symbol.for` `Symbol.hasInstance` check on `RuleViolation` for plugins installed in `~/.dreamux/plugins/`.
- `@excitedjs/weixin-channel`: initial publishable `0.1.0` package (`shouldPublish: true`).

---

## 9. Operator Decisions Needed

Each item below needs an explicit operator ruling before Slice 3 implementation starts:

1. **Short-name-to-package convention for `dreamux plugin add <name>`:**
   - **Recommendation:** Bare short name `<name>` expands deterministically to `@excitedjs/<name>-channel` (`weixin` -> `@excitedjs/weixin-channel`), while scoped packages (`@scope/pkg`) and explicit `npm:<pkg>[#export]` pass through verbatim (zero Weixin knowledge in Core, zero registry probes).
   - **Alternative:** Rename the unpublished package to `@excitedjs/dreamux-plugin-weixin` and use `@excitedjs/dreamux-plugin-<name>` as the universal official plugin convention (matches `@excitedjs/dreamux-plugin-bootstrap`, works for future non-channel plugins too), **or** keep `@excitedjs/weixin-channel` and require the full scoped name for non-channel plugins.
2. **Where the Weixin Dispatcher entry in `config.json` gets created (W2 vs. W1):**
   - **Recommendation (W2):** `dreamux plugin add` writes **only** `plugins[]`; when `dreamux plugin setup -p <name>` runs for a plugin that contributed a channel provider and **zero** configured Dispatchers reference it yet, Core interactively offers to create one dedicated new Dispatcher (`id`, `cwd`, `agentRuntime` from existing `agents[]`, never touching an existing Feishu Dispatcher) before entering `plugin.setup()`.
   - **Alternative (W1):** Neither `plugin add` nor `plugin setup` touches `dispatchers[]`; the operator hand-edits `dispatchers[]` in `config.json` before running `dreamux plugin setup -p weixin`.
3. **Terminal QR code rendering in `dreamux plugin setup -p weixin` (Q1 vs. Q2):**
   - **Recommendation (Q1):** Render a scannable UTF-8 QR code directly in the terminal using one tiny, zero-dependency MIT QR package (e.g. `uqr` or `qrcode-terminal`) **and** print the raw `qrcode_img_content` URL right beneath it as fallback. (Knowing change to `final.md:117`'s "no third-party runtime package" in `@excitedjs/weixin-channel`.)
   - **Alternative (Q2):** Print only the `qrcode_img_content` URL (keeps zero third-party deps, but forces the operator to open the URL in a browser to scan).
4. **Daemon-stopped gate on `dreamux plugin add` and `dreamux plugin setup`:**
   - **Recommendation:** Both commands check `admin.sock.lock` (`defaultIsPidAlive`) and **refuse loudly** if `dreamux serve` is running, protecting `ConfigService`'s and `WeixinChannelSession`'s in-memory `TransactionalStore` authority against silent overwrite.
   - **Alternative:** Allow `plugin add` while running with a `"restart required"` warning (risks losing the `plugins[]` entry if `config.agents.replace` runs before restart).
5. **Behavior of `WeixinChannelSession.start()` when unauthenticated (`bot_token === null`):**
   - **Recommendation (L2):** Fail loud in `start()` naming `dreamux plugin setup -p weixin` (other enabled Dispatchers still start cleanly via `Dispatchers.start()`, and cron jobs do not fire into a dead channel).
   - **Alternative (L1):** Log a warning and return cleanly with no poll loop (marks channel `live: true` and lets cron turns run against a refusing `reply` tool).

---

## 10. Sentences I Am Least Sure About (Honest Uncertainty Ledger)

1. **`createRequire(join(pluginsDir(), 'package.json')).resolve(pkg)` vs. `"import"`-only ESM third-party packages (Section 2.2):** Verified on Node 22.16 for Dreamux's own packages (which declare both `"import"` and `"default"` in `exports["."]`), but any future third-party plugin that publishes `"exports": { ".": { "import": "./index.js" } }` without `"default"` or `"require"` will fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`. If that ever happens, switching `importExternalPackage` to a 1-line ESM bridge file in `~/.dreamux/plugins/` fixes it with zero contract change.
2. **Fresh install with no `config.json` yet (Section 2.3 & 3.3):** Both `plugin add` and `plugin setup` assume `config.json` (and at least one `agents[]` entry under W2) already exists from `dreamux onboard`. A brand-new user who wants **only** Weixin without ever configuring Feishu currently has no `dreamux onboard` path that skips Feishu without `--channel` or manual `config.json` creation. That gap is out of scope here, but worth knowing.
3. **Bare short-name expansion `@excitedjs/<name>-channel` (Section 2.1):** Works cleanly for `weixin` with zero Weixin code in Core, but bakes `-channel` into the bare-name rule even though `@excitedjs/dreamux-plugin-bootstrap` uses `dreamux-plugin-` instead. If the operator expects bare short names for future non-channel plugins too, aligning on one prefix before `@excitedjs/weixin-channel` is published (Decision #1) is much cleaner than changing it later.
4. **`need_verifycode` wire endpoint in interactive `plugin setup` (Section 3.4):** Because `@tencent-weixin/openclaw-weixin` 2.4.10's source directory (`/tmp/weixin-ref...`) is no longer on disk, I could not verify the exact HTTP endpoint/body for submitting a verification code when WeChat returns `need_verifycode`. The design therefore fails cleanly on `need_verifycode` rather than guessing an unverified endpoint; `PluginSetupUi.text` already gives `setup()` the prompt hook if live testing shows `need_verifycode` occurs.
5. **Windows `npm` invocation & `npm` availability in unusual Node installs (Section 2.2):** `ExecaCommandRunner` resolves `npm` from `PATH` (`npm.cmd` on Windows), which works in standard Node installs, but I could not test Windows `npm.cmd` or a Node-without-npm environment live in this Linux session.
