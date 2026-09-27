import type {
  AsyncSeriesHook,
  AsyncSeriesWaterfallHook,
  SyncHook,
  TypedHookMap,
} from 'tapable';

import type {
  AgentRuntimeProvider,
  AgentRuntimeSkillSource,
} from './agent-runtime.js';
import type { ChannelProvider } from './channel.js';
import type { DreamuxLogger } from './logger.js';
import type { TeamCreateParams } from './team.js';

/**
 * A Dreamux plugin: the object a plugin package's zero-argument factory
 * (its `default` export, or the `npm:<pkg>#<export>` export) returns.
 *
 * `contribute` and `server` only register and tap. They must not do IO, start
 * timers, or hold resources: `dreamux doctor` runs both while a daemon may be
 * live, and no Dispatcher or channel exists yet to own a resource. Resources
 * belong to object lifecycles (a channel's initialize/start/close, or a hook
 * callback). Both must be synchronous — declared `void`, and enforced at load
 * time by rejecting a returned thenable — since nothing awaits them: an
 * `async` implementation would silently lose any tap it registers after its
 * first `await`.
 */
export interface DreamuxPlugin {
  /** Unique across all loaded plugins; a duplicate fails loading. */
  readonly name: string;
  /**
   * Published to other plugins after every plugin's `server` ran, through
   * `ServerHost.hooks.plugin.for(name)`. Declare its type by augmenting
   * {@link DreamuxPluginApis}.
   */
  readonly api?: unknown;
  /** Validate this plugin's `plugins[]` config block. A throw fails loading. */
  readonly config?: { read(raw: unknown): unknown };
  contribute?(host: ContributeHost): void;
  server?(host: ServerHost): void;
}

export interface ContributeHost {
  readonly logger: DreamuxLogger;
  /** Registers a channel provider addressed in config as `builtin:<name>`. */
  readonly channelProviders: {
    contribute<TConfig>(name: string, provider: ChannelProvider<TConfig>): void;
  };
  /** Registers an Agent Runtime provider addressed in config as `builtin:<name>`. */
  readonly agentRuntimeProviders: {
    contribute<TConfig>(
      name: string,
      provider: AgentRuntimeProvider<TConfig>,
    ): void;
  };
}

/**
 * Plugin name -> the type of that plugin's `api`. A plugin package that
 * publishes an api augments this interface:
 *
 * ```ts
 * declare module '@excitedjs/dreamux-types' {
 *   interface DreamuxPluginApis { example: ExampleApi }
 * }
 * ```
 */
export interface DreamuxPluginApis {}

export interface ServerHost {
  /** The value this plugin's `config.read` returned; `undefined` without one. */
  readonly config: unknown;
  /** Bound with `plugin: <name>`. */
  readonly logger: DreamuxLogger;
  /**
   * This plugin's own durable state directory, scoped by the plugin's name
   * and no other identity. Core neither creates it nor reads inside it — the
   * plugin owns its own `mkdir`/read/write, the same way every other Dreamux
   * store creates its directory lazily on first write.
   */
  readonly stateDir: string;
  /**
   * Core runs these hooks, and every hook below them, with tapable's own
   * `call` / `promise`, so interceptors added with `hook.intercept` run. Core
   * installs a `register` interceptor first, which wraps each tap: a failing
   * tap is logged with its owning plugin and the other taps still run. Core
   * also wraps `hook.intercept` itself, so every method of a plugin's own
   * interceptor (`call`/`tap`/`loop`/`result`/`done`/`error`/`register`) is
   * guarded the same way — including `done`/`error`, which tapable invokes
   * from a continuation no caller-side try/catch can see, so an unguarded
   * throw there would otherwise hang the hook's own `promise()` forever
   * instead of failing it. A guarded interceptor's throw is attributed to the
   * plugin that added it and follows the same rule as the hook it is on:
   * logged and skipped at runtime, a failed load naming that plugin at load
   * time (`hooks.plugin.for(name)`).
   *
   * Tap names are free-form. The owning plugin of a tap is the plugin whose
   * `server` registered it, or the plugin whose tap callback was running when
   * it registered (including after an `await` inside that callback). Failure
   * logs and doctor name taps by that owner.
   */
  readonly hooks: Readonly<{
    /**
     * Called once per Dispatcher object, right after core constructs it. A tap
     * that throws is only stopped: taps it already added to the Dispatcher's
     * hooks stay.
     */
    dispatcher: SyncHook<[Dispatcher]>;
    /**
     * `for(name)` is called once with that plugin's `api`, after every
     * plugin's `server` ran. Never called for a plugin that is not loaded.
     */
    plugin: TypedHookMap<{
      [K in keyof DreamuxPluginApis]: SyncHook<[DreamuxPluginApis[K]]>;
    }>;
  }>;
}

