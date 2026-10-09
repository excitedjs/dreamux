/**
 * The Config Service: `config.json`'s single in-process authority.
 *
 * One process opens one `ConfigService` (`cli/server.ts`, at the point
 * `loadConfig` ran before this existed) and every long-lived object that
 * needs the current config holds this instead of a `DreamuxConfig` value it
 * captured once — see {@link ConfigReader}. A `TransactionalStore` backs it,
 * so every read sees the same committed value and every write goes through
 * the store's own serialized read-decide-replace: no second reservation,
 * file-open, or validation path beside the one `readConfigFile`/
 * `resolveConfig` (`./load.js`) already gives the file-read path
 * `doctor`/`onboard`/`loadConfig` use.
 *
 * The store's value pairs the parsed file (`raw`) with its resolved shape
 * (`config`). `raw` is what gets written back out — a hand-written
 * `dispatchers` block, `~` paths, and every other value survive a
 * `config.agents.replace` untouched, because only `raw.agents` is ever
 * replaced and the rest of `raw` travels through unchanged; a
 * `config.agents.replace` write does re-serialize the whole file at
 * two-space indentation (`encode`, below), so whitespace/indentation is not
 * preserved byte-for-byte, only values and key order. `config` is never
 * serialized; it exists so `current()` never has to re-run `resolveConfig`
 * on every read.
 */

import {
  isPlainObject,
  isSecretKeyName,
  redactSecretKeyValues,
  TransactionalStore,
} from '@excitedjs/dreamux-utils';

import { throwCallerMistake } from '../command/errors.js';
import type { LoadedPlugin } from '../plugin/loader.js';
import type { ProviderRegistry } from '../registry/registry.js';
import { globalConfigFile, type DreamuxConfig } from './config.js';
import {
  assertNoLegacyTomlOnly,
  readConfigFile,
  resolveConfig,
} from './load.js';

/**
 * One `agents[]` entry in file shape — whatever the operator wrote, with
 * every secret-named value emptied by {@link ConfigService.readAgents}. Not
 * `ResolvedAgentConfig` (`./config.js`): that is the loaded,
 * provider-normalized shape; this is what round-trips through
 * `config.agents.get`/`config.agents.replace` verbatim, unknown keys
 * included.
 */
export type AgentFileEntry = Record<string, unknown>;

/**
 * The capability every multi-call holder of a `DreamuxConfig` takes instead
 * of the value itself. `ConfigService` satisfies this structurally, so a
 * caller under test can hand a bare `{ current: () => testConfig }` without
 * building a real file-backed service.
 *
 * A caller that only needs a `DreamuxConfig` for the duration of one call
 * keeps taking a plain `DreamuxConfig` parameter and the holder passes
 * `.current()` at that call site — this interface is only for a field held
 * across more than one call, where capturing a `DreamuxConfig` value instead
 * would silently keep serving what was true when it was captured.
 */
export interface ConfigReader {
  current(): DreamuxConfig;
}

/** What `ConfigService`'s store commits: the file as parsed, and its resolved shape. */
interface ConfigServiceState {
  raw: Record<string, unknown>;
  config: DreamuxConfig;
}

export class ConfigService implements ConfigReader {
  private readonly store: TransactionalStore<ConfigServiceState>;
  private loadedPlugins: readonly LoadedPlugin[] = [];

  private constructor(
    readonly file: string,
    private readonly providerRegistry: ProviderRegistry,
  ) {
    this.store = new TransactionalStore<ConfigServiceState>({
      path: file,
      load: () => this.loadFile(),
      encode: (value) => `${JSON.stringify(value.raw, null, 2)}\n`,
    });
  }

  /**
   * Open `config.json`, running today's checks in today's order with
   * today's messages (legacy TOML, missing file, file mode, parse), then
   * loading it. A failure rejects here — `dreamux serve` still stops before
   * a `ConfigService` exists. Loading before returning means `current()` and
   * {@link plugins} are never observably pre-load.
   */
  static async open(options: {
    providerRegistry: ProviderRegistry;
  }): Promise<ConfigService> {
    const service = new ConfigService(
      globalConfigFile(),
      options.providerRegistry,
    );
    await service.store.load();
    return service;
  }

  current(): DreamuxConfig {
    return this.store.current.config;
  }

  /** Loaded and contributed, with configs read; populated by the one `open()` load. */
  get plugins(): readonly LoadedPlugin[] {
    return this.loadedPlugins;
  }

  /**
   * The current `agents[]` in file shape, every secret-named value emptied.
   * A deep copy: the caller may do anything with it without touching the
   * store's committed value.
   */
  readAgents(): AgentFileEntry[] {
    const rawAgents = this.store.current.raw['agents'];
    const copy = structuredClone(
      Array.isArray(rawAgents) ? rawAgents : [],
    ) as AgentFileEntry[];
    redactSecretKeyValues(copy, '');
    return copy;
  }

