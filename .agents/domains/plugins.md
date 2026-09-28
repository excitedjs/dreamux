# Plugins

What: the plugin mechanism. A plugin is a package whose zero-argument factory
returns a `DreamuxPlugin`; it can register providers, tap lifecycle hooks, and
publish an api to other plugins. Core flow stays hard-coded: objects fire hooks
when they are constructed and hand themselves to the taps, typed as a narrow
public interface.

## Ownership

| Concern                                                                                                                     | Owner                                         |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Plugin contract (`DreamuxPlugin`, `ContributeHost`, `ServerHost`, `Dispatcher`, `Team`, `LaunchDraft`, `DreamuxPluginApis`) | `/packages/dreamux-types/src/plugin.ts`       |
| `plugins[]` parsing, import, factory, same-name checks, `contribute`, `config.read`                                         | `/packages/dreamux/src/plugin/loader.ts`      |
| Top-level hooks, `server`, api publication                                                                                  | `/packages/dreamux/src/plugin/host.ts`        |
| Tap isolation and owner attribution (the `register` interceptors core installs on every hook it creates)                    | `/packages/dreamux/src/plugin/hooks.ts`       |
| Built-in plugin ids and the always-loaded list                                                                              | `/packages/dreamux/src/registry/builtins.ts`  |
| Per-plugin state directory path (`pluginStateDir`)                                                                          | `/packages/dreamux/src/platform/paths.ts`     |
| Doctor rows                                                                                                                 | `/packages/dreamux/src/cli/doctor-plugins.ts` |
| Built-in bootstrap plugin                                                                                                   | `/packages/plugins/bootstrap/src/index.ts`    |

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
   ├─ launch                     each Dispatcher Agent construction
   ├─ teammateLaunch             each ordinary TeamMate's Agent construction
   ├─ createTeam                 each non-replay `team.create` request, before the Team is built
   └─ team                       after a TeamService is constructed (create and rebuild)
      └─ team.hooks
         └─ leaderLaunch         each TeamLeader Agent construction
