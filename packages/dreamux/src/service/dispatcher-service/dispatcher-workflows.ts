import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { errorInfo } from '../../platform/error-info.js';
import type { CompletionInitiator, CompletionRouter } from '../completion-router/index.js';
import type { TeamCollection } from '../team-collection/index.js';
import type { TeammateCollection } from '../teammate-collection/index.js';
import { WorkflowService, type WorkflowOps } from '../workflow-service/index.js';

interface DispatcherWorkflowDeps {
  dispatcherId: string;
  teammates: Pick<
    TeammateCollection,
    'spawnOwned' | 'releaseAllOwned'
  >;
  teams: Pick<
    TeamCollection,
    'startWorkflows' | 'recoverWorkflows' | 'closeWorkflowAdmissions'
  >;
  router: CompletionRouter;
  completionInitiator: () => CompletionInitiator;
  admit: <T>(task: () => Promise<T>) => Promise<T>;
  log: DreamuxLogger;
}

/** Dispatcher-owned composition boundary for its workflow scope. */
export class DispatcherWorkflows {
  private readonly service: WorkflowService;
  readonly ops: WorkflowOps;

  constructor(private readonly input: DispatcherWorkflowDeps) {
    this.service = new WorkflowService({
      dispatcherId: input.dispatcherId,
      teamId: null,
      callerKind: 'dispatcher',
      ownedTeammates: {
        spawnOwned: (spawnInput, options) =>
          input.admit(() => input.teammates.spawnOwned(spawnInput, options)),
        // Owner cleanup remains available after dispatcher admission closes.
        releaseAllOwned: (owner) => input.teammates.releaseAllOwned(owner),
      },
      router: input.router,
      completionInitiator: input.completionInitiator,
      log: input.log,
    });
    this.ops = {
      run: (runInput) => input.admit(() => this.service.run(runInput)),
      status: (statusInput) => this.service.status(statusInput),
      stop: (stopInput) => input.admit(() => this.service.stop(stopInput)),
      list: () => this.service.list(),
    };
  }

  async start(): Promise<void> {
    await this.service.start();
    await this.input.teams.startWorkflows();
  }

  async recover(): Promise<void> {
    await this.service.recover();
    await this.input.teams.recoverWorkflows();
  }

  closeAdmission(): void {
    this.service.closeAdmission();
    this.input.teams.closeWorkflowAdmissions();
  }

  stopAllForShutdown(): Promise<void> {
    return this.service.stopAllForShutdown();
  }

  /** Wake live run terminal waits for the server shutdown broadcast. */
  interruptForShutdown(): void {
    this.service.interruptForShutdown();
  }

  /** Resolve takeover records after the collection-wide owner sweep succeeds. */
  clearShutdownTakeovers(): void {
    this.service.clearShutdownTakeovers();
  }

  async rollbackStart(): Promise<void> {
    await this.service.stopAll().catch((error: unknown) => {
      this.input.log.error(
        { dispatcher_id: this.input.dispatcherId, err: errorInfo(error) },
        'error stopping workflows after dispatcher start failure',
      );
    });
    await this.input.teammates.releaseAllOwned().catch((error: unknown) => {
      this.input.log.error(
        { dispatcher_id: this.input.dispatcherId, err: errorInfo(error) },
        'error releasing workflow TeamMates after dispatcher start failure',
      );
    });
  }
}