  /**
   * Replace the whole `agents[]` section and return the redacted projection
   * of what committed.
   *
   * One store `update`: merge `candidateAgents` onto the committed
   * `agents[]` by `id` (restoring a committed secret under a submitted `''`,
   * {@link mergeAgentEntries}), splice the result into the committed `raw`,
   * then run it through `resolveConfig` — the identical loader/validator a
   * fresh `dreamux serve` uses, so a write this rejects is a write the next
   * start would also reject. Every validator on that path raises a
   * `RuleViolation` for a value it checked and refused: `config.ts`'s
   * `mergeWithDefaults`, the shared readers in `@excitedjs/dreamux-utils`, each
   * provider's own `config.read`, and the loader's refusal of an unregistered
   * `builtin:` ref. {@link throwCallerMistake} re-types exactly that into the
   * caller's mistake, so `config.agents.replace` reports `BAD_REQUEST` instead
   * of `INTERNAL` for a bad payload. A dynamic import, a file read, or a
   * provider's own `TypeError` is not a refused value and keeps its own code.
   * Either way this call rejects with file and memory unchanged, by
   * `TransactionalStore.update`'s own contract (nothing is written or swapped
   * before `change` returns).
   */
  async replaceAgents(
    candidateAgents: readonly Record<string, unknown>[],
  ): Promise<AgentFileEntry[]> {
    await this.store.update(async (committed) => {
      const committedAgents = committed.raw['agents'];
      const mergedAgents = mergeAgentEntries(
        candidateAgents,
        Array.isArray(committedAgents) ? committedAgents : [],
      );
      const candidateRaw = { ...committed.raw, agents: mergedAgents };
      let config: DreamuxConfig;
      try {
        config = await resolveConfig(
          candidateRaw,
          this.file,
          this.providerRegistry,
        );
      } catch (err) {
        throwCallerMistake(err);
      }
      // resolveConfig (mergeWithDefaults) never sets `config.plugins` — that
      // field is loadFile's own addition, carrying the raw plugins[] entries
      // only so stringifyConfig can round-trip them (./config.js). A replace
      // never touches plugins[] (design decision 1), so the committed value
      // is still exactly right; without this, current().plugins would flip
      // to undefined on the first replace even though raw.plugins is unchanged.
      return {
        raw: candidateRaw,
        config:
          committed.config.plugins === undefined
            ? config
            : { ...config, plugins: committed.config.plugins },
      };
    });
    return this.readAgents();
  }

  /**
   * The store's `load()` callback — the whole open sequence, including
   * one-time plugin loading. Delegates the "open the file" sequence to
   * `readConfigFile` (`./load.js`), the same function the CLI read path
   * (`doctor`/`onboard`/`loadConfig`) uses, so today's checks, order, and
   * messages (legacy TOML, missing file, file mode, parse) stay one
   * implementation. `TransactionalStore.load()` guarantees this runs at most
   * once per store, which is what makes assigning `this.loadedPlugins` here
   * safe: a plugin's `contribute()` registers providers and collides with
   * itself if run twice, so this must never re-run for the life of this
   * `ConfigService`.
   */
  private async loadFile(): Promise<ConfigServiceState> {
    await assertNoLegacyTomlOnly();
    const { raw, config, plugins } = await readConfigFile(
      this.file,
      this.providerRegistry,
    );
    // Runs once per this store (see this method's own doc comment); a future
    // change to TransactionalStore's "load() runs at most once" guarantee
    // would make this reassign on every read instead of the one open.
    this.loadedPlugins = plugins;
    return { raw, config };
  }
}

/**
 * The whole-entry-replace merge {@link ConfigService.replaceAgents} performs
 * on every submitted `agents[]` entry, matched to a committed entry by `id`.
 * A submitted value survives at every depth except one override: a
 * secret-named key submitted as `''` is restored to the committed value at
 * that same JSON path, but only when the committed entry (same `id`)
 * actually has a value there — a new `id`, or a key the committed entry never
 * had, keeps the submitted `''`, since there is nothing to fall back to. An
 * `id` present only in `committedAgents` is dropped: this replaces the whole
 * section, not one entry in it.
 *
 * `id` is trusted to be a non-empty string here: `config/commands.ts`'s
 * `parse()`, the only caller of `replaceAgents`, already narrowed the payload
 * to that shape before this runs.
 */
function mergeAgentEntries(
  candidateAgents: readonly Record<string, unknown>[],
  committedAgents: readonly unknown[],
): AgentFileEntry[] {
  const committedById = new Map<string, Record<string, unknown>>();
  for (const entry of committedAgents) {
    if (isPlainObject(entry) && typeof entry['id'] === 'string') {
      committedById.set(entry['id'], entry);
    }
  }
  return candidateAgents.map((candidate) => {
    const committed = committedById.get(candidate['id'] as string);
    return restoreCommittedSecrets(candidate, committed) as AgentFileEntry;
  });
}

/**
 * Walk `submitted`, restoring `committed`'s value wherever a secret-named
 * key's submitted value is `''` and `committed` has a value at that same
 * path; every other value — known key or not, at any depth — passes through
 * as submitted. Arrays walk by index, mirroring `redactSecretKeyValues`'s own
 * walk (`@excitedjs/dreamux-utils/src/redaction.ts`).
 */
function restoreCommittedSecrets(
  submitted: unknown,
  committed: unknown,
): unknown {
  if (Array.isArray(submitted)) {
    const committedArray = Array.isArray(committed) ? committed : undefined;
    return submitted.map((item, index) =>
      restoreCommittedSecrets(item, committedArray?.[index]),
    );
  }
  if (!isPlainObject(submitted)) return submitted;
  const committedObject = isPlainObject(committed) ? committed : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(submitted)) {
    const committedValue = committedObject?.[key];
    if (isSecretKeyName(key) && value === '' && committedValue !== undefined) {
      out[key] = committedValue;
      continue;
    }
    out[key] = restoreCommittedSecrets(value, committedValue);
  }
  return out;
}
