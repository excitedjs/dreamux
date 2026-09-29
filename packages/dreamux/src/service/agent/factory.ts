import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { AdmissionLedger } from './admission.js';
import type { AgentEntityIdentity } from './identity.js';
import { AgentService } from './service.js';
import {
  AgentIdentityStore,
  type AgentIdentityCreateInput,
  type AgentIdentityUpdateInput,
} from './store.js';
import type {
  TeammateServiceDeps,
  TeammateServiceOptions,
} from './service-types.js';

/** Where one agent entity's `identity.json` lives. */
export interface AgentEntityLocation {
  dir: string;
  /**
   * The owner's own key for this entity when the path encodes it (a
   * `teammate/<name>/` child); `null` at an owner root whose name is not
   * encoded in the path (the dispatcher Agent, a TeamLeader).
   */
  expectedName: string | null;
}

/**
 * Everything one `AgentService` needs besides its identity storage and its
 * options: the collaborators every owner already holds and threads through
 * unchanged. `identities` is filled in by this factory, never by a caller.
 */
export type AgentEntityBuildDeps = Omit<
  TeammateServiceDeps,
  'admissions' | 'identities'
>;

/**
 * How every caller supplies an entity's role-specific options: computed from
 * the identity `create`/`open`/`upsert` just produced, since every caller's
 * options (a launch draft, a system prompt) depend on that identity and none
 * has one to hand over ahead of it.
 */
type AgentEntityOptions = (
  identity: AgentEntityIdentity,
) => Promise<TeammateServiceOptions>;

/**
 * Builds every `AgentService` for one dispatcher — its own Agent, each Team's
 * leader, and every TeamMate a `TeammateCollection` holds.
 *
 * `dispatcherId` is bound once, at construction, instead of threaded through
 * every call. `admissions` is this factory's own `AdmissionLedger`, built
 * here rather than handed in: the ledger has to outlive an entity's service
 * object (rematerialized on reopen, dropped on retire), so one factory
 * instance carries the one ledger for as long as the dispatcher runs.
 *
 * This is also the agent module's one entry for `identity.json` itself:
 * `create`/`open`/`upsert` bind and read/write an `AgentIdentityStore`
 * internally, so no caller outside `service/agent/` constructs one. A caller
 * states what it wants — a fresh identity, whatever is already at a
 * directory, a reconciled upsert of a fully-computed record — and gets back a
 * built `AgentService` (or `null` for `open`), never the store: the store's
 * directory, its file name, and its `TransactionalStore` are this module's
 * own concern.
 */
export class AgentServiceFactory {
  private readonly admissions = new AdmissionLedger();

  constructor(private readonly dispatcherId: string) {}

  private bind(
    location: AgentEntityLocation,
    log: DreamuxLogger,
  ): AgentIdentityStore {
    return new AgentIdentityStore({
      dir: location.dir,
      dispatcherId: this.dispatcherId,
      expectedName: location.expectedName,
      log,
    });
  }

  private build(
    deps: AgentEntityBuildDeps,
    store: AgentIdentityStore,
    identity: AgentEntityIdentity,
    options: TeammateServiceOptions,
  ): AgentService {
    return new AgentService(
      { ...deps, identities: store, admissions: this.admissions },
      this.dispatcherId,
      identity,
      options,
    );
  }

  /** Create a fresh identity at `location.dir` and build its `AgentService`. */
  async create(input: {
    location: AgentEntityLocation;
    creation: AgentIdentityCreateInput;
    options: AgentEntityOptions;
    deps: AgentEntityBuildDeps;
    log: DreamuxLogger;
  }): Promise<AgentService> {
    const store = this.bind(input.location, input.log);
    const identity = await store.create(input.creation, input.deps.onPersisted);
    const options = await input.options(identity);
    return this.build(input.deps, store, identity, options);
  }

  /**
   * Open the identity already at `location.dir`, or `null` when there is
   * none, or when `align` says it does not belong to the caller (an orphan
   * left at a reused directory). The returned `AgentService` wraps the same
   * store instance this call just read, already loaded.
   */
  async open(input: {
    location: AgentEntityLocation;
    align?: (identity: AgentEntityIdentity) => boolean;
    options: AgentEntityOptions;
    deps: AgentEntityBuildDeps;
    log: DreamuxLogger;
  }): Promise<AgentService | null> {
    const store = this.bind(input.location, input.log);
    const identity = await store.read();
    if (
      identity === null ||
      (input.align !== undefined && !input.align(identity))
    ) {
      return null;
    }
    const options = await input.options(identity);
    return this.build(input.deps, store, identity, options);
  }

  /**
   * Read whatever is at `location.dir` and reconcile it against a
   * caller-owned policy, then overwrite the location with the result — then
   * build the `AgentService` from that written identity.
   *
   * The one entry for an owner whose identity is not created-once-and-then-
   * restored but continuously reconciled against its own live config (the
   * dispatcher root's compatible-preparation policy). The caller states only
   * `creation` (its input for a fresh identity, when nothing exists yet) and
   * `reconcile` (its compatibility decision against an existing one — which
   * fields change, whether the session resets); the store owns every field
   * default and the bind/read/replace-write around it, so the policy's own
   * module never constructs a second copy of those defaults.
   */
  async upsert(input: {
    location: AgentEntityLocation;
    creation: AgentIdentityCreateInput;
    reconcile: (existing: AgentEntityIdentity) => AgentIdentityUpdateInput;
    options: AgentEntityOptions;
    deps: AgentEntityBuildDeps;
    log: DreamuxLogger;
  }): Promise<AgentService> {
    const store = this.bind(input.location, input.log);
    const identity = await store.upsert(
      input.creation,
      input.reconcile,
      input.deps.onPersisted,
    );
    const options = await input.options(identity);
    return this.build(input.deps, store, identity, options);
  }
}
