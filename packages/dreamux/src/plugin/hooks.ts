/**
 * Failure isolation and owner attribution for every hook core hands to
 * plugins.
 *
 * Core creates each such hook through one of the `*Taps` functions below,
 * which install a tapable `register` interceptor before any plugin sees the
 * hook. The interceptor wraps each tap's `fn` as it registers, so core then
 * runs the hook with plain `hook.call` / `hook.promise`, and interceptors that
 * plugins add with `hook.intercept` run as tapable defines them.
 *
 * The owner of a tap is the plugin in whose context it registered: the plugin
 * whose `server` is running, or the plugin whose wrapped tap is executing. It
 * travels in an `AsyncLocalStorage`, so a tap registered inside another tap,
 * including after an `await`, gets the right owner. A tap registered outside
 * any plugin context (for example from a channel extension's event handler)
 * has no owner and is reported by its tap name.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  AgentRuntimeSkillSource,
  DreamuxLogger,
  LaunchDraft,
} from '@excitedjs/dreamux-types';
import type { AsyncSeriesHook, SyncHook } from 'tapable';

import { normalizeAgentRuntimeSkillSources } from '../agent-runtime/skill-sources.js';
import { errorInfo, errorMessage } from '../platform/error-info.js';
import { PluginLoadError } from './loader.js';

type TapFn = (...args: unknown[]) => unknown;

interface RegisteredTap {
  readonly name: string;
  readonly type: 'sync' | 'async' | 'promise';
  readonly fn: TapFn;
}

/** The part of a tapable hook this module touches. */
type InterceptableHook = Pick<SyncHook<unknown[]>, 'name' | 'intercept'>;

const owners = new AsyncLocalStorage<string>();
const ownersByHook = new WeakMap<object, (string | null)[]>();

/** Run `fn` (a plugin's `server`) with `plugin` as the owner of every tap it adds. */
export function runAsPlugin<T>(plugin: string, fn: () => T): T {
  return owners.run(plugin, fn);
}

/** The owner of each tap registered on `hook`, in registration order, for doctor. */
export function tapOwners(hook: object): readonly (string | null)[] {
  return ownersByHook.get(hook) ?? [];
}

function asOwner<T>(owner: string | null, fn: () => T): T {
  return owner === null ? fn() : owners.run(owner, fn);
}

/** Run one tap of any type to completion as a promise. */
function invoke(tap: RegisteredTap, args: readonly unknown[]): Promise<unknown> {
  if (tap.type !== 'async') return Promise.resolve().then(() => tap.fn(...args));
  return new Promise<void>((resolve, reject) => {
    tap.fn(...args, (err?: unknown) => {
      if (err !== undefined && err !== null && err !== false) reject(err);
      else resolve();
    });
  });
}

function install(
  hook: InterceptableHook,
  wrap: (tap: RegisteredTap, owner: string | null) => RegisteredTap,
): void {
  const registered: (string | null)[] = [];
  ownersByHook.set(hook, registered);
  hook.intercept({
    register: (tap) => {
      const owner = owners.getStore() ?? null;
      registered.push(owner);
      return wrap(tap as unknown as RegisteredTap, owner) as unknown as typeof tap;
    },
  });
}

function reportSkipped(
  log: DreamuxLogger,
  hook: InterceptableHook,
  tap: RegisteredTap,
  owner: string | null,
  err: unknown,
): void {
  log.error(
    { plugin: owner, tap: tap.name, hook: hook.name, err: errorInfo(err) },
    'plugin hook callback failed; its changes were skipped',
  );
}

/**
 * Runtime hooks (`dispatcher`, `team`, `created`): a throwing or rejecting tap
 * is logged with its owner and the remaining taps still run. Async taps become
 * promise taps so a failure never reaches the hook's own callback.
 */
export function isolatedTaps<H extends InterceptableHook>(hook: H, log: DreamuxLogger): H {
  install(hook, (tap, owner) => {
    if (tap.type === 'sync') {
      return {
        ...tap,
        fn: (...args) => {
          try {
            asOwner(owner, () => tap.fn(...args));
          } catch (err) {
            reportSkipped(log, hook, tap, owner, err);
          }
        },
      };
    }
    return {
      ...tap,
      type: 'promise',
      fn: async (...args) => {
        try {
          await asOwner(owner, () => invoke(tap, args));
        } catch (err) {
          reportSkipped(log, hook, tap, owner, err);
        }
      },
    };
  });
  return hook;
}