host.hooks.plugin.for(name)      once, with plugin <name>'s api, at the end of loading
```

| Hook                              | Fires in                                                                                                                                                                  | Fires                                                                                                                                                                                                                                                                                        | Does not fire                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `host.hooks.dispatcher`           | `Dispatchers.get` (`/packages/dreamux/src/service/dispatchers/index.ts`), after the service is cached                                                                     | once per Dispatcher object, including a disabled Dispatcher a Command materializes                                                                                                                                                                                                           | again for the cached object                                                                                                           |
| `dispatcher.hooks.launch`         | `DispatcherAgent.build()` (`/packages/dreamux/src/service/dispatcher-service/agent.ts`)                                                                                   | each Dispatcher input-source start                                                                                                                                                                                                                                                           | a runtime process restart inside the same Agent                                                                                       |
| `dispatcher.hooks.teammateLaunch` | `TeammateCollection.buildEntity` (`/packages/dreamux/src/service/agent/index.ts`), the one construction path behind spawn, `createLocked`, and a closed TeamMate's reopen | each construction of any ordinary TeamMate's Agent — Dispatcher-spawned, a Team member, or a Workflow agent, since a Workflow agent's `createLocked` is the same collection path as an ordinary spawn; `context.teamId` is that TeamMate's owning Team id, `null` for a dispatcher-owned one | the Dispatcher's own Agent or a Team's leader (see `launch` / `leaderLaunch`); a runtime process restart inside the same AgentService |
| `dispatcher.hooks.createTeam`     | `TeamCollection.createFromRequest` (`/packages/dreamux/src/service/team/index.ts`)                                                                                        | once per `team.create` request that is not a replay of an already-accepted one, after the replay check and before the Team's repo/skill-source translation and construction; an `AsyncSeriesWaterfallHook`, so each tap returns the value the next tap (and finally the translation) sees    | `rebuild`; a replayed `request_id` (decided against `payloadHash` alone, before this hook runs)                                       |
| `dispatcher.hooks.team`           | `TeamService` `createNew` and `rebuild` (`/packages/dreamux/src/service/team/service.ts`), through the `announceTeam` dep                                                 | create (before the Team record is written) and rebuild; `ctx.origin` says which                                                                                                                                                                                                              | a replayed `request_id` (never reaches `createNew`)                                                                                   |
| `team.hooks.leaderLaunch`         | `restoreTeamLeaderAgentForTeam` (`/packages/dreamux/src/service/team/leader.ts`)                                                                                          | create, rebuild, lazy TeamLeader materialization, and creation-failure cleanup when it adopts a durable leader to close it                                                                                                                                                                   | a runtime process restart inside the same AgentService                                                                                |

`dispatcher.hooks.createTeam` hands a tap the caller's own wire-shaped
`TeamCreateParams` (`TeamCreateCommand` without `request_id`, since replay
identity is already decided) and expects the same or a changed value back;
`undefined` means unchanged. A tap that changes `leader.skill_sources` or
`repo` gets exactly the fence and translation an admin-supplied value already
gets — `TeamCollection.createFromRequest` re-validates the hook's own
`leader.skill_sources` structurally (a tap need not even be written in
TypeScript) before running it through the same mandatory-root injection
(`TEAM_LEADER_REQUIRED_SKILL_SOURCES`) and repo→worktree mapping
`commands.ts`/`mcp.ts` used to each do for themselves before calling
`createFromRequest`; both callers now build only the wire-shaped
`TeamCreateCommand` and forward it unchanged.

`dispatcher.hooks.teammateLaunch` is one hook object on the Dispatcher, not one
per Team: a Team-scoped construction reaches it through the same
`AsyncSeriesHook` its `TeamCollectionOptions`/`TeamServiceDeps` forward
unchanged from the Dispatcher, naming its own id as the call's context instead
of holding a separate hook instance. Required skill roots for its fence are
exactly `identity.skill_sources` (whatever the TeamMate's identity already
carries) — an ordinary TeamMate has no bundled skill root the way the
Dispatcher (`dispatcher` + `shared`) and a TeamLeader (`team-leader` + `shared`

- identity roots) do.

Semantics that follow from the sites:

- Launch hooks run at Agent construction, not at runtime process restart. A
  file a tap reads takes effect at the next construction: the next Dispatcher
  start for the Dispatcher, the next TeamLeader construction for a Team.
- `dispatcher.hooks.team` fires before the Team record is written. When the
  name is taken, the caller discards that object and retries with another
  name. The contract therefore says a `team` tap only taps the Team's own
  hooks: the discarded object never reaches TeamLeader construction, so its
  taps never fire and no revocation signal is needed.
- `leaderLaunch` has a fourth trigger besides create, rebuild and
  lazy materialization: when Team creation fails after the TeamLeader
  identity was persisted, `closing.abandonCreation` adopts that durable leader
  through `restoreTeamLeaderAgentForTeam` so it can be stopped cleanly. The
  launch hook therefore runs once on a Team that is being closed; a tap that
  counts launches in its own state sees that one.
- No Team close hook exists. There is also no post-creation hook (R48 deleted
  `team.hooks.created`, its background scheduling, and the shutdown drain that
  awaited it): a fact after an action is an event, and the event stream is
  where that belongs if a need for it ever appears, not a hook plugins tap.

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
`builtin:codex`, `builtin:claude-code`, and `builtin:feishu` are loaded always,
before the listed entries, and are not listed; `builtin:bootstrap` is opt-in,
and an installed build currently fails to load it because its package is not
published (R56).

Order, all inside `loadConfig` except the last two steps:

1. Parse `plugins[]` (before any import: a malformed entry has no later
   validation pass that would report it).
2. For the always-loaded refs, then each entry in file order: import the
   package, call the factory, reject a duplicate plugin name naming both
   sources, run `contribute`. A contributed provider is registered as
   `builtin:<name>` through `registerBuiltinProvider`, so config addresses it
   with the same ref grammar; a provider name already taken by another plugin
   fails naming both sources.
3. Load and validate provider refs as before; refs to contributed providers
   resolve from the registry like any built-in. A `builtin:<name>` ref that no
   loaded plugin contributes and Dreamux does not ship fails loading with that
   statement, which is what an operator sees after removing a plugin from
   `plugins[]` while config still addresses its provider.
4. Run each plugin's `config.read` on its entry's `config`. A `config` block
   for a plugin with no `config.read` is ignored: a plugin with no reader has
   nowhere to route the block that would give it effect. This is narrower than
   general unknown-field tolerance — `rejectUnknownKeys` still applies to
   `plugins[]` entry keys and elsewhere in `config.ts`.
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

`ServerHost.stateDir` (R50) is the plugin's own durable state directory,
`pluginStateDir(name)` (`state/plugins/<name>/`), handed to every plugin's
`server` call alongside `config` and `logger`. Core neither creates the
directory nor reads inside it — a plugin that needs one creates it lazily on
its own first write, the same way every other Dreamux store does.
`contribute`/`config.read` do not get it: nothing at that phase does IO.

`constructPlugin` (step 2 above) validates the factory-returned `name` against
a safe single-segment pattern (1-64 ASCII letters/digits/dot/underscore/dash,
starting with a letter or digit) and fails loading with `PluginLoadError`
otherwise, so `pluginStateDir` uses it verbatim, with no separate sanitizing
step: `name` becomes the `state/plugins/<name>` segment directly, so an
unvalidated name could let two distinct plugins collide on one directory (a
lossy sanitizer alone maps both `@acme/tool` and `_acme_tool` to
`_acme_tool`) or resolve to `.`/`..` and escape `state/plugins/`.

## Failure Semantics

- Load phase (import, factory, `contribute`, `config.read`, `server`, and the
  `hooks.plugin.for(name)` taps): a throw is a `PluginLoadError` naming the
  plugin and phase. `serve` fails to start. Doctor reports one failed
  `plugin <name>` row in place of the per-plugin rows and continues. The `for(name)` taps are load phase
  because name collisions a published api enforces (for example Feishu
  extension tool names) are raised inside them and must be hard errors.
- Core runs every hook with tapable's own `hook.call` / `hook.promise`, so
  interceptors plugins add with `hook.intercept` run. Isolation comes from two
  interceptors core installs on a hook before any plugin sees it: a `register`
  interceptor wraps each tap's `fn` as the tap registers, and core wraps
  `hook.intercept` itself so every method of an interceptor a plugin adds
  afterward (`call`/`tap`/`loop`/`result`/`done`/`error`/`register`) is
  guarded the same way a tap is — including `done`/`error`, which tapable
  invokes from a continuation no caller-side try/catch can see. The `for(name)`
  wrapper turns a throw into the load error above, attributed to the tap's or
  interceptor's owner. Interceptor methods must be synchronous: tapable ignores
  their return value (except `register`'s), so an `async` method's rejection is
  logged at runtime and fails loading under `for(name)`, and an `async`
  `register` leaves the tap unchanged even when it resolves to a modified tap.
  No call site (`Dispatchers.get`, the `announceTeam`
  dep, `composeLaunchDraft`, api publication) needs its own catch: every hook
  runs with plain `hook.call` / `hook.promise`. This keeps the "never throws"
  contract on `announceTeam`'s caller true regardless of which mechanism — a
  tap or an interceptor — a plugin used.
- Runtime hooks:
  - `SyncHook` taps (`dispatcher`, `team`): a throw is logged with the owning
    plugin and skipped; lower-level taps it registered before throwing stay.
    A tap's `fn` may be `async` even though the hook is sync (nothing stops a
    plugin passing one to `.tap`); a returned thenable is watched the same
    way a throw is, logged and skipped, never left to reject unhandled.
  - Launch hooks: each tap writes into its own empty sub-draft, merged only
    after the tap resolved and its `skillSources` passed the skill fence. A
    rejection or a fence violation drops that tap's instructions and skill
    sources together and is logged; launch continues. The required roots
    (built-in roots, and a TeamLeader identity's persisted roots) are
    canonicalized once per launch, outside any tap's attribution, the first
    time a tap adds a skill root, and every later `accept` reuses that result
    instead of re-touching the filesystem for them — so a required root that
    turns unreadable partway through a launch is never misattributed to
    whichever plugin's tap happens to run next. If one is unreadable, that is
    logged once naming the root, and plugin skill roots are skipped for this
    launch while plugin instructions still apply. The hook itself is only ever
    handed an opaque `LaunchDraft` object, never the accumulator that holds
    the fenced state: a plugin's own interceptor on a launch hook sees that
    same opaque object and cannot reach the fence or the accumulated draft, so
    it cannot push a skill root that skips the per-tap fence.
  - `createTeam` (`AsyncSeriesWaterfallHook`): a throwing or rejecting tap is
    logged with its owner and the chain keeps the value it already had — the
    failing tap's own change is dropped, never the whole `team.create` call.
    `undefined` from a tap means unchanged, tapable's own waterfall
    convention.

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
- TeamMate: `append = [membership sentence (Team-scoped only), operation
append, ...instructions, identity prompt]` (`teammateSystemPromptOptions`,
  `/packages/dreamux/src/service/agent/system-prompt.ts`) — same relative
  order as the TeamLeader: built-ins first, plugin instructions next, the
  per-entity identity prompt last. Plugin skill sources follow
  `identity.skill_sources`, the only required root an ordinary TeamMate has.

## Built-in Bootstrap Plugin

`@excitedjs/dreamux-plugin-bootstrap` (`builtin:bootstrap`). Per Dispatcher,
it reads `<cwd>/.workspace/identity.md` and `user.md`:

- `launch`: both present → remove `.workspace/bootstrap.md` if present,
  add the rendered profile. Otherwise create `.workspace/` if needed, write the
  guide to `.workspace/bootstrap.md`, add the guide. Only the Dispatcher sees
  the guide.
- `leaderLaunch` (tapped from `dispatcher.hooks.team`): both present
  → add the rendered profile; otherwise nothing.
- `teammateLaunch`: not tapped. An ordinary TeamMate gets neither the guide
  nor the rendered profile.

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
