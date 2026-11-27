# Technical Design Exploration — Operator-Facing Plugin Surface and Install Model

> Status: Design options draft (follow-up to [draft-plugin-cli.md](draft-plugin-cli.md)).
> Task record: [../README.md](../README.md)
> Baseline requirement & confirmed Slice 1/2 design: [../requirement.md](../requirement.md), [final.md](final.md).
> Scope: Redesign the CLI command surface and install model after the operator rejected `dreamux plugin add <name>` + `dreamux plugin setup -p <name>` as (1) asymmetric and (2) constraining how a plugin is installed, while confirming three choices on the same card: a Dreamux-managed install directory (`~/.dreamux/plugins/`), terminal QR rendering (one third-party QR package allowed), and interactive Dispatcher creation inside the setup step.

---

## 1. Testing the Operator's Two Objections

Operator's verbatim feedback: *"主要在 setup 这里，这只是我给的一个演示，但是这个命令其实不太好，他一不对称。二给插件约束了安装方式。但是我目前没有更好的想法"*.

### Objection 1 — "Asymmetric" ("不对称")

Testing three hypotheses against `draft-plugin-cli.md` and Dreamux's existing CLI (`packages/dreamux/src/cli/commands/`):

1. **Hypothesis 1A — Argument-shape and identifier asymmetry (strongly supported):**
   - `dreamux plugin add <spec>` took a **positional** package spec / short alias (`@excitedjs/weixin-channel` or `weixin`), whereas `dreamux plugin setup -p <plugin-name>` switched to a **`-p` flag** and addressed a **different identifier space** (the runtime `DreamuxPlugin.name`, which the operator does not even know before installing a third-party package).
   - Every reference CLI inspected uses one uniform positional selector across its verbs: Codex (`codex plugin add/remove <PLUGIN[@MARKETPLACE]>`), Claude Code (`claude plugin install/uninstall/enable/disable/update <plugin>`), OpenClaw (`openclaw plugins install/uninstall/enable/disable <id>`), and DeepSeek Harness (`dsh plugin --profile <name> <pnpm args>`).
2. **Hypothesis 1B — Incomplete lifecycle verbs (supported, secondary):**
   - `draft-plugin-cli.md` offered `add` with no `remove` and no `list`, breaking the paired-verb convention Dreamux uses elsewhere (`onboard`/`uninstall`, `daemon install`/`uninstall`, `start`/`stop`).
3. **Hypothesis 1C — Layer asymmetry: `setup` lives on `plugin`, while what is being set up is a Channel/Dispatcher (strongly supported — directly explains *"主要在 setup 这里"*):**
   - A plugin is installed **once** globally (`plugins[]`), whereas a Channel (and its state file `weixin-state.<slug>.<digest>.json`) belongs to a specific `dispatchers[].channels[]` instance. Hosting channel login under `plugin setup` forced a plugin-scoped command to add `--dispatcher`, inspect `dispatchers[]`, and even create a Dispatcher in `config.json`.
   - Meanwhile, Feishu is configured through `dreamux onboard` (`ChannelProvider.onboard.collect`, `packages/dreamux-types/src/channel.ts:316`), creating two unrelated setup paths for two Channels.

**Best-supported reading:** **1A + 1C together** (with 1B as a cheap cleanup): the `-p <plugin-name>` flag mismatches `add`'s positional `<spec>`, and forcing per-channel login + Dispatcher creation onto a plugin-level `setup` verb sits at the wrong level unless either `configure` is paired symmetrically with `install` (Candidate 1), channel login moves to the channel layer (Candidate 2), or plugins own their own subcommands (Candidate 3).

### Objection 2 — "Constrains how a plugin is installed" ("给插件约束了安装方式")

Testing two hypotheses:

