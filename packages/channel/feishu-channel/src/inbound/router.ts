/** Owns conversation routing for accepted messages and slash commands. */
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import type { FeishuBot } from '../bot.js';
import type { FeishuCoreCommands } from '../feishu-core-commands.js';
import type { FeishuProvisioning } from '../feishu-provisioning.js';
import {
  dispatchFeishuSlashCommand,
  type FeishuSlashCommandInvocation,
  type FeishuSlashCommandReply,
} from '../feishu-slash-commands.js';
import {
  errorMessage,
  type FeishuChatSubmission,
  type FeishuInboundDelivery,
  type FeishuSubmitOutcome,
} from '../feishu-submit.js';
import type { FeishuRouting } from '../routing/index.js';
import {
  rejectedDeliveryNotice,
  type FeishuBindingOperations,
} from '../routing/operations.js';
import { describeTarget, type FeishuTarget } from '../routing/target.js';
import type { FeishuTeamSubmitter } from '../session/submitter.js';

export class FeishuInboundRouter implements FeishuInboundDelivery {
  constructor(
    private readonly opts: {
      log: DreamuxLogger;
      routing: FeishuRouting;
      bindings: FeishuBindingOperations;
      commands: FeishuCoreCommands;
      bot: FeishuBot;
      provisioning: FeishuProvisioning;
      submitter: FeishuTeamSubmitter;
    },
  ) {}

  /**
   * An accepted message in a topic that has its own route is a message the
   * Channel can reply under, which a route bound by a tool or written before
   * roots were persisted does not have. The topic's root is the one the event
   * names; a message that names none is the topic's first, and is its own
   * root. A row that already has a root, or a target with no row of its own
   * (a topic served by its parent group), is left alone.
   */
  async learnTopicRoot(input: {
    target: FeishuTarget;
    messageId: string;
    rootId: string | undefined;
  }): Promise<void> {
    try {
      await this.opts.routing.fillTopicRoot(
        input.target,
        input.rootId ?? input.messageId,
      );
    } catch (error) {
      this.opts.log.warn(
        {
          target: describeTarget(input.target),
          message_id: input.messageId,
          err: { message: errorMessage(error) },
        },
        'could not record the reply root of a Feishu topic route',
      );
    }
  }

  /** Execute a recognized command after route projection, without submission. */
  command(input: {
    command: FeishuSlashCommandInvocation;
    target: FeishuTarget;
    containerChatId: string | null;
    messageId: string;
  }): Promise<FeishuSlashCommandReply> {
    const plan = this.opts.routing.plan(input.target, input.containerChatId);
    return dispatchFeishuSlashCommand(input.command, {
      plan,
      target: input.target,
      messageId: input.messageId,
      bindingOperations: this.opts.bindings,
      bindings: this.opts.routing.listBindings(),
      // A rejected Core command does not reconcile this Channel's routing. It is not
      // proof the route is finished — `TEAM_CLOSED` is raised for a dissolve
      // that is still only pending, and a dissolve that then fails lowers the
      // fence and leaves the Team open again (`TeamService.runDissolve`). The
      // two paths that do reconcile hold the proof this one lacks: the final
      // `team.state` for closure, a rejected delivery for a row pointing at
      // nothing. Removing rows here would take the announcement away from
      // both, because the first remover is the only one with anything to
      // announce.
      commands: this.opts.commands,
      bot: this.opts.bot,
    });
  }

  /**
   * Deliver one accepted message wherever this Channel routes it.
   *
   * `dispatcher` goes to the Dispatcher Agent; `bound` goes to the named Team,
   * and a pre-admission `TEAM_NOT_FOUND`/`TEAM_CLOSED` drops the stale routes
   * and falls back once to the Dispatcher Agent; `provision` runs automatic
   * provisioning and its outcome is final — `unsubmitted`/`rejected` get no
   * Dispatcher fallback, the inbound path posts a failure notice instead.
   */
  async deliver(input: {
    target: FeishuTarget;
    containerChatId: string | null;
    submission: FeishuChatSubmission;
  }): Promise<FeishuSubmitOutcome> {
    const plan = this.opts.routing.plan(input.target, input.containerChatId);
    const { submission } = input;
    if (plan.kind === 'dispatcher') {
      return this.opts.submitter.submit(null, submission);
    }
    if (plan.kind === 'provision') {
      return this.opts.provisioning.provisionForInbound({
        space: plan.space,
        target: input.target,
        display: null,
        submission,
      });
    }
    const outcome = await this.opts.submitter.submit(plan.teamName, submission);
    if (outcome.status !== 'rejected') return outcome;
    // Nothing was admitted, so the message is safe to deliver once more: drop
    // the stale routes and hand it to the Dispatcher Agent, as every
    // conversation this Channel cannot route is. Past that fallback, an
    // ambiguous admission or unknown failure proves nothing about a turn, so
    // nothing is sent twice on a guess.
    await this.opts.bindings.forgetTeamRoutes(
      plan.teamName,
      rejectedDeliveryNotice(outcome.code),
    );
    return this.opts.submitter.submit(null, submission);
  }
}
