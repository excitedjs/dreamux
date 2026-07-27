# Local provider plugin store

- **Status:** Implemented; current owner docs are
  [Current architecture](../../reference/current-architecture.md),
  [State and paths](../../reference/state-and-paths.md), and
  [Provider references and capability registry](../../decisions/provider-references-and-capability-registry.md)
- **Date:** 2026-07-27
- **Affects:** `npm:` provider loading, provider installation and updates,
  Dreamux-owned paths, server lifecycle, config loading

## Intent

Make `npm:<package>[#export]` a Dreamux-managed plugin reference. External
provider packages are installed under `~/.dreamux/plugins/` and loaded only
from that private plugin store, so operators do not install providers globally
or into the `@excitedjs/dreamux` package tree.

The first start that references a missing plugin blocks until installation
finishes. Once a plugin is installed, startup uses the selected local generation
without waiting for the registry. The running server checks the npm `latest`
dist-tag no more than once every four hours, installs a newer generation in the
background, and leaves the running provider unchanged. A subsequent process
start loads the newly selected generation.

## Scope

- Add Dreamux-owned path builders for the plugin root, per-package immutable
  generations, package metadata, and installation staging directories.
- Add one host-owned plugin-store capability responsible for npm registry
  lookup, exact-version installation, generation publication, module
  import, persisted check timing, background update scheduling, and
  shutdown.
- Route only external `npm:` refs through the plugin store. Keep `builtin:*`
  aliases loading from the packages shipped as normal `@excitedjs/dreamux`
  dependencies.
- Keep the existing provider factory, named-export selection, contract
  validation, registry registration, and provider-neutral runtime/channel
  seams.
- Update current architecture, provider runtime, state/path documentation, and
  the provider-reference decision.
- Add a `BREAKING:` Rush change entry for `@excitedjs/dreamux`: ambient/global
  npm resolution stops, and the first materialization of each external package
  now requires npm registry access.

## Storage and ownership

`~/.dreamux/plugins/` is Dreamux-owned, persistent, rebuildable installed
content. It is not dispatcher state, volatile run data, or a provider-owned
cache.

The store uses this logical shape:

```text
~/.dreamux/plugins/
  <encoded-package>/
    metadata.json
    versions/
      <version>/
        package.json
        package-lock.json
        dreamux-import.mjs
        node_modules/
          <package>/
    staging/
      <unique-install>/
```

Package names are encoded into one safe path segment by the path owner; callers
never compose plugin paths themselves. A generation is immutable after
publication. `metadata.json` records the selected version and the last completed
update-check attempt time. It uses the existing versioned `JsonDocumentStore`
with warn-and-rebuild corruption policy and `writeFileAtomic`; the plugin store
does not duplicate JSON parsing, format-version, or atomic-write machinery.
Incomplete staging directories are never importable. A later install/update
operation may opportunistically remove stale staging directories it owns; this
change adds no separate garbage collector.

The plugin store owns this layout and npm subprocesses. The generic provider
loader retains its single ref loop, descriptor merge, factory/export selection,
contract checks, and registry writes. Its existing package-resolution step gains
one narrow injected importer: `npm:` refs ask the plugin store for the selected
generation's module namespace, while `builtin:` refs call
`resolveBuiltinProviderPackage` and retain the existing native bare `import()`.
No catalog, config, or Server layer may add a second npm-aware loading loop. The
loader does not know npm commands, metadata shape, or plugin paths. Config and
Server code do not parse plugin files.

## Composition and command modes

The `dreamux serve` composition root constructs exactly one plugin-store
instance. It injects that instance through one config-load operation so the
sequential Agent Runtime and Channel loaders share package materialization. It
starts the same instance's updater only after `Server.start()` succeeds and
closes the updater from the CLI shutdown/failure wrapper before completing
server shutdown. The plugin store is not added to public `ServerOptions`; Server
does not own config-time installation or parse plugin metadata.

Other commands choose an explicit config-load mode:

- `serve`, `onboard`, and `daemon install` use **materialize** mode: a referenced
  missing plugin may block on first installation.