1. **Hypothesis 2A — Distribution and package-manager lock-in (strongly supported):**
   - `draft-plugin-cli.md` locked `plugin add` to npm registry names (plus a hardcoded `@excitedjs/<name>-channel` rewrite) and to Dreamux's `npm install` command. It had no `file:` ref in `packages/dreamux/src/registry/provider-ref.ts:70-100`, so a plugin author could not ship a local directory, git repository, tarball, or non-npm bundle — nor could an operator point `config.json` at a local checkout without `npm`.
   - Every reference system inspected decouples plugin identity from a single distribution channel:
     - **DeepSeek Harness** (`install-spec.ts:16-20`, `operations.ts:69-73`, `plugin-market-index/README.md:35`): accepts npm registry, `file:`/`link:` local paths, git commits/URLs, and tarballs.
     - **Claude Code** (`utils/plugins/schemas.ts:1062-1161`): accepts relative local paths, `npm`, `pip`, `git` URLs, `github`, and `git-subdir` monorepo paths.
     - **Codex** (`codex-rs/core-plugins/src/marketplace.rs:128-143`): accepts `Local { path }`, `Git { url, path, ref, sha }`, and `Npm { package, version, registry }`.
     - **OpenClaw** (public docs): accepts ClawHub names, `npm:<pkg>`, `git:...`, `./local`, and `--link ./local`.
2. **Hypothesis 2B — Rigid two-step installation choreography (strongly supported — also explains *"主要在 setup 这里"*):**
   - Splitting installation into a host-dictated two-step ritual (`plugin add` -> separate manual `plugin setup -p <name>`) constrains every plugin's installation lifecycle: a plugin that needs configuration during install cannot run it during `add` (unlike Claude Code's `PluginOptionsFlow.tsx:59-95`), a plugin that needs multiple operational commands (`login`, `logout`, `status`) is squeezed into one `setup` hook, and an operator who installed a plugin outside `dreamux plugin add` still has to satisfy the `add`-centric mental model.

**Best-supported reading:** **Both 2A and 2B hold.** Dreamux should state only **where a plugin module must be resolvable from** (`~/.dreamux/plugins/`, standard Node resolution, or an explicit `file:<path>` ref), accept any source the author publishes (npm, git, tarball, local directory, or operator-managed install), and stop forcing every plugin into an artificial two-step `add` + `setup -p` ritual.

---

## 2. Verified Reference Survey

| System | Verified CLI Commands | Install Model & Storage | How Name Maps to Source | Setup / Auth Flow | Out-of-Tree Author Requirements |
|---|---|---|---|---|---|
| **DeepSeek Harness** (a local read-only checkout) | `dsh plugin --profile <name> <pnpm args>` (`apps/cli/README.md:18`, `apps/cli/src/plugin.ts:71-108`); optional `allow-version` / `revoke-version` / `version-exemptions`. | Home-owned profile dir `$DSH_HOME/profiles/<name>/` (`package.json` + `pnpm-workspace.yaml` + `node_modules/`). `pnpm` accepts npm, `file:`/`link:`, git, tarballs. | Explicit spec on CLI; optional JSON/Git **market index** (`packages/boot/plugin-market/README.md:44, 106`; `packages/util/plugin-market-index/README.md:35`) maps plugin entries to `name@version` (+ optional `registry`) or commit-pinned `git+https://...#sha&path:...`. | **Separate from `dsh plugin`:** connectors register interactive flows (including QR binding in `packages/connector/wecom/src/account.ts:43-55`) on `ctx.authorization` / `ctx.cliAccounts` (`packages/credentials/authorization/src/index.ts:87-143`). | Package manifest with `dsh.bundle.patch` + Cordis patch YAML + optional `engines.dsh` / locale meta. |
| **Claude Code** (a local read-only checkout) | `claude plugin install/uninstall/enable/disable/update/list/validate <plugin>`; `claude plugin marketplace add/list/remove/update` (`main.tsx:4148-4264`). | Caches fetched plugins into `~/.claude/plugins/cache/` + `installed_plugins.json` (`utils/plugins/pluginInstallationHelpers.ts:110-145`); local marketplaces stay read-only in place (`schemas.ts:1226-1240`). | `name` or `name@marketplace` (`utils/plugins/pluginIdentifier.ts:51-57`). Marketplace JSON maps `name` to `source`: `./local`, `npm`, `pip`, `url` (git), `github`, or `git-subdir` (`schemas.ts:1062-1161`). | **No `plugin setup` CLI verb:** manifest declares `userConfig` or `channels[].userConfig` (`schemas.ts:670-703`), and interactive install/enable runs `PluginOptionsFlow` (`commands/plugin/PluginOptionsFlow.tsx:59-95`). | Directory/package with `.claude-plugin/plugin.json` (skills, hooks, MCP/LSP servers, channels, `userConfig`). |
| **Codex** (a local read-only checkout) | `codex plugin add/remove/list <PLUGIN[@MARKETPLACE]>`; `codex plugin marketplace add/list/upgrade/remove` (`codex-rs/cli/src/plugin_cmd.rs:66-141`, `marketplace_cmd.rs:34-113`). | `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/` + `plugins/data/` (`core-plugins/src/store.rs:26-28, 112-127`). For npm sources, runs `npm pack --ignore-scripts` and extracts the tarball (`core-plugins/src/npm_source_tests.rs:58-64`). | `PLUGIN[@MARKETPLACE]` or `--marketplace`; marketplace manifest (`.agents/plugins/marketplace.json`, also reads `.claude-plugin/marketplace.json`) maps `name` to `Local`, `Git`, or `Npm` (`core-plugins/src/marketplace.rs:20-25, 128-143`). | **No `plugin setup` CLI verb:** marketplace entries declare `authentication: ON_INSTALL \| ON_USE` (`marketplace.rs:178-185`) handled via connector/runtime auth, not a plugin CLI setup verb. | Plugin root with `.codex-plugin/plugin.json` (skills, MCP servers, hooks, apps). |
| **OpenClaw** (public docs at `openclaw.ai`, fetched via web search) | `openclaw plugins install/uninstall/enable/disable/list/search`; **separate** `openclaw channels add/login/logout/status/list/logs`. | Installs plugins from ClawHub, `npm:<pkg>`, `git:...`, `./local`, or `--link ./local`. | ClawHub short name or explicit `npm:` / `git:` / local path on `install`; plugin id on `uninstall`/`enable`/`disable`; channel id on `channels login --channel <id>`. | **Channel-level verb:** `openclaw channels login --channel <id>` renders terminal QR for QR-paired channels; token channels use `openclaw channels add`. | Channel plugin package exposing OpenClaw plugin SDK hooks + channel login handler. |