/**
 * `hooks.plugin.for(apiOwner)`: called while plugins load, so a throw fails
 * loading and is attributed to the tap's owner.
 */
export function loadPhaseTaps<H extends InterceptableHook>(hook: H, apiOwner: string): H {
  install(hook, (tap, owner) => ({
    ...tap,
    fn: (...args) => {
      try {
        return asOwner(owner, () => tap.fn(...args));
      } catch (err) {
        throw new PluginLoadError(
          owner ?? tap.name,
          'api',
          `while receiving plugin "${apiOwner}" api: ${errorMessage(err)}`,
          { cause: err },
        );
      }
    },
  }));
  return hook;
}

/**
 * The value core passes to a launch hook. Each wrapped tap writes into its own
 * empty sub-draft, and `accept` merges that sub-draft only after the tap
 * resolved and its skill roots passed the skill fence, so a failing tap
 * contributes nothing and a half-pushed draft never reaches a runtime.
 */
class LaunchComposition implements LaunchDraft {
  readonly instructions: string[] = [];
  readonly skillSources: AgentRuntimeSkillSource[] = [];
  private requiredRoots: Promise<boolean> | undefined;

  constructor(private readonly requiredSkillSources: readonly AgentRuntimeSkillSource[]) {}

  /**
   * Whether every required root (the built-in roots and a TeamLeader
   * identity's persisted roots) is readable, checked once per launch and
   * outside any tap's attribution. The fence canonicalizes the required roots
   * before a plugin's roots, so a required root deleted after it was persisted
   * would otherwise fail inside the fence and be blamed on whichever plugin
   * happened to add a root. When one is unreadable, plugin skill roots are
   * skipped for this launch; plugin instructions still apply.
   */
  requiredRootsReadable(log: DreamuxLogger): Promise<boolean> {
    this.requiredRoots ??= (async () => {
      for (const source of this.requiredSkillSources) {
        try {
          await normalizeAgentRuntimeSkillSources([], {
            label: 'launch skill roots',
            requiredSources: [source],
          });
        } catch (err) {
          log.error(
            { skillSource: source.name, path: source.path, err: errorInfo(err) },
            'a required skill root is unreadable; plugin skill roots are skipped for this launch',
          );
          return false;
        }
      }
      return true;
    })();
    return this.requiredRoots;
  }

  async accept(sub: LaunchDraft, label: string): Promise<void> {
    // The fence costs filesystem IO; a tap that adds no roots skips it.
    if (sub.skillSources.length > 0) {
      const fenced = await normalizeAgentRuntimeSkillSources(
        [...this.skillSources, ...sub.skillSources],
        {
          label: `plugin "${label}" skillSources`,
          requiredSources: this.requiredSkillSources,
        },
      );
      this.skillSources.splice(0, this.skillSources.length, ...fenced);
    }
    this.instructions.push(...sub.instructions);
  }
}

/** Launch hooks (`beforeLaunch`, `beforeTeamLeaderLaunch`). */
export function launchDraftTaps(
  hook: AsyncSeriesHook<[LaunchDraft]>,
  log: DreamuxLogger,
): AsyncSeriesHook<[LaunchDraft]> {
  install(hook, (tap, owner) => ({
    ...tap,
    type: 'promise',
    fn: async (draft) => {
      const composition = draft as LaunchComposition;
      const sub: LaunchDraft = { instructions: [], skillSources: [] };
      try {
        await asOwner(owner, () => invoke(tap, [sub]));
      } catch (err) {
        reportSkipped(log, hook, tap, owner, err);
        return;
      }
      const accepted =
        sub.skillSources.length > 0 && !(await composition.requiredRootsReadable(log))
          ? { instructions: sub.instructions, skillSources: [] }
          : sub;
      try {
        await composition.accept(accepted, owner ?? tap.name);
      } catch (err) {
        reportSkipped(log, hook, tap, owner, err);
      }
    },
  }));
  return hook;
}

/**
 * Run a launch hook created by {@link launchDraftTaps}. Plugin skill roots are
 * fenced against `requiredSkillSources`.
 */
export async function composeLaunchDraft(
  hook: AsyncSeriesHook<[LaunchDraft]>,
  requiredSkillSources: readonly AgentRuntimeSkillSource[],
): Promise<LaunchDraft> {
  const draft = new LaunchComposition(requiredSkillSources);
  await hook.promise(draft);
  return draft;
}
