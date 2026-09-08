export interface CompletionDeliverySource {
  abandonPendingCompletionDelivery(): void;
  rearmCompletionDelivery(): void;
}

/** One process-local epoch and the sources whose future work inherits it. */
export class CompletionDeliveryScope {
  private current: object | null = {};
  private readonly staleSources = new WeakSet<CompletionDeliverySource>();

  capture(): object | null {
    return this.current;
  }

  owns(scope: object | null): boolean {
    return scope !== null && this.current === scope;
  }

  abandon(...populations: readonly Iterable<CompletionDeliverySource>[]): void {
    this.current = null;
    this.visit(populations, (source) => source.abandonPendingCompletionDelivery());
  }

  rearm(...populations: readonly Iterable<CompletionDeliverySource>[]): void {
    if (this.current !== null) return;
    this.current = {};
    this.visit(populations, (source) => {
      this.staleSources.delete(source);
      source.rearmCompletionDelivery();
    });
  }

  retireIfStale(source: CompletionDeliverySource, scope: object | null): void {
    if (this.owns(scope)) return;
    this.staleSources.add(source);
    source.abandonPendingCompletionDelivery();
  }

  rearmAfterStaleOperation(source: CompletionDeliverySource): void {
    if (this.current === null || !this.staleSources.delete(source)) return;
    source.rearmCompletionDelivery();
  }

  private visit(
    populations: readonly Iterable<CompletionDeliverySource>[],
    operation: (source: CompletionDeliverySource) => void,
  ): void {
    const visited = new Set<CompletionDeliverySource>();
    for (const population of populations) {
      for (const source of population) {
        if (visited.has(source)) continue;
        visited.add(source);
        operation(source);
      }
    }
  }
}
