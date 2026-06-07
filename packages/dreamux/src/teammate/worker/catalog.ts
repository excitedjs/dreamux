import type { TeamMateWorkerProvider } from './types.js';

export interface TeamMateWorkerProviderCatalogOptions {
  providers?: readonly TeamMateWorkerProvider[];
  /** Provider ref used when a task does not pin one; defaults to the first. */
  defaultRef?: string;
}

/**
 * Lightweight registry of TeamMate worker providers, keyed by ref (issue #126
 * PR2). Deliberately NOT the agent-runtime catalog: that one validates refs
 * against the builtin provider registry and rejects unknown/reserved refs,
 * which would fight an injected test/fake worker. Worker providers are wired by
 * the server (empty in production for the MVP — no real worker yet) or injected
 * by tests. Resolution never throws; an unknown ref maps to `null`, which the
 * caller turns into a retryable `provider_unavailable`.
 */
export class TeamMateWorkerProviderCatalog {
  private readonly providers = new Map<string, TeamMateWorkerProvider>();
  private readonly defaultRef: string | null;

  constructor(options: TeamMateWorkerProviderCatalogOptions = {}) {
    const list = options.providers ?? [];
    for (const provider of list) {
      this.providers.set(provider.ref, provider);
    }
    this.defaultRef =
      options.defaultRef ?? (list.length > 0 ? list[0]!.ref : null);
  }

  list(): TeamMateWorkerProvider[] {
    return [...this.providers.values()];
  }

  isEmpty(): boolean {
    return this.providers.size === 0;
  }

  /** Whether any registered provider currently advertises worker execution. */
  hasAvailableProvider(): boolean {
    return this.list().some((p) => p.capabilities().worker_available);
  }

  /**
   * Resolve a provider by ref, or the default when ref is null/undefined/empty.
   * Returns null when nothing matches.
   */
  resolve(ref: string | null | undefined): TeamMateWorkerProvider | null {
    if (typeof ref === 'string' && ref !== '') {
      return this.providers.get(ref) ?? null;
    }
    if (this.defaultRef === null) return null;
    return this.providers.get(this.defaultRef) ?? null;
  }
}