/** The public face of a Dispatcher, as plugin hooks receive it. */
export interface Dispatcher {
  readonly id: string;
  /** The configured Dispatcher cwd, absolute. */
  readonly cwd: string;
  /**
   * A failing tap does not stop the others. Each `launch` or `teammateLaunch`
   * tap receives its own empty draft, merged into the launch only when the
   * tap succeeds. A `team` tap that throws is only stopped: taps it already
   * added to the Team's hooks stay.
   */
  readonly hooks: Readonly<{
    /** Runs each time this Dispatcher's Agent is constructed (each Dispatcher start). */
    launch: AsyncSeriesHook<[LaunchDraft]>;
    /**
     * Runs each time any ordinary TeamMate's Agent is constructed —
     * Dispatcher-spawned, a Team member, or a Workflow agent — never for the
     * Dispatcher's own Agent or a Team's leader (see `launch` / `leaderLaunch`).
     * `teamId` is `null` for a dispatcher-owned TeamMate, the owning Team's id
     * otherwise.
     */
    teammateLaunch: AsyncSeriesHook<
      [LaunchDraft, Readonly<{ teamId: string | null }>]
    >;
    /**
     * Runs once per `team.create` request that is not a replay of an already
     * accepted one, before the Team is constructed. Each tap receives the
     * previous tap's returned value (the caller's own params for the first
     * tap) and returns the value the next tap sees; the final value is what
     * the Team is built from. `request_id` is not part of this value — replay
     * identity is decided before this hook ever runs.
     */
    createTeam: AsyncSeriesWaterfallHook<[TeamCreateParams]>;
    /**
     * Runs right after a Team object is constructed: on creation (before the
     * Team record is written, so the object may be discarded when the name is
     * taken) and on rebuild. Taps here should only tap the Team's own hooks.
     */
    team: SyncHook<[Team, { readonly origin: 'create' | 'rebuild' }]>;
  }>;
}

/** The public face of a Team, as plugin hooks receive it. */
export interface Team {
  readonly id: string;
  readonly name: string;
  /** The Team's runtime cwd. */
  readonly workspace: string;
  /**
   * A failing tap does not stop the others. Each `leaderLaunch` tap
   * receives its own empty draft, merged into the launch only when the tap
   * succeeds.
   */
  readonly hooks: Readonly<{
    /**
     * Runs each time this Team's TeamLeader Agent is constructed, including
     * when a failed creation adopts the already-persisted leader to close it.
     */
    leaderLaunch: AsyncSeriesHook<[LaunchDraft]>;
  }>;
}

/**
 * What a launch hook may add. It starts empty: built-in prompts and skill
 * roots are not in it and cannot be changed. Core appends `instructions` after
 * the built-in prompt and `skillSources` after the built-in roots, fenced
 * against them.
 *
 * This is also the only shape a launch hook itself ever carries: a tap gets
 * its own private one, merged in only after it resolves and passes the skill
 * fence, and a plugin's own `hook.intercept` callback on the hook sees a
 * disconnected one — the accumulator that applies the fence is never handed
 * to a hook, so an interceptor cannot add a skill root that skips it.
 */
export interface LaunchDraft {
  readonly instructions: string[];
  readonly skillSources: AgentRuntimeSkillSource[];
}
