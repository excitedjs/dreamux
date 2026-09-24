# Plugins

What: the plugin mechanism. A plugin is a package whose zero-argument factory
returns a `DreamuxPlugin`; it can register providers, tap lifecycle hooks, and
publish an api to other plugins. Core flow stays hard-coded: objects fire hooks
when they are constructed and hand themselves to the taps, typed as a narrow
public interface.

## Ownership

| Concern | Owner |
|---|---|
| Plugin contract (`DreamuxPlugin`, `ContributeHost`, `ServerHost`, `Dispatcher`, `Team`, `LaunchDraft`, `DreamuxPluginApis`) | `/packages/dreamux-types/src/plugin.ts` |
| `plugins[]` parsing, import, factory, same-name checks, `contribute`, `config.read` | `/packages/dreamux/src/plugin/loader.ts` |
| Top-level hooks, `server`, api publication | `/packages/dreamux/src/plugin/host.ts` |
| Tap isolation and owner attribution (the `register` interceptors core installs on every hook it creates) | `/packages/dreamux/src/plugin/hooks.ts` |
| Built-in plugin ids and the always-loaded list | `/packages/dreamux/src/registry/builtins.ts` |
| Doctor rows | `/packages/dreamux/src/cli/doctor-plugins.ts` |
| Built-in bootstrap plugin | `/packages/plugins/bootstrap/src/index.ts` |

A plugin compiles against `@excitedjs/dreamux-types` only and never imports
`@excitedjs/dreamux` (the provider import boundary applies to plugin packages
too). The contract names tapable's `SyncHook`, `AsyncSeriesHook` and
`TypedHookMap` directly, so `@excitedjs/dreamux-types` carries `tapable` as its
one dependency, used by type only; a second Dreamux-authored definition of the
same hook classes would be a copy that can drift. `TypedHookMap` exists only in
tapable 2.3's declarations, so the `~2.3.3` range is a floor.

## Hook Tree

```text
host.hooks.dispatcher            after a DispatcherService is constructed
└─ dispatcher.hooks
   ├─ beforeLaunch               each Dispatcher Agent construction
   └─ team                       after a TeamService is constructed (create and rebuild)
      └─ team.hooks
         ├─ beforeTeamLeaderLaunch   each TeamLeader Agent construction
         └─ created                  once, after a new Team is running and reachable
host.hooks.plugin.for(name)      once, with plugin <name>'s api, at the end of loading
```

| Hook | Fires in | Fires | Does not fire |
|---|---|---|---|
| `host.hooks.dispatcher` | `Dispatchers.get` (`/packages/dreamux/src/service/dispatchers/index.ts`), after the service is cached | once per Dispatcher object, including a disabled Dispatcher a Command materializes | again for the cached object |
| `dispatcher.hooks.beforeLaunch` | `createDispatcherAgent` (`/packages/dreamux/src/service/dispatcher-service/agent.ts`) | each Dispatcher input-source start | a runtime process restart inside the same Agent |
| `dispatcher.hooks.team` | `TeamService` `createNew` and `rebuild` (`/packages/dreamux/src/service/team-service/index.ts`), through the `announceTeam` dep | create (before the Team record is written) and rebuild; `ctx.origin` says which | a replayed `request_id` (never reaches `createNew`) |
| `team.hooks.beforeTeamLeaderLaunch` | `restoreTeamLeaderAgentForTeam` (`/packages/dreamux/src/service/team-service/leader-agent.ts`) | create, rebuild, lazy TeamLeader materialization, and creation-failure cleanup when it adopts a durable leader to close it | a runtime process restart inside the same TeammateService |
| `team.hooks.created` | `TeamRuntimeRegistry.createTeam` (`/packages/dreamux/src/service/team-collection/runtime-registry.ts`), after `publish`, as a background task | once per newly created Team, with the create request id or `null` | rebuild, failed creation, a name-taken discard, a replayed request |

Semantics that follow from the sites:

- Launch hooks run at Agent construction, not at runtime process restart. A
  file a tap reads takes effect at the next construction: the next Dispatcher
  start for the Dispatcher, the next TeamLeader construction for a Team.
