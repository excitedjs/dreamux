import type { AsyncSeriesHook, SyncHook, TypedHookMap } from 'tapable';

import type {
  AgentRuntimeProvider,
  AgentRuntimeSkillSource,
} from './agent-runtime.js';
import type { ChannelProvider } from './channel.js';
import type { DreamuxLogger } from './logger.js';

/**
 * A Dreamux plugin: the object a plugin package's zero-argument factory
 * (its `default` export, or the `npm:<pkg>#<export>` export) returns.
 *
 * `contribute` and `server` only register and tap. They must not do IO, start
 * timers, or hold resources: `dreamux doctor` runs both while a daemon may be
 * live, and no Dispatcher or channel exists yet to own a resource. Resources
 * belong to object lifecycles (a channel's initialize/start/close, or a hook
 * callback).
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
   * Core runs each tap on these hooks on its own, in tap order, so one failing
   * tap cannot stop the others. Call and tap interceptors (`hook.intercept`)
   * are not run.
   *
   * Name every tap, on these hooks and on every hook below them, after the
   * plugin (`tap('<plugin name>', ...)`): core attributes failures and doctor
   * lists taps by tap name. A tap on these two hooks under any other name
   * fails loading.
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
  /**
   * The configured Dispatcher cwd, absolute; `null` when the config declares
   * none. A Dispatcher without a cwd never launches, so its launch hooks never
   * run.
   */
  readonly cwd: string | null;
  /**
   * Core runs each tap on its own and the rest still run after one fails.
   * A failing `beforeLaunch` tap's draft additions are dropped. A `team` tap
   * that throws is only stopped: taps it already added to the Team's hooks
   * stay. Call and tap interceptors (`hook.intercept`) are not run.
   */
  readonly hooks: Readonly<{
    /** Runs each time this Dispatcher's Agent is constructed (each Dispatcher start). */
    beforeLaunch: AsyncSeriesHook<[LaunchDraft]>;
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
   * Core runs each tap on its own and the rest still run after one fails.
   * A failing `beforeTeamLeaderLaunch` tap's draft additions are dropped; a
   * failing `created` tap is logged. Call and tap interceptors
   * (`hook.intercept`) are not run.
   */
  readonly hooks: Readonly<{
    /** Runs each time this Team's TeamLeader Agent is constructed. */
    beforeTeamLeaderLaunch: AsyncSeriesHook<[LaunchDraft]>;
    /**
     * Runs once after a newly created Team reached `running` and became
     * reachable through Commands. Not on rebuild, failed creation, or a
     * replayed request.
     */
    created: AsyncSeriesHook<[{ readonly requestId: string | null }]>;
  }>;
}

/**
 * What a launch hook may add. It starts empty: built-in prompts and skill
 * roots are not in it and cannot be changed. Core appends `instructions` after
 * the built-in prompt and `skillSources` after the built-in roots, fenced
 * against them.
 */
export interface LaunchDraft {
  readonly instructions: string[];
  readonly skillSources: AgentRuntimeSkillSource[];
}