### Naming Fact Inside This Repository

`rush.json:78-81` already names the existing opt-in plugin `@excitedjs/dreamux-plugin-bootstrap`, whereas the provisional Weixin package name is `@excitedjs/weixin-channel` (matching `@excitedjs/feishu-channel` at `rush.json:63-66`). Therefore:
- A Core-hardcoded bare-name convention like `@excitedjs/<name>-channel` **contradicts** `@excitedjs/dreamux-plugin-bootstrap` and bakes one channel-only naming rule into Core.
- None of the four reference systems hardcodes a single scope-and-suffix rewrite rule in Core: they either take an **explicit install source** (npm/git/tarball/path) or resolve a short name through a **data-driven marketplace/index**.

---

## 3. Three Candidate Designs

All three candidates share the same **resolution and storage foundation** (honoring the operator's card choices and zero-Weixin-in-Core constraint):
- **Resolution rule (what Dreamux states as its only plugin loading requirement):** A plugin ref in `config.json` `plugins[]` is either:
  - `builtin:<id>` (bundled with Dreamux),
  - `npm:<package>[#export]` (resolved from `~/.dreamux/plugins/package.json` first via `createRequire` + `pathToFileURL`, falling back to Dreamux's own `import(package)` so monorepo `devDependencies` and operator-installed global packages keep working), or
  - `file:<absolute-path>[#export]` *(new additive `ProviderRef` scheme in `packages/dreamux/src/registry/provider-ref.ts`)* — imported directly via `pathToFileURL(path).href` with **zero package manager**.
- **Install directory:** `~/.dreamux/plugins/` (`pluginsDir()` under `DREAMUX_ROOT`), holding a private `package.json` + `node_modules/`.
- **Daemon-stopped guard:** Config/state-mutating CLI commands check `run/admin.sock.lock` (`defaultIsPidAlive`) before writing `config.json` or Channel-owned state, protecting `ConfigService` and `WeixinChannelSession`'s in-memory `TransactionalStore` authority.
- **Cross-copy `RuleViolation`:** `Symbol.for` `Symbol.hasInstance` brand in `packages/dreamux-utils/src/rule-violation.ts` (~10 lines).
- **Slice 1 login revision (identical across all three candidates):** `WeixinChannelSession` drops all runtime QR login; unauthenticated `start()` fails loud for that Dispatcher (other Dispatchers keep starting); `-14` clears `bot_token: null` and stops polling; `diagnostic` returns `ok: false` when unauthenticated; `reply` refusals and Dispatcher prompt point to the chosen CLI command instead of the channel log.

---

### Candidate 1 — Symmetric Unified `dreamux plugin` (`install` / `remove` / `list` / `configure`) with Auto-Configure on Install

*Pattern: Claude Code's symmetric `plugin` lifecycle + post-install configuration walk, combined with DeepSeek Harness's source-agnostic package install into a home-owned directory.*

1. **Exact commands:**
   - `dreamux plugin install <source> [--link] [--no-configure]` (alias `add`)
   - `dreamux plugin remove <plugin>` (alias `uninstall`)
   - `dreamux plugin list`
   - `dreamux plugin configure <plugin> [--dispatcher <id>]`
2. **What each argument is:**
   - `<source>` on `install`: any source `npm install` accepts — scoped or unscoped npm package (`@excitedjs/weixin-channel`, `@excitedjs/weixin-channel@0.1.0`), git URL (`git+https://...`, `github:org/repo#sha`), tarball (`./pkg.tgz`, `https://.../pkg.tgz`), or local directory (`./packages/channel/weixin-channel`, `file:/abs/path`). Relative paths are anchored against the caller's `cwd`. With `--link` on a local directory/file, Dreamux skips `npm` entirely and registers `file:<abs-path>`.
   - `<plugin>` on `remove` and `configure`: **positional** (no `-p` flag), accepting **any** of the plugin's runtime `name` (`weixin`), its npm package name (`@excitedjs/weixin-channel`), or its exact `plugins[]` ref (`npm:@excitedjs/weixin-channel`, `file:/...`).
3. **How a plugin name maps to something installable:**
   - `install` takes an explicit `<source>` — **no hardcoded `@excitedjs/<name>-channel` magic in Core**. After `npm install` completes in `~/.dreamux/plugins/`, Core diffs/inspects the installed package's `package.json` `name` to derive the canonical `npm:<pkg>` ref (even when `<source>` was a git URL, tarball, or local directory).
   - Once installed and listed in `plugins[]`, `configure` and `remove` resolve the short `plugin.name` (`weixin`) directly from loaded plugins.
4. **What `plugins[]` stores:**
   - `npm:<package-name>[#export]` (for npm/git/tarball/copied-dir installs inside `~/.dreamux/plugins/` or external `node_modules`) or `file:<absolute-path>[#export]` (for `--link` or operator hand-registered local modules). Existing `config.json` files stay 100% compatible.
5. **Where a package comes from and who installs it:**
   - **Normal path:** `dreamux plugin install <source>` runs `npm install --save --no-audit --no-fund <anchored-source>` inside `~/.dreamux/plugins/`, validates the module as a `DreamuxPlugin`, writes `plugins[]` atomically (`0600`, preserving untouched raw JSON), and runs `configure` if interactive.
   - **Author/operator self-managed path:** Author or operator may install via `pnpm`/`yarn`/`bun` into `~/.dreamux/plugins/`, install globally beside Dreamux, or use `--link` / `file:<abs-path>` with **zero `npm`**; `dreamux plugin configure <plugin>` works identically regardless of how the module arrived.
6. **What a plugin author must do or cannot do:**
   - **Must:** Ship an ESM module (with `"default"` or `"main"` export for `npm:` refs, or any ESM entry for `file:` refs) whose zero-argument synchronous factory returns a `DreamuxPlugin`; optionally implement `configure?(context: PluginConfigureContext): Promise<void>`.
   - **Cannot:** Mutate `config.json` directly (Core owns it), depend on `@excitedjs/dreamux`, or assume it was installed by `npm`.
7. **How Dispatcher creation and terminal QR fit:**
   - On `dreamux plugin install @excitedjs/weixin-channel` in an interactive TTY: after installing and registering `plugins[]`, Core sees the plugin declared `configure` and contributed a `channel` provider (`builtin:weixin`) with 0 configured Dispatchers -> Core interactively offers to create one dedicated Dispatcher (`id`, `cwd`, `agentRuntime`, never touching an existing Feishu Dispatcher), then calls `plugin.configure(context)` -> renders terminal QR + URL -> writes `weixin-state.<slug>.<digest>.json`. One command from zero to logged-in!
   - On `-14` token expiry later: operator stops daemon and runs `dreamux plugin configure weixin` -> Dispatcher already exists, so Core skips Dispatcher creation and runs QR scan immediately.
8. **Core touch size:** ~500 lines (`dreamux-types/src/plugin.ts`, `dreamux-utils/src/rule-violation.ts`, `platform/paths.ts`, `platform/instance-lock.ts`, `registry/provider-ref.ts` for `file:`, `registry/external-import.ts`, `plugin/loader.ts`, `registry/provider-loader.ts`, `cli/plugin-{install,remove,list,configure}.ts`, `cli/commands/plugin.ts`).
9. **Entropy verdict:** **Lowest entropy.** One CLI namespace (`dreamux plugin`), four symmetric positional verbs (`install`/`remove`/`list`/`configure`), zero `-p` flag, zero marketplace state, one optional method on `DreamuxPlugin`, and one-command first-time onboarding (`install` auto-runs `configure`). Residual flaw: `configure` still sits at the plugin level even when what it configures is a Channel instance, and a plugin gets only one generic `configure` entry point.

---

### Candidate 2 — Two-Layer Split: Source-Agnostic `dreamux plugin` (`add` / `remove` / `list`) + Channel-Level `dreamux channel` (`add` / `login` / `list`)

*Pattern: OpenClaw's strict separation between plugin code management (`openclaw plugins`) and channel setup/authentication (`openclaw channels add` / `openclaw channels login`).*

1. **Exact commands:**
   - **Plugin code & registration layer:**
     - `dreamux plugin add <source> [--link]` (alias `install`)
     - `dreamux plugin remove <plugin>` (alias `uninstall`)
     - `dreamux plugin list`
   - **Channel wiring & authentication layer:**
     - `dreamux channel add <provider>` (e.g., `dreamux channel add weixin` or `builtin:weixin`, or `feishu`)
     - `dreamux channel login [dispatcher] [--channel <id>]` (defaults automatically when only one login-capable channel exists)
     - `dreamux channel list` (reads `config.json` offline: Dispatcher id, channel id, provider ref, auth/login capability)
2. **What each argument is:**
   - `plugin add <source>`: same source-agnostic `<source>` as Candidate 1 (npm pkg, git URL, tarball, local dir, or `--link` -> `file:<abs-path>`).
   - `plugin remove <plugin>`: positional `plugin.name`, package name, or `plugins[]` ref.
   - `channel add <provider>`: positional contributed channel provider id (`weixin`, `feishu`, or canonical `builtin:weixin`).
   - `channel login [dispatcher]`: optional positional Dispatcher id (auto-selected when 1 login-capable channel is configured; interactive `select` when >1).
3. **How a plugin name maps to something installable:**
   - Same as Candidate 1: `plugin add` takes an explicit `<source>` (no hardcoded `@excitedjs/<name>-channel` magic). Once loaded, `channel add` uses the provider id contributed by `plugin.contribute()` (`weixin` -> `builtin:weixin`).
4. **What `plugins[]` stores:**
   - Same as Candidate 1: `npm:<package-name>[#export]` or `file:<absolute-path>[#export]`.
5. **Where a package comes from and who installs it:**
   - Same as Candidate 1: `dreamux plugin add` is the optional installer for `~/.dreamux/plugins/` (or `--link` for `file:`), while operators may equally install by any tool into `~/.dreamux/plugins/` or register `file:<path>` by hand. `dreamux channel add` / `login` only require the provider to be resolvable from `config.json`.
6. **What a plugin author must do or cannot do:**
   - **Must:** Return a `DreamuxPlugin` whose `contribute()` registers a `ChannelProvider`; implement `ChannelProvider.login?: { run(context: ChannelLoginContext): Promise<void> }` (`packages/dreamux-types/src/channel.ts`) alongside `onboard` and `diagnostic`. `DreamuxPlugin` itself needs **zero** new methods!
   - **Cannot:** Expose a non-channel interactive setup flow through `dreamux channel` (non-channel plugins have no setup CLI under this candidate unless one is added later).
7. **How Dispatcher creation and terminal QR fit:**
   - `dreamux channel add weixin` interactively creates a dedicated Dispatcher in `config.json` (asking `id`, `cwd`, `agentRuntime`, running `onboard.collect` for token-based channels like Feishu or skipping it for empty-config Weixin), and if `provider.login` exists, immediately runs terminal QR login!
   - On `-14` expiry later: `dreamux channel login` (zero flags when only one Weixin Dispatcher exists!) runs `provider.login.run(context)` with that exact Dispatcher's `state_root` and `channel_id` and renders the terminal QR.
   - Note: `ChannelLoginContext` receives `{ dispatcher_id, channel_id, provider, config, state_root, cache_root, ui, signal, logger }` — identical in shape to `ChannelSessionCreateContext` (`packages/dreamux-types/src/channel.ts:280-289`)!
8. **Core touch size:** ~560 lines (`dreamux-types/src/channel.ts` instead of `plugin.ts`, `dreamux-utils/src/rule-violation.ts`, `platform/`, `registry/`, `plugin/loader.ts`, `cli/plugin-*.ts`, `cli/channel-*.ts`, `cli/commands/plugin.ts`, `cli/commands/channel.ts`).
9. **Entropy verdict:** **Cleanest domain alignment for channels, higher CLI surface.** Directly resolves Reading 1C (channel login belongs to `ChannelProvider`, not `DreamuxPlugin`, so `channel_id` and `state_root` need no cross-layer lookup from `plugin` to `dispatchers[]` and Feishu + Weixin live on one seam). **Costs:** introduces a second top-level CLI group (`dreamux channel`), overlaps with `dreamux onboard` (two commands that create a Dispatcher + channel), explicitly revises `packages/dreamux/CLAUDE.md:69-70` and `.agents/domains/channel.md:54-55` (which currently state there is no `channel` CLI wrapper), and does not cover setup for non-channel plugins.

---

### Candidate 3 — Pure Package `dreamux plugin` (`add` / `remove` / `list`) + Plugin-Contributed CLI Commands (`dreamux plugin <name> <cmd>`)

*Pattern: Minimalist host kernel (decoupled resolution + package registry) where plugins define their own offline CLI operations rather than conforming to a single host-dictated `setup` verb.*

1. **Exact commands:**
   - **Host-owned package verbs (reserved names):**
     - `dreamux plugin add <source> [--link]`
     - `dreamux plugin remove <plugin>`
     - `dreamux plugin list`
   - **Plugin-contributed commands (loaded lazily only when the token after `plugin` is not `add`/`remove`/`list`):**
     - `dreamux plugin <plugin-name> <command> [options]`
     - For Weixin: `dreamux plugin weixin login [--dispatcher <id>]` (and the plugin is free to also add `status` or `logout` without any Core change!).
2. **What each argument is:**
   - `plugin add <source>` and `plugin remove <plugin>`: identical to Candidate 1/2 (positional source on `add`, positional name/ref on `remove`).
   - `plugin <plugin-name> <command>`: positional plugin `name` (never `-p`), followed by a command name declared by that plugin (`login`).
3. **How a plugin name maps to something installable:**
   - Same explicit `<source>` on `add`. (Optionally, if Dreamux later adds a read-only JSON index like DeepSeek Harness `plugin-market-index` or Codex/Claude Code `marketplace.json`, `plugin add <short-name>` can resolve `<short-name>` through configured indexes with zero Core hardcoding — deferred until >1 installable plugin exists.)
4. **What `plugins[]` stores:**
   - Same: `npm:<package-name>[#export]` or `file:<absolute-path>[#export]`.
5. **Where a package comes from and who installs it:**
   - Same as Candidates 1 & 2: `~/.dreamux/plugins/` via `npm install`, `--link` via `file:<abs-path>`, or any operator-managed install resolvable from `plugins[]`.
6. **What a plugin author must do or cannot do:**
   - **Must:** Export a `DreamuxPlugin` with optional `commands?: readonly PluginCliCommand[]`, where each command declares `{ name, description, run(context: PluginCliContext): Promise<void> }`.
   - **Freedom:** Plugin authors choose both **how to publish** (npm, git, tarball, local `file:`) and **what operational commands** make sense (`login`, `logout`, `init`, or none). Core never forces a "setup" ritual.
   - **Cannot:** Mutate `config.json` directly (to wire a Dispatcher, the plugin calls one narrow host helper `context.ensureChannelDispatcher(providerRef)` that Core executes and validates), or shadow reserved verbs `add`/`remove`/`list` (rejected at plugin load or reserved in `PLUGIN_NAME_PATTERN` check).
7. **How Dispatcher creation and terminal QR fit:**
   - Operator runs `dreamux plugin add @excitedjs/weixin-channel` (or `--link ./packages/channel/weixin-channel`), then `dreamux plugin weixin login`.
   - Inside Weixin's `login` command: calls `const target = await context.ensureChannelDispatcher('builtin:weixin')` (if 0 Dispatchers use `builtin:weixin`, Core interactively creates one dedicated Dispatcher; if 1, returns it; if >1, prompts with `select`), then renders the terminal QR and writes `weixin-state.<slug>.<digest>.json`.
8. **Core touch size:** ~540 lines (`DreamuxPlugin.commands` + `PluginCliContext` + `ensureChannelDispatcher` in `dreamux-types/src/plugin.ts`, lazy subcommand router in `cli/commands/plugin.ts`, `cli/plugin-{add,remove,list,dispatcher,run}.ts`, `file:` ref + `external-import.ts`, `RuleViolation` brand).
9. **Entropy verdict:** **Highest author autonomy, medium-high Core contract complexity.** Completely removes any host-mandated "setup" concept and keeps `dreamux mcp` / `--version` fast via lazy loading. **Costs:** Core must own a plugin command-dispatch contract (help text, option/arg forwarding, reserved-verb collisions), first-time onboarding stays two commands (`add` then `plugin weixin login`), and every plugin can invent a different verb name (`login` vs `setup` vs `init`) that users have to discover via `--help`.

---

## 4. Comparison Matrix and Recommendation

| Dimension | Candidate 1 (`plugin install/remove/list/configure`) | Candidate 2 (`plugin add/remove/list` + `channel add/login/list`) | Candidate 3 (`plugin add/remove/list` + `plugin <name> <cmd>`) |
|---|---|---|---|
| Fixes arg/verb asymmetry (1A, 1B) | **Yes** — all 4 verbs positional, same `<plugin>` id, no `-p` | **Yes** — symmetric in both `plugin` and `channel` | **Yes** — positional `<plugin-name> <cmd>`, no `-p` |
| Fixes plugin-vs-channel layer split (1C) | Partial — `configure` is plugin-level, auto-runs after `install` | **Yes** — login & Dispatcher wiring live on `ChannelProvider` | **Yes** — plugin names its own domain verb (`weixin login`) |
| Fixes install-method constraint (2A, 2C) | **Yes** — npm/git/tarball/dir + `--link` (`file:`) + manual install | **Yes** — same | **Yes** — same |
| Fixes rigid two-step setup ritual (2B) | **Yes** — interactive `install` auto-configures (1 command!); `configure` for re-login | Partial — still two commands (`plugin add` -> `channel add`), though each has a crisp domain job | Partial — two commands (`plugin add` -> `plugin weixin login`), but plugin owns its verbs |
| Covers non-channel plugins | **Yes** | No (channel-only) | **Yes** |
| Overlap with `dreamux onboard` | None | Overlaps (`channel add` vs `onboard`) | None |
| Core touch size (approx. lines) | **~500** | ~560 | ~540 |
| New CLI namespaces | **1** (`plugin`) | 2 (`plugin`, `channel`) | **1** (`plugin`) |
| New contract surface | `DreamuxPlugin.configure?` | `ChannelProvider.login?` | `DreamuxPlugin.commands?` + `ensureChannelDispatcher` |

### Recommendation

- **Primary recommendation: Candidate 1 (`dreamux plugin install / remove / list / configure`)**, because it achieves the **lowest entropy** (one CLI namespace, four symmetric positional verbs, zero `-p` flag, zero overlap with `dreamux onboard`), eliminates the rigid two-step UX on first install (`dreamux plugin install @excitedjs/weixin-channel` installs, creates the dedicated Dispatcher, and runs terminal QR login in one unbroken flow, while `dreamux plugin configure weixin` handles `-14` re-login and manually-installed plugins), and removes all distribution lock-in (supporting npm, git, tarball, local dir, and `--link` / `file:` with zero `npm`).
- **Strong alternative if the operator wants strict OpenClaw-style channel/plugin separation: Candidate 2 (`dreamux plugin add/remove/list` + `dreamux channel add/login/list`)**, which puts `login` directly on `ChannelProvider` beside `onboard` and `diagnostic` and makes `-14` re-login simply `dreamux channel login`.
- **On bare short names (`weixin` vs `@excitedjs/weixin-channel`):** Recommend **no hardcoded naming convention in Core** for any candidate — accept explicit sources (`@excitedjs/weixin-channel`, `./path`, `git+...`) on `install`/`add`, and use the short `plugin.name` (`weixin`) on every verb afterward. Only introduce a lightweight JSON index (like DeepSeek Harness `plugin-market-index` / Codex `marketplace.json`) in a future task once multiple installable plugins exist.

---

## 5. Operator Decisions Still Needed (Per Candidate)

### Common to All Three Candidates

1. **Bare short-name installation (`dreamux plugin install weixin` vs `@excitedjs/weixin-channel`):**
   - *Recommendation:* Require an explicit source on `install`/`add` (`@excitedjs/weixin-channel`, `./path`, `git+...`) with zero Core naming rewrite; use short `weixin` on all post-install commands.
   - *Alternative A:* Unify unpublished official plugin names under `@excitedjs/dreamux-plugin-<name>` (renaming `@excitedjs/weixin-channel` to `@excitedjs/dreamux-plugin-weixin` to match `@excitedjs/dreamux-plugin-bootstrap`) and expand bare names to `@excitedjs/dreamux-plugin-<name>`.
   - *Alternative B:* Add a small official JSON index file later (marketplace model).
2. **`file:<abs-path>` ref support (`--link`):**
   - *Recommendation:* Add `file:<abs-path>[#export]` to `ProviderRef` (`packages/dreamux/src/registry/provider-ref.ts`) so local/non-npm plugins work with zero `npm` dependency.
   - *Alternative:* Keep `ProviderRef` to `builtin:` + `npm:` only (relying on `npm install ./local-dir` inside `~/.dreamux/plugins/`).
3. **Daemon-stopped gate & Slice 1 unauthenticated `start()` (`L2` vs `L1`):** Carried forward unchanged from [draft-plugin-cli.md](draft-plugin-cli.md) (§9 #4 and #5; recommend daemon-stopped refusal and fail-loud `start()`).

### Candidate-Specific Decisions

- **If Candidate 1:** Should `dreamux plugin install` auto-run `configure` in an interactive TTY (recommended, with `--no-configure` opt-out), or keep `install` and `configure` strictly separate?
- **If Candidate 2:** Should `dreamux channel add` stay separate from `dreamux onboard`, or should `dreamux channel` also be able to add a Feishu Dispatcher (updating `CLAUDE.md:69-70` and `.agents/domains/channel.md:54-55`)?
- **If Candidate 3:** Should plugin commands live under `dreamux plugin <name> <cmd>` (recommended — keeps top-level CLI clean and avoids colliding with host commands) or top-level `dreamux <name> <cmd>`?

---

## 6. Verification Limits

- **Local repos verified directly in source (read-only, nothing executed):** `deepseek-harness` (`plugin-manager`, `plugin-market`, `plugin-market-index`, `authorization`, `wecom`), `claude-code` (`main.tsx`, `pluginCliCommands.ts`, `pluginOperations.ts`, `pluginIdentifier.ts`, `schemas.ts`, `PluginOptionsFlow.tsx`), and `codex` (`plugin_cmd.rs`, `marketplace_cmd.rs`, `marketplace.rs`, `store.rs`, `npm_source_tests.rs`).
- **Public docs verified via web search:** OpenClaw CLI (`openclaw plugins` and `openclaw channels login`). Detailed OpenClaw plugin manifest/SDK internals beyond the CLI surface were not fetched and are not claimed.
- **Not verified live:** `npm install` behavior with git/tarball/local-dir specs on Windows (`npm.cmd`), and whether `file:` refs should also apply to bare `agents[].provider` / `channels[].provider` or only `plugins[]` (keeping it uniform in `parseProviderRef` is simpler unless restricted).
