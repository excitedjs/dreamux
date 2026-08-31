/**
 * Turning an unrouted Feishu topic into a working Team.
 *
 * This is the Collaboration Space product effect, composed from two generic
 * Core Commands. Core is not told that a space exists, that a topic is a child
 * of a group, or that anything is being orchestrated: it is asked to create a
 * Team, and then to accept one submission.
 *
 * None of the work is durable. It lives in this process and may be lost with
 * it — there is no record to resume from, and after a restart the next message
 * to that topic finds no binding and reaches the Dispatcher Agent, exactly as
 * an unmatched target always does. What survives is only what was committed: a
 * Team Core published stays an ordinary Team, a binding installed here stays a
 * route, and neither is compensated for the absence of the other.
 *
 * A run that fails before it invokes `team.submit` answers `unsubmitted`, and
 * the message it was carrying goes to the Dispatcher Agent like any other
 * message this Channel could not hand to a Team. Failing to provision is not a
 * reason to drop what somebody wrote.
 *
 * The policy is the snapshot captured when the route plan was made. An
 * operator who rebinds or removes the space meanwhile changes what the next
 * creation sees and nothing about one already under way.
 */
import type { DreamuxLogger, JsonValue } from '@excitedjs/dreamux-types';

import type { FeishuRouting } from './routing/index.js';
import type { FeishuSpaceRecord } from './routing/document.js';
import { targetIntent, teamNamePrefix } from './routing/naming.js';
import {
  describeTarget,
  targetKey,
  type FeishuTarget,
} from './routing/target.js';
import {
  errorMessage,
  type FeishuSubmission,
  type FeishuSubmitOutcome,
  type FeishuTeamSubmitter,
} from './feishu-submit.js';

interface TeamCreateResultShape {
  status: 'created' | 'existing' | 'closed';
  team_name: string;
  leader_name: string;
}

export interface FeishuProvisioningOptions {
  readonly dispatcherId: string;
  readonly channelId: string;
  readonly log: DreamuxLogger;
  readonly routing: FeishuRouting;
  readonly submitter: FeishuTeamSubmitter;
  invoke(command: string, payload: JsonValue): Promise<JsonValue>;
  /** Announce a newly installed route in the conversation it now serves. */
  announce(input: {
    target: FeishuTarget;
    display: string | null;
    teamName: string;
    spaceName: string;
  }): void;
}

/** One target, one policy snapshot, and the message that discovered both. */
interface ProvisioningRequest {
  readonly space: FeishuSpaceRecord;
  readonly target: FeishuTarget;
  readonly display: string | null;
  readonly submission: FeishuSubmission;
}

export class FeishuProvisioning {
  private readonly inFlight = new Map<string, Promise<FeishuSubmitOutcome>>();

  constructor(private readonly opts: FeishuProvisioningOptions) {}

  /**
   * Provision a target and deliver the message that discovered it.
   *
   * Concurrent messages to the same new topic share one run: the first
   * supplies the first delivery, the rest wait for the binding and are then
   * submitted through the route it installed. The map is the only thing that
   * prevents two Teams for one topic, and it is process-local — which is all
   * this needs to be, because a process that dies mid-run leaves no Team the
   * next process could duplicate a route for.
   */
  provisionForInbound(
    input: ProvisioningRequest,
  ): Promise<FeishuSubmitOutcome> {
    const key = targetKey(input.target);
    const running = this.inFlight.get(key);
    if (running !== undefined) {
      return running
        .catch(() => undefined)
        .then(() => this.deliverAfterRun(input));
    }
    const started = this.guarded(input).finally(() => {
      if (this.inFlight.get(key) === started) this.inFlight.delete(key);
    });
    this.inFlight.set(key, started);
    return started;
  }

