/**
 * The generic shape behind every persisted runtime store: one file, one
 * owner-supplied loader, one committed in-memory value, and one serialized
 * queue for every change. It knows no schema, version, legacy-file error, or
 * path rule — those stay with the caller's `load()` and, for a mutation, the
 * caller's `change`/`afterCommit` callbacks. This module imports nothing from
 * any other Dreamux package, matching the `dreamux-utils` boundary.
 *
 * The file is written before the in-memory value is replaced, so a reader
 * only ever sees a value that is also on disk, and a write that failed left
 * neither changed. `update`/`create`/`remove` share one FIFO promise tail so
 * two callers changing the same store never race each other's
 * read-modify-write. `load()` is deliberately not queued on that same tail:
 * `update`/`remove` call it as their own first step from inside a
 * tail-queued callback, and if `load()` were itself queued on that tail it
 * could never run — the callback waiting on it is what occupies the queue's
 * current slot. `load()` uses its own, independent in-flight-promise guard
 * instead, so a store nobody has explicitly loaded yet still works
 * correctly the first time `update()`/`remove()` runs.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { publishFileExclusive } from './fs.js';

export interface TransactionalStoreOptions<T> {
  /** Absolute path of the one file this store owns. */
  path: string;
  /** The owner's initial read: what a missing, unreadable, or legacy file means. */
  load(): Promise<T>;
  /** Defaults to JSON with two-space indentation and a trailing newline. */
  encode?(value: T): string;
  /** Mode for a parent directory the store has to create; omitted = process default. */
  dirMode?: number;
}

export class TransactionalStore<T> {
  // Wrapped so "not loaded yet" (`slot === null`) is distinguishable from
  // "loaded, and the value itself is `null`" (a store whose `T` includes
  // `null` as a real committed value, e.g. "no record on disk").
  private slot: { readonly current: T } | null = null;
  private loading: Promise<T> | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: TransactionalStoreOptions<T>) {}

  /** Read once; concurrent callers share the in-flight read. A failed read caches nothing. */
  load(): Promise<T> {
    if (this.slot !== null) return Promise.resolve(this.slot.current);
    if (this.loading !== null) return this.loading;
    const attempt = this.opts.load().then(
      (loaded) => {
        this.slot = { current: loaded };
        this.loading = null;
        return loaded;
      },
      (err: unknown) => {
        this.loading = null;
        throw err;
      },
    );
    this.loading = attempt;
    return attempt;
  }

  /** The last committed value. Throws before a successful `load()` — a plain read call site awaits `load()` itself first. */
  get current(): T {
    if (this.slot === null) {
      throw new Error(
        `transactional store for ${this.opts.path} was read before it finished loading`,
      );
    }
    return this.slot.current;
  }

  /**
   * Change the committed value. `change` sees the committed value and returns
   * the next one; returning that same reference is a no-op — nothing is
   * written and `afterCommit` does not run. Otherwise the file is written
   * first, then memory is swapped, then `afterCommit` runs (still inside the
   * queue, so the next queued operation waits for it too); a throw from
   * `change`, the write, or `afterCommit` rejects the caller, and a throw from
   * `afterCommit` specifically leaves the commit itself standing. `change` may
   * await other work, but must not call `update`/`create`/`remove` on this
   * same store — that call would be queued behind this one and wait on it
   * forever.
   */
  update(
    change: (current: T) => T | Promise<T>,
    afterCommit?: (next: T, previous: T) => void | Promise<void>,
  ): Promise<T> {
    return this.enqueue(async () => {
      const previous = await this.load();
      const next = await change(previous);
      if (next === previous) return previous;
      await this.publishReplace(next);
      this.slot = { current: next };
      if (afterCommit) await afterCommit(next, previous);
      return next;
    });
  }

  /**
   * Write `value` without reading the file first. Default is create-only —
   * `EEXIST` (via `publishFileExclusive`) rejects the caller instead of
   * clobbering whatever is there. `{ replace: true }` writes over whatever is
   * there via the same atomic-write path `update` uses.
   */
  create(
    value: T,
    options: {
      replace?: boolean;
      afterCommit?: (next: T) => void | Promise<void>;
    } = {},
  ): Promise<T> {
    return this.enqueue(async () => {
      if (options.replace) {
        await this.publishReplace(value);
      } else {
        await this.ensureDir();
        const published = await publishFileExclusive(
          this.opts.path,
          this.encode(value),
          { mode: 0o600 },
        );
        if (!published) {
          throw new Error(`${this.opts.path} already exists`);
        }
      }
      this.slot = { current: value };
      if (options.afterCommit) await options.afterCommit(value);
      return value;
    });
  }

  /** Unlink the file (`ENOENT` counts as success), then the committed value becomes `next`. */
  remove(next: T): Promise<void> {
    return this.enqueue(async () => {
      await this.load();
      try {
        await unlink(this.opts.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      this.slot = { current: next };
    });
  }

  /** Resolves once every operation queued so far has settled. */
  async drain(): Promise<void> {
    await this.tail.catch(() => undefined);
  }

  private encode(value: T): string {
    return this.opts.encode
      ? this.opts.encode(value)
      : JSON.stringify(value, null, 2) + '\n';
  }

  private async ensureDir(): Promise<void> {
    const dir = dirname(this.opts.path);
    if (this.opts.dirMode !== undefined) {
      await mkdir(dir, { recursive: true, mode: this.opts.dirMode });
    } else {
      await mkdir(dir, { recursive: true });
    }
  }

  /**
   * Sibling temp file, fully written, then renamed over the target. Mode
   * `0600`, no fsync. The temp file is opened `wx` (create, exclusive) so a
   * collision on the random suffix throws instead of silently overwriting
   * another in-flight write.
   */
  private async publishReplace(value: T): Promise<void> {
    await this.ensureDir();
    const data = this.encode(value);
    const tmp = `${this.opts.path}.tmp-${tempSuffix()}`;
    try {
      await writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
      await rename(tmp, this.opts.path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const settled = this.tail.then(fn);
    this.tail = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }
}

function tempSuffix(): string {
  return (
    process.pid.toString(16) +
    '-' +
    Date.now().toString(36) +
    '-' +
    randomBytes(4).toString('hex')
  );
}
