import type { TeammateRole } from '@excitedjs/dreamux-types';
import type { DispatcherCoreEventPublisher } from '../dispatcher-core-events/index.js';
import { AdmissionLedger } from './admission.js';
import type { AgentEntityIdentity } from './identity.js';
import type {
  TeammateServiceDeps,
  TeammateServiceOptions,
} from './service-types.js';
import { AgentService } from './service.js';
import {
  AgentIdentityStore,
  type AgentIdentityCreateInput,
  type AgentIdentityUpdateInput,
} from './store.js';

/** Where one agent entity's identity lives; record fields never select it. */
export interface AgentEntityLocation {
  dir: string;
  expectedName: string | null;
}

type FactoryDeps = Omit<
  TeammateServiceDeps,
  'admissions' | 'identities' | 'siblings'
> & {
  coreEvents: DispatcherCoreEventPublisher;
};

/** An already-read or committed identity, before role options and launch hooks. */
export class UnbuiltAgent {
  constructor(
    private readonly deps: Omit<TeammateServiceDeps, 'siblings'>,
    private readonly dispatcherId: string,
    private readonly role: TeammateRole,
    readonly identity: AgentEntityIdentity,
  ) {}

  build(
    options: Omit<TeammateServiceOptions, 'role'>,
    siblings: TeammateServiceDeps['siblings'] = null,
  ): AgentService {
    return new AgentService(
      { ...this.deps, siblings },
      this.dispatcherId,
      this.identity,
      { ...options, role: this.role },
    );
  }

  /** Close a never-materialized member without launch hooks or a runtime. */
  close(note: string): Promise<AgentEntityIdentity> {
    return this.deps.identities.update({
      status: 'closed',
      closedAt: Date.now(),
      closeNote: note,
    });
  }
}

/** One dispatcher binds fixed collaborators and its shared admission ledger. */
export class AgentServiceFactory {
  private readonly admissions = new AdmissionLedger();

  constructor(
    private readonly dispatcherId: string,
    private readonly deps: FactoryDeps,
  ) {}

  private bind(
    location: AgentEntityLocation,
    role: TeammateRole,
  ): AgentIdentityStore {
    const store = new AgentIdentityStore({
      ...location,
      dispatcherId: this.dispatcherId,
      log: this.deps.log,
    });
    // The first listener publishes the identity fact before any holder's aggregate.
    store.committed.on('committed', (identity) => {
      this.deps.coreEvents.publish({
        schemaVersion: 1,
        kind: 'teammate.state',
        occurredAt: identity.updated_at,
        teammateName: identity.name,
        role,
        teamName: identity.team_id,
        status: identity.status,
      });
    });
    return store;
  }

  private prepared(
    store: AgentIdentityStore,
    role: TeammateRole,
    identity: AgentEntityIdentity,
  ): UnbuiltAgent {
    return new UnbuiltAgent(
      { ...this.deps, identities: store, admissions: this.admissions },
      this.dispatcherId,
      role,
      identity,
    );
  }

  async create(input: {
    location: AgentEntityLocation;
    role: TeammateRole;
    creation: AgentIdentityCreateInput;
  }): Promise<UnbuiltAgent> {
    const store = this.bind(input.location, input.role);
    return this.prepared(store, input.role, await store.create(input.creation));
  }

  async open(input: {
    location: AgentEntityLocation;
    role: TeammateRole;
  }): Promise<UnbuiltAgent | null> {
    const store = this.bind(input.location, input.role);
    const identity = await store.read();
    return identity === null
      ? null
      : this.prepared(store, input.role, identity);
  }

  async upsert(input: {
    location: AgentEntityLocation;
    role: TeammateRole;
    creation: AgentIdentityCreateInput;
    reconcile: (existing: AgentEntityIdentity) => AgentIdentityUpdateInput;
  }): Promise<UnbuiltAgent> {
    const store = this.bind(input.location, input.role);
    return this.prepared(
      store,
      input.role,
      await store.upsert(input.creation, input.reconcile),
    );
  }
}