  /**
   * A run that cannot finish is a delivery outcome, not an exception.
   *
   * The caller is the platform's inbound handler; letting a failed Team
   * creation escape into it would look like a transport fault and be retried
   * as one, which is exactly the duplicate this design refuses. Everything
   * caught here happened before `team.submit`, so the message is still
   * deliverable and says so.
   */
  private async guarded(
    input: ProvisioningRequest,
  ): Promise<FeishuSubmitOutcome> {
    try {
      return await this.run(input);
    } catch (err) {
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          channel_id: this.opts.channelId,
          space_name: input.space.space_name,
          target: describeTarget(input.target),
          err: { message: errorMessage(err) },
        },
        'Feishu automatic provisioning failed before any submission',
      );
      return { status: 'unsubmitted', message: errorMessage(err) };
    }
  }

  /**
   * Create the Team, commit the route, announce it, deliver the message.
   *
   * The order is the one that degrades honestly. A failure before the binding
   * commits leaves an ordinary Team nothing routes to, which an operator can
   * see and use; it is not chased down, because the alternative is a
   * compensation ledger for work this design has already declared expendable.
   *
   * Only the last line reaches Core with this message. Every earlier exit is
   * `unsubmitted`, which is a fact about this run and not a guess: no Command
   * has been sent yet, so the message is still owed a recipient.
   */
  private async run(input: ProvisioningRequest): Promise<FeishuSubmitOutcome> {
    const created = await this.createTeam(input);
    if (created.status === 'closed') {
      // Reachable now that the request id is the message id: it means this
      // exact message was already provisioned once and its Team has since been
      // closed. Core keeps that acceptance permanently, so there is nothing to
      // retry around — the message is reported unsubmitted and falls back to
      // the Dispatcher Agent. A *new* message to the same topic carries a new
      // id and provisions a fresh Team, so a closed Team never strands a
      // conversation.
      return {
        status: 'unsubmitted',
        message: `team.create replayed closed Team ${created.team_name}`,
      };
    }
    if (created.team_name === '') {
      return {
        status: 'unsubmitted',
        message: 'team.create returned no Team name',
      };
    }
    await this.opts.routing.bind({
      target: input.target,
      teamName: created.team_name,
      display: input.display,
      origin: 'space',
      spaceId: input.space.space_id,
    });
    this.opts.announce({
      target: input.target,
      display: input.display,
      teamName: created.team_name,
      spaceName: input.space.space_name,
    });
    return this.opts.submitter.submit(created.team_name, input.submission);
  }

  /** A message that arrived while a run was live, delivered once it is done. */
  private async deliverAfterRun(input: {
    target: FeishuTarget;
    submission: FeishuSubmission;
  }): Promise<FeishuSubmitOutcome> {
    const binding = this.opts.routing.bindingFor(input.target);
    if (binding === undefined) {
      return {
        status: 'unsubmitted',
        message:
          `provisioning for ${describeTarget(input.target)} installed no route`,
      };
    }
    return this.opts.submitter.submit(binding.team_name, input.submission);
  }

  private async createTeam(
    input: ProvisioningRequest,
  ): Promise<TeamCreateResultShape> {
    const { space, target } = input;
    return (await this.opts.invoke('team.create', {
      // The inbound Feishu message id, used bare: it is globally unique, so it
      // needs no target prefix to stay distinct. Request identity is scoped to
      // the message that triggered provisioning, not to the topic, and that
      // choice is what the following behaviors follow from.
      //
      // The platform redelivering one message replays this same id, so Core's
      // team.create idempotency answers with the Team the first attempt made
      // instead of building a second one. If that first attempt died between
      // `team.create` and the routing bind, the replay answers `existing` and
      // this run goes on to install the binding — recovering the half-finished
      // provisioning rather than duplicating it.
      //
      // A new message always mints a new id, which is the point. After a Team
      // is dissolved, the next message to that same topic provisions a fresh
      // Team normally. A thread-scoped id could not: Core keeps a request's
      // acceptance record permanently, so it would replay `closed` forever and
      // the topic could never be provisioned again.
      //
      // The cost of message scope is that a *different* message arriving after
      // a partial failure creates a second Team. That window is knowingly left
      // undefended: closing it needs durable per-target request state, which
      // this design has already declined to keep.
      //
      // One nuance: a redelivered id whose policy snapshot changed in between
      // hashes differently, so Core raises an idempotency conflict, the run
      // reports `unsubmitted`, and the message falls back to the Dispatcher
      // Agent. Loud, and acceptable.
      request_id: input.submission.sourceId,
      name_prefix: teamNamePrefix(input.display ?? space.display),
      intent: targetIntent({
        display: input.display,
        fallback: target.threadId ?? target.chatId,
      }),
      leader: {
        agent_runtime: space.leader_agent_runtime,
        ...(space.identity !== null ? { identity: space.identity } : {}),
      },
      // Feishu owns a narrow repository policy — a source path and a base ref —
      // and maps it into the Command's full managed-worktree branch here, so
      // no Channel-shaped repository request exists in the Core contract.
      ...(space.repo !== null
        ? {
            repo: {
              mode: 'managed',
              path: space.repo.path,
              ...(space.repo.base_ref !== null
                ? { base_ref: space.repo.base_ref }
                : {}),
              cleanup: 'delete-on-close',
            },
          }
        : {}),
    } as JsonValue)) as unknown as TeamCreateResultShape;
  }
}