- `doctor` uses **installed-only** mode: it performs no registry lookup or
  install and reports a missing/unusable selected plugin as a diagnostic.
- `uninstall` uses a non-materializing/raw config-read path and never loads or
  installs providers merely to remove Dreamux. Full uninstall removes
  `~/.dreamux/plugins/` as a fixed Dreamux-owned root. If the config directory
  is overridden outside `~/.dreamux`, uninstall still removes both roots; if it
  is the default Dreamux root, removal is de-duplicated.
- `config path` and `config show` remain raw filesystem reads.

The plugin-store/config seam is injectable. Focused config and loader tests keep
using injected module importers and never construct the real store or touch the
operator's plugin root.

Each complete config load collects and de-duplicates external package names
across both Agent Runtime and Channel refs, then invokes the plugin store's
materialization/installed-only check exactly once before either provider-kind
loader runs. Both provider-kind loaders consume only the same selected-generation
importer. They never perform npm lookup or installation themselves.

## Install and load contract

For every distinct package referenced by a well-formed `npm:` provider ref:

1. If metadata selects a complete published generation, return that generation
   immediately without querying npm.
2. If no usable generation exists, query the package's npm `latest` version,
   install that exact `package@version` into a unique staging directory, verify
   the installed package identity/version, publish the immutable generation,
   atomically select it, then import it. The same metadata write selects the
   version and records the successful registry lookup/materialization completion
   time, so the updater does not immediately query again after first startup.
   If a prior attempt already published a complete generation for the resolved
   version but stopped before selection, verify and select that generation
   without reinstalling. If that recovery performed a new registry lookup, its
   selection write records the lookup completion time too. Publishing a
   generation is idempotent; a complete `versions/<version>/` is authoritative
   and is never rebuilt in place. A failed first materialization writes no check
   time, so the next explicit start may retry immediately.
3. A first-install lookup, install, verification, publication, resolution, or
   import failure aborts config loading and therefore aborts startup with the
   provider ref and package in the error.
4. Import external packages through the immutable
   `<generation>/dreamux-import.mjs` bridge. The bridge performs native ESM
   `import(<package>)` from inside the generation and exposes the resulting
   module namespace to the store. This preserves Node's `import` conditional
   exports instead of resolving with CommonJS `require` conditions. The store
   imports only the bridge's absolute file URL and unwraps its namespace for the
   existing provider factory/export selector. Verification guarantees the exact
   package exists in that generation before the bridge runs; never bare-import
   an external package from Dreamux's module location or fall back to Dreamux's
   dependency tree, `NODE_PATH`, the process working directory, or a global npm
   root.
5. Multiple refs or exports from the same package reuse the same selected
   generation. Default and `#named` factory export behavior remains unchanged.

Verification reads the installed package's own
`node_modules/<package>/package.json` and requires its `name` to equal the
requested package and its `version` to equal the exact registry version. A
first-install mismatch fails startup. A background-update mismatch is logged,
leaves selection unchanged, and records the completed failed attempt time.

The npm command inherits the operator/service npm configuration and registry
credentials. Dreamux does not add registry URLs, auth configuration, or a
marketplace. Provider packages are trusted in-process code; this change does not
add a sandbox.

The config grammar remains `npm:<package>[#export]`. Versions and dist-tags do
not enter provider refs; the store follows npm's `latest` dist-tag and records
the exact installed version.

## Background update contract

After `dreamux serve` has loaded config and started successfully, it starts one
plugin updater for the distinct configured external packages.

- Persisted check time, not process uptime, enforces the four-hour interval
  across restarts.
- If a package is already due when the server starts, the check runs in the
  background; it does not delay startup.
- A check resolves the current npm `latest` version. If it differs from the
  selected version, the updater installs and verifies an immutable generation,
  then atomically changes the selected version.
- Updating selection does not re-import a provider, rebuild catalogs, or mutate
  the generation used by the running process. The next config-loading process
  uses the new selection.
- A lookup or background-install failure is logged and leaves the selected
  generation usable. It is not a server-fatal error.
- Every completed background attempt records its completion time, including a
  no-update result, lookup failure, install failure, or verification failure.
  An aborted/incomplete attempt does not advance the timestamp.