- `dispatcher.hooks.team` fires before the Team record is written. When the
  name is taken, the caller discards that object and retries with another
  name. The contract therefore says a `team` tap only taps the Team's own
  hooks: the discarded object never reaches TeamLeader construction or
  `created`, so its taps never fire and no revocation signal is needed.
- `created` fires after `publish`, not at the `running` record write inside
  `createNew`. Before `publish` the Team is still only in the registry's
  in-flight construction map, so a `created` tap that reached this Team through
  a Command (`team.submit`) would join the construction that is waiting on the
  tap. After `publish` the registry's `get` answers from its cache first.
- `created` does not hold up the create reply: the registry starts it without
  awaiting and tracks it. Dispatcher stop waits for runs in flight before it
  closes channels (a `created` tap may bind a chat to the Team), and again
  after the admitted-work drain, which ends every create that could still
  start one.
- `beforeTeamLeaderLaunch` has a fourth trigger besides create, rebuild and
  lazy materialization: when Team creation fails after the TeamLeader
  identity was persisted, `closing.abandonCreation` adopts that durable leader
  through `restoreTeamLeaderAgentForTeam` so it can be stopped cleanly. The
  launch hook therefore runs once on a Team that is being closed; a tap that
  counts launches in its own state sees that one.
- No TeamMate launch hook and no Team close hook exist.

`Dispatcher.cwd` is a `string`: config parsing requires a non-empty
`dispatchers[].cwd` on every entry, enabled or not, so a disabled Dispatcher a
Command materializes carries one too.

The objects handed to taps are the real `DispatcherService` and `TeamService`;
plugins see only the `Dispatcher` / `Team` interfaces, and no mapping object
sits in between. The hook tables are frozen at construction. The services'
other public members stay public because core callers use them; the interface,
not TS visibility, is what bounds a plugin. That bound is static typing only: a
plugin that casts the object reaches every public member. The plugin contract promises no
compatibility and has no deprecation cycle: when it changes, the built-in
plugins change with it.

## Loading

`plugins[]` is an optional top-level config array; each entry is a ref string
or `{ ref, config }`, with `builtin:<id>` or `npm:<package>[#export]` refs.
`builtin:feishu` is loaded always, before the listed entries, and is not
listed; `builtin:bootstrap` is opt-in.

Order, all inside `loadConfig` except the last two steps:

1. Parse `plugins[]` (before any import: a malformed entry has no later
   validation pass that would report it).
2. For the always-loaded refs, then each entry in file order: import the
   package, call the factory, reject a duplicate plugin name naming both
   sources, run `contribute`. A contributed provider is registered as
   `builtin:<name>` through `registerBuiltinProvider`, so config addresses it
   with the same ref grammar; a provider name already taken by core or another
   plugin fails naming both sources.
3. Load and validate provider refs as before; refs to contributed providers
   resolve from the registry like any built-in. A `builtin:<name>` ref that no
   loaded plugin contributes and Dreamux does not ship fails loading with that
   statement, which is what an operator sees after removing a plugin from
   `plugins[]` while config still addresses its provider.
4. Run each plugin's `config.read` on its entry's `config`. A `config` block for
   a plugin with no `config.read` is a `PluginLoadError` (phase `config`), so
   `dreamux serve` fails to start: the config loader rejects unknown input
   everywhere else, and dropping the block would leave the operator believing
   a setting is in force.
5. `startPlugins` (serve and doctor only): run every `server`.
6. For each plugin with an `api`, call the taps on `hooks.plugin.for(name)`.
   This runs last because tapable hooks do not replay: a plugin loaded later
   must still get to tap an earlier plugin's api. A plugin that is not loaded
   never fires its `for(name)`, so an optional dependency needs no check.

