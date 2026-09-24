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

import {
  canonicalizeRequiredSkillSources,
  normalizeAgentRuntimeSkillSources,
  type CanonicalSkillRoot,
} from '../agent-runtime/skill-sources.js';
import { errorInfo, errorMessage } from '../platform/error-info.js';
import { isThenable, PluginLoadError } from './loader.js';

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
          let result: unknown;
          try {
            result = asOwner(owner, () => tap.fn(...args));
          } catch (err) {
            reportSkipped(log, hook, tap, owner, err);
            return;
          }
          // `dispatcher` and `team` are SyncHooks: a plugin can only `.tap`,
          // but nothing stops that tap's function from being `async`. Its
          // returned promise is not part of the hook's own return value, so
          // an unwatched rejection would otherwise crash the process.
          if (isThenable(result)) {
            Promise.resolve(result).catch((err: unknown) =>
              reportSkipped(log, hook, tap, owner, err),
            );
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
      let result: unknown;
      try {
        result = asOwner(owner, () => tap.fn(...args));
      } catch (err) {
        throw new PluginLoadError(
          owner ?? tap.name,
          'api',
          `while receiving plugin "${apiOwner}" api: ${errorMessage(err)}`,
          { cause: err },
        );
      }
      // `hooks.plugin.for(name)` is a SyncHook: a plugin can only `.tap`, but
      // nothing stops that tap's function from being `async`. Its returned
      // promise would otherwise go unwatched past this load-phase call, so a
      // later rejection would crash the process with no handler; attach one
      // before throwing the load error that already fails the tap by name.
      if (isThenable(result)) {
        Promise.resolve(result).catch(() => {});
        throw new PluginLoadError(
          owner ?? tap.name,
          'api',
          `while receiving plugin "${apiOwner}" api: tap "${tap.name}" must be synchronous`,
        );
      }
      return result;
    },
  }));
  return hook;
}

/**
 * The composition a launch hook builds. Never handed to a hook itself (see
 * {@link composeLaunchDraft}): each wrapped tap writes into its own empty
 * sub-draft, and `accept` merges that sub-draft only after the tap resolved
 * and its skill roots passed the skill fence, so a failing tap contributes
 * nothing and a half-pushed draft never reaches a runtime.
 */
class LaunchComposition implements LaunchDraft {
  readonly instructions: string[] = [];
  readonly skillSources: AgentRuntimeSkillSource[] = [];
  private requiredRoots: Promise<readonly CanonicalSkillRoot[] | null> | undefined;

  constructor(private readonly requiredSkillSources: readonly AgentRuntimeSkillSource[]) {}

  /**
   * Canonicalize every required root (the built-in roots and a TeamLeader
   * identity's persisted roots) once per launch, outside any tap's
   * attribution, and reuse the result for every `accept` call: a required
   * root that turns unreadable between two taps of the same launch must not
   * surface as a later tap's own fence failure. `null` means one is
   * unreadable; `accept` never re-touches the filesystem for required roots.
   */
  private canonicalRequiredRoots(
    log: DreamuxLogger,
  ): Promise<readonly CanonicalSkillRoot[] | null> {
    this.requiredRoots ??= (async () => {
      const canonical: CanonicalSkillRoot[] = [];
      // One source at a time, so an unreadable root's own log names it —
      // canonicalizeRequiredSkillSources itself only reports a RuleViolation
      // message, not which of several sources it came from.
      for (const source of this.requiredSkillSources) {
        try {
          const [root] = await canonicalizeRequiredSkillSources(
            [source],
            'launch skill roots',
          );
          canonical.push(root!);
        } catch (err) {
          log.error(
            { skillSource: source.name, path: source.path, err: errorInfo(err) },
            'a required skill root is unreadable; plugin skill roots are skipped for this launch',
          );
          return null;
        }
      }
      return canonical;
    })();
    return this.requiredRoots;
  }

  async requiredRootsReadable(log: DreamuxLogger): Promise<boolean> {
    return (await this.canonicalRequiredRoots(log)) !== null;
  }

  async accept(sub: LaunchDraft, label: string, log: DreamuxLogger): Promise<void> {
    // The fence costs filesystem IO; a tap that adds no roots skips it.
    if (sub.skillSources.length > 0) {
      // launchDraftTaps only reaches this branch after requiredRootsReadable
      // already resolved true for this launch (same memoized promise), so
      // the roots are canonicalized by now.
      const requiredRoots = (await this.canonicalRequiredRoots(log))!;
      const fenced = await normalizeAgentRuntimeSkillSources(
        [...this.skillSources, ...sub.skillSources],
        {
          label: `plugin "${label}" skillSources`,
          requiredRoots,
        },
      );
      this.skillSources.splice(0, this.skillSources.length, ...fenced);
    }
    this.instructions.push(...sub.instructions);
  }
}

/**
 * The real {@link LaunchComposition} behind each opaque handle
 * {@link composeLaunchDraft} passes to the hook. A plugin's own
 * `hook.intercept` callbacks receive that same handle, never the
 * composition: it carries none of the fence or attribution machinery, so an
 * interceptor cannot push a skill root past the fence the way a tap's
 * sub-draft is checked. Any `instructions` / `skillSources` an interceptor
 * writes onto the handle itself are never read back — only a tap's own
 * sub-draft, merged through `accept`, reaches the launch.
 */
const compositionsByHandle = new WeakMap<object, LaunchComposition>();

/** The logger each launch hook was built with, for {@link composeLaunchDraft}. */
const logsByLaunchHook = new WeakMap<object, DreamuxLogger>();

/** Launch hooks (`beforeLaunch`, `beforeTeamLeaderLaunch`). */
export function launchDraftTaps(
  hook: AsyncSeriesHook<[LaunchDraft]>,
  log: DreamuxLogger,
): AsyncSeriesHook<[LaunchDraft]> {
  logsByLaunchHook.set(hook, log);
  install(hook, (tap, owner) => ({
    ...tap,
    type: 'promise',
    fn: async (handle) => {
      // Set by composeLaunchDraft, the only caller that ever fires this hook.
      const composition = compositionsByHandle.get(handle as object)!;
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
        await composition.accept(accepted, owner ?? tap.name, log);
      } catch (err) {
        reportSkipped(log, hook, tap, owner, err);
      }
    },
  }));
  return hook;
}

/**
 * Run a launch hook created by {@link launchDraftTaps}. Plugin skill roots are
 * fenced against `requiredSkillSources`. The hook itself only ever sees an
 * opaque, disconnected handle — never the {@link LaunchComposition} — so a
 * plugin's own `hook.intercept` callbacks cannot reach the fence machinery or
 * the accumulated draft directly (see {@link compositionsByHandle}).
 */
export async function composeLaunchDraft(
  hook: AsyncSeriesHook<[LaunchDraft]>,
  requiredSkillSources: readonly AgentRuntimeSkillSource[],
): Promise<LaunchDraft> {
  const composition = new LaunchComposition(requiredSkillSources);
  const handle: LaunchDraft = { instructions: [], skillSources: [] };
  compositionsByHandle.set(handle, composition);
  try {
    await hook.promise(handle);
  } catch (err) {
    // Core's isolation wrapper already isolates each tap; this catches a
    // rejection from an interceptor a plugin added to the hook itself.
    logsByLaunchHook.get(hook)?.error(
      { hook: hook.name, err: errorInfo(err) },
      'plugin hook failed; its changes were skipped',
    );
  }
  return composition;
}
