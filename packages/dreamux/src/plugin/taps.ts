/**
 * The only module that executes plugin taps.
 *
 * Core never calls tapable's `hook.call` / `hook.promise`: the compiled
 * `promise()` shares one argument across taps and rejects on the first
 * failure, while a failing plugin tap must only lose its own changes. Iterating
 * the public `hook.taps` array (already ordered by `stage` / `before`) gives
 * that per-tap isolation. Call and tap interceptors added with
 * `hook.intercept` are therefore not run; `register` interceptors run when a
 * tap is added, which is tapable's own step.
 */

import type {
  AgentRuntimeSkillSource,
  DreamuxLogger,
  LaunchDraft,
} from '@excitedjs/dreamux-types';
import type { AsyncSeriesHook, SyncHook } from 'tapable';

import { normalizeAgentRuntimeSkillSources } from '../agent-runtime/skill-sources.js';
import { errorInfo, errorMessage } from '../platform/error-info.js';
import { PluginLoadError } from './loader.js';

interface RunnableTap {
  readonly name: string;
  readonly type: 'sync' | 'async' | 'promise';
  readonly fn: (...args: unknown[]) => unknown;
}

type AnyHook<T extends unknown[]> = SyncHook<T> | AsyncSeriesHook<T>;

function tapsOf<T extends unknown[]>(hook: AnyHook<T>): readonly RunnableTap[] {
  return [...hook.taps] as unknown as readonly RunnableTap[];
}

async function invokeTap(tap: RunnableTap, args: readonly unknown[]): Promise<void> {
  if (tap.type === 'async') {
    await new Promise<void>((resolve, reject) => {
      tap.fn(...args, (err?: unknown) => {
        if (err !== undefined && err !== null && err !== false) reject(err);
        else resolve();
      });
    });
    return;
  }
  await tap.fn(...args);
}

function logSkipped(
  log: DreamuxLogger,
  tap: RunnableTap,
  hookName: string | undefined,
  err: unknown,
): void {
  log.error(
    { plugin: tap.name, hook: hookName, err: errorInfo(err) },
    'plugin hook callback failed; its changes were skipped',
  );
}

/** Runtime sync hooks (`dispatcher`, `team`): a throw is logged and skipped. */
export function callTapsIsolated<T extends unknown[]>(
  hook: SyncHook<T>,
  args: T,
  log: DreamuxLogger,
): void {
  for (const tap of tapsOf(hook)) {
    try {
      tap.fn(...args);
    } catch (err) {
      logSkipped(log, tap, hook.name, err);
    }
  }
}

/**
 * Load-phase sync hooks (`plugin.for(name)`): a throw fails loading and is
 * attributed to the tapping plugin.
 */
export function callLoadPhaseTaps<T extends unknown[]>(
  hook: SyncHook<T>,
  args: T,
  apiOwner: string,
): void {
  for (const tap of tapsOf(hook)) {
    try {
      tap.fn(...args);
    } catch (err) {
      throw new PluginLoadError(
        tap.name,
        'api',
        `while receiving plugin "${apiOwner}" api: ${errorMessage(err)}`,
        { cause: err },
      );
    }
  }
}

/** Async hooks without a draft (`created`): a rejection is logged and skipped. */
export async function runTapsIsolated<T extends unknown[]>(
  hook: AsyncSeriesHook<T>,
  args: T,
  log: DreamuxLogger,
): Promise<void> {
  for (const tap of tapsOf(hook)) {
    try {
      await invokeTap(tap, args);
    } catch (err) {
      logSkipped(log, tap, hook.name, err);
    }
  }
}

/**
 * Launch hooks: each tap writes into its own empty sub-draft, merged only after
 * the tap resolved and its skill roots passed the skill fence. A failing tap
 * contributes nothing, so a half-pushed draft never reaches a runtime.
 */
export async function composeLaunchDraft(
  hook: AsyncSeriesHook<[LaunchDraft]>,
  options: {
    requiredSkillSources: readonly AgentRuntimeSkillSource[];
    log: DreamuxLogger;
  },
): Promise<{ instructions: string[]; skillSources: AgentRuntimeSkillSource[] }> {
  const accepted = {
    instructions: [] as string[],
    skillSources: [] as AgentRuntimeSkillSource[],
  };
  for (const tap of tapsOf(hook)) {
    const sub: LaunchDraft = { instructions: [], skillSources: [] };
    try {
      await invokeTap(tap, [sub]);
      // The fence costs filesystem IO; a tap that adds no roots skips it.
      if (sub.skillSources.length > 0) {
        accepted.skillSources = await normalizeAgentRuntimeSkillSources(
          [...accepted.skillSources, ...sub.skillSources],
          {
            label: `plugin "${tap.name}" skillSources`,
            requiredSources: options.requiredSkillSources,
          },
        );
      }
    } catch (err) {
      logSkipped(options.log, tap, hook.name, err);
      continue;
    }
    accepted.instructions.push(...sub.instructions);
  }
  return accepted;
}
