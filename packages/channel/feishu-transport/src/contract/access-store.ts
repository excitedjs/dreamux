/**
 * The access-state persistence contract.
 *
 * The pure `gate()` reasons over an `Access` value but never reads or writes
 * it; persistence is the host's job, injected through this interface. Each host
 * backs it differently — dreamux with SQLite under `~/.dreamux/runtime`
 * (server-owned runtime state), claudemux with its existing atomic-write
 * `access.json`. Keeping
 * `gate` pure with the store injected leaves the gate logic in one place (core)
 * instead of copy-drifting per host. See dreamux#25 §6 (decision D).
 *
 * Corruption handling (e.g. an unreadable `access.json` moved aside, defaults
 * restored fail-closed) is the implementing host's concern, not part of this
 * interface — the host decides what a load failure means for its deployment.
 */

import type { Access } from './types.js'

/** Persists the access-control state a host's gate decisions read and mutate. */
export interface AccessStore {
  /** Return the current access state (defaults when none has been persisted). */
  load(): Access
  /** Persist `access` durably, replacing any previous state. */
  save(access: Access): void
}
