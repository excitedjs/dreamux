import type { TeammateService } from '../teammate-service/index.js';
import {
  CompletionDeliveryScope,
  type CompletionDeliverySource,
} from '../teammate-service/completion-delivery-scope.js';

/** The nested Team/host fences governing this Team's completion obligations. */
export class TeamCompletionDelivery {
  private readonly scope = new CompletionDeliveryScope();
  private aggregateAbandoned = false;

  constructor(private readonly source: CompletionDeliverySource) {}

  capture(): object | null {
    return this.scope.capture();
  }

  retireIfStale(service: TeammateService, captured: object | null): void {
    this.scope.retireIfStale(service, captured);
  }

  async finishAdmission<T>(service: TeammateService, admission: Promise<T>): Promise<T> {
    try {
      return await admission;
    } finally {
      this.scope.rearmAfterStaleOperation(service);
    }
  }

  abandonForClose(): void {
    this.scope.abandon([this.source]);
  }

  rearmAfterFailedDissolve(): void {
    if (!this.aggregateAbandoned) this.scope.rearm([this.source]);
  }

  abandonForAggregate(): void {
    this.aggregateAbandoned = true;
    this.abandonForClose();
  }

  rearmForAggregate(): void {
    this.aggregateAbandoned = false;
    this.scope.rearm([this.source]);
  }
}