- The updater owns one single-flight state machine driven by one unreferenced,
  re-arming timer. An on-start due check enters the same flight chain as later
  four-hour re-arms, and the next package attempt is scheduled only after the
  current attempt settles. No second timer, parallel queue, or separate startup
  kick exists. Shutdown clears future work and aborts an in-flight npm
  subprocess through an updater-owned `AbortController`. Interrupted staging
  content remains non-importable.
- Packages no longer referenced by config are retained. Automatic uninstall and
  garbage collection are outside this change.

The plugin-store layer owns a narrow abortable npm runner. It must not import or
expand the onboarding `CommandRunner`, whose non-abortable setup/diagnostic
contract belongs to another layer.

## Hard constraints

- No global provider installation and no ambient Node resolution for `npm:`
  refs.
- No network or install work for `builtin:` refs.
- Plugin-store materialization runs once per config load across both provider
  kinds; runtime/channel loaders only consume the selected-generation importer.
- No in-place mutation of a published generation.
- No provider hot reload. Updates apply only to a later process start.
- No provider-specific logic or config fields in core.
- No synchronous filesystem or process APIs under `packages/*/src/**`.
- Plugin path construction stays in `platform/paths.ts`.
- Metadata uses the existing host-owned `JsonDocumentStore`; do not hand-roll a
  parallel JSON document format/store.
- Existing injected module-import seams remain available for focused tests;
  they must not touch the operator's real plugin store.
- Load-bearing provider contract validation and fail-loud first-install behavior
  remain intact.

## Acceptance

- A config whose external package is absent blocks until a fake/fixture npm
  installer publishes it, then loads its default or named provider factory from
  the plugin generation.
- A crash after generation publication but before metadata selection is
  recovered by verifying and selecting the existing generation without a
  second install.
- First-install failure prevents startup and reports the canonical provider ref.
- An ambient or globally resolvable package cannot satisfy an `npm:` ref when
  the plugin store lacks it.
- An import-only conditional-exports fixture and an import/require split fixture
  both load their ESM provider entry through the generation-local bridge; an
  ambient package cannot satisfy a missing generation.
- A complete existing generation loads without a registry query or install.
- Two refs from one package, including one runtime ref and one channel ref,
  perform one config-level materialization and use one generation.
- Before four hours, restart/startup does not query; when due, the running server
  starts with the installed generation while the update runs in the background.
- A successful first installation records its completed check time, and the
  updater in that same serve process does not issue an immediate second query.
- Every settled update attempt persists its completion time and a fresh
  process honors it; an aborted attempt does not.
- A successful update selects the exact registry version without changing the
  already loaded module; a fresh loader uses the new generation.
- A failed background check/install preserves the selected generation and logs
  the failure.
- Closing the updater during an in-flight install clears its timer, aborts the
  npm subprocess, leaves selection unchanged, and leaves only non-importable
  staging content.
- Interrupted staging content is ignored and cannot become selected.
- `serve`, `onboard`, and `daemon install` materialize; `doctor` is
  installed-only; `uninstall` never loads providers and removes the plugin root.
- `doctor` reports a missing selected `npm:` plugin as a diagnostic without
  installing it or failing through the normal runnable-provider config gate.
- Builtin provider loader tests remain green and prove no plugin-store call.
- Runtime-path tests lock `~/.dreamux/plugins/`; config/loader tests use injected
  roots, clocks, registry clients, command runners, and module importers.
- `rush build`, `rush typecheck`, `rush typecheck:tests`, `rush lint`, `rush
  test`, `rush change --verify`, the built CLI smoke test, and
  `.agents/scripts/check.sh` pass.

## Out of scope

- A public `dreamux plugin install`, list, remove, pin, or update command.
- Versions, ranges, URLs, tarballs, git refs, local paths, or dist-tags in
  provider refs.
- Automatic removal or garbage collection of old/unreferenced generations.
- Hot reload or live provider migration.
- A marketplace, plugin discovery scan, sandbox, signature system, or separate
  plugin manifest ABI.
- Changing the public provider factory/type contract.