Tap names are free-form. Every hook core creates gets a `register`
interceptor at construction that records the tap's owner: the plugin whose
`server` is running, or the plugin whose wrapped tap is executing. The owner
travels in an `AsyncLocalStorage`, so a tap registered inside another tap,
including after an `await`, gets the right owner. Failure logs, load errors
and doctor rows attribute taps by owner. A tap registered outside any plugin
context (for example from a Feishu extension's event handler) has no owner
and is reported by its tap name.

`contribute` and `server` only register and tap; they do no IO. `dreamux
doctor` runs both while a daemon may be live, and at load time no Dispatcher or
channel exists to own a resource. Resources belong to object lifecycles: a
channel's initialize / start / close, or a hook callback, which may read and
write files.

`ContributeHost.logger` is a stderr logger created inside `loadConfig` (serve's
file logger does not exist yet); `ServerHost.logger` is serve's logger bound
with `plugin: <name>`.

## Failure Semantics

- Load phase (import, factory, `contribute`, `config.read`, `server`, and the
  `hooks.plugin.for(name)` taps): a throw is a `PluginLoadError` naming the
  plugin and phase. `serve` fails to start. Doctor reports one failed
  `plugin <name>` row in place of the per-plugin rows and continues. The `for(name)` taps are load phase
  because name collisions a published api enforces (for example Feishu
  extension tool names) are raised inside them and must be hard errors.
- Core runs every hook with tapable's own `hook.call` / `hook.promise`, so
  interceptors plugins add with `hook.intercept` run. Isolation comes from the
  `register` interceptor core installs first: it wraps each tap's `fn` as the
  tap registers. The `for(name)` wrapper turns a throw into the load error
  above, attributed to the tap's owner.
- Runtime hooks:
  - `SyncHook` taps (`dispatcher`, `team`): a throw is logged with the owning
    plugin and skipped; lower-level taps it registered before throwing stay.
  - Launch hooks: each tap writes into its own empty sub-draft, merged only
    after the tap resolved and its `skillSources` passed the skill fence. A
    rejection or a fence violation drops that tap's instructions and skill
    sources together and is logged; launch continues. The required roots
    (built-in roots, and a TeamLeader identity's persisted roots) are checked
    once per launch outside any tap's attribution, the first time a tap adds a
    skill root. If one is unreadable, that is logged once naming the root, and
    plugin skill roots are skipped for this launch while plugin instructions
    still apply; no plugin is blamed for a root it does not own.
  - `created`: a rejection is logged with the owning plugin and skipped,
    never propagated.

## Launch Draft Composition

A `LaunchDraft` starts empty: built-in prompts and skill roots are not in it,
so a plugin can only append, by structure rather than by validation.

- Dispatcher: `systemPrompt.replace = [base, ...instructions].join('\n\n')` and
  `systemPrompt.append = [append, ...instructions]`. Both forms carry the
  plugin text because Codex reads only `replace` and Claude Code only
  `append` (see [provider runtime](provider-runtime.md#system-prompt)). Plugin
  skill sources follow the bundled `dispatcher` and `shared` roots.
- TeamLeader: `append = [role, MCP map, workspace sentence, ...instructions,
  identity prompt]`; the per-Team identity prompt stays last as the most
  specific statement of who the leader is. Plugin skill sources follow the
  required and identity roots.

## Built-in Bootstrap Plugin

`@excitedjs/dreamux-plugin-bootstrap` (`builtin:bootstrap`). Per Dispatcher,
it reads `<cwd>/.workspace/identity.md` and `user.md`:

- `beforeLaunch`: both present → remove `.workspace/bootstrap.md` if present,
  add the rendered profile. Otherwise create `.workspace/` if needed, write the
  guide to `.workspace/bootstrap.md`, add the guide. Only the Dispatcher sees
  the guide.
- `beforeTeamLeaderLaunch` (tapped from `dispatcher.hooks.team`): both present
  → add the rendered profile; otherwise nothing.

A missing file is the normal branch; any other IO error propagates and core
skips that tap. `.workspace/` gets its self-ignoring `.gitignore` only when core
first creates a managed worktree, so before that the profile files can appear
as untracked in a git-backed Dispatcher cwd.

## Feishu As A Plugin

The Feishu channel is the always-loaded built-in plugin `feishu`: it
contributes the `feishu` channel provider (so `builtin:feishu` resolves as
before) and publishes an api whose `extensions.register` lets another plugin
add tools, card actions, and a per-instance lifecycle to every Feishu channel.
The extension surface is owned by [channel](channel.md#feishu-extensions).

History: [/.agents/tasks/architecture/README.md](/.agents/tasks/architecture/README.md)
