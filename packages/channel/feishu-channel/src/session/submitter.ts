/** Owns the complete channel submission, from anchor claim through Core admission. */
import type { FeishuCotAdapter } from '../cot/adapter.js';
import type { FeishuCoreCommands } from '../feishu-core-commands.js';
import {
  submissionProvesNoAdmission,
  type FeishuSubmission,
  type FeishuSubmitOutcome,
} from '../feishu-submit.js';
import type { FeishuTarget } from '../routing/target.js';
import type { FeishuLifecycle } from './lifecycle.js';

export class FeishuTeamSubmitter {
  constructor(
    private readonly opts: {
      lifecycle: FeishuLifecycle;
      cot: FeishuCotAdapter;
      commands: FeishuCoreCommands;
    },
  ) {}

  /**
   * One turn, to whoever this Channel's routing chose.
   *
   * A `teamName` invokes `team.submit` and reaches that Team's TeamLeader;
   * `null` invokes `dispatcher.submit` and reaches the addressed Dispatcher's
   * own Agent, which is the recipient for a conversation no binding or
   * Collaboration Space claims. Core decides nothing about which: naming a Team
   * or naming none is the Channel's decision, stated in the Command.
   *
   * The Channel takes its own anchor before invoking Core. The caller-owned
   * source id is retained only to recognize the submitted turn whose body is
   * already visible at that anchor; placement never waits on projection.
   */
  async submit(
    teamName: string | null,
    submission: FeishuSubmission,
    servingTarget: FeishuTarget | null,
  ): Promise<FeishuSubmitOutcome> {
    if (!this.opts.lifecycle.isLive()) {
      // Not a failure: nothing was attempted. Saying `error` here made every
      // caller file a failure record for work that was only being stopped, and
      // forced each of them to ask the lifecycle a question this answer already
      // carries.
      return { status: 'not_attempted', reason: 'closed' };
    }
    // Only a chat submission has a visible message to hang a card under; a
    // document comment opens none, and registers no correlation to suppress.
    const inbound =
      submission.kind === 'chat'
        ? this.opts.cot.beginInboundSubmission({
            teamName,
            anchor: { ...submission.anchor, servingTarget },
            sourceId: submission.sourceId,
          })
        : null;
    try {
      const outcome =
        teamName !== null
          ? await this.opts.commands.teamSubmit(teamName, submission)
          : await this.opts.commands.dispatcherSubmit(submission);
      // A failure reported while the session is going away is the shutdown's
      // doing, not the delivery's. Two windows reach here and the entry check
      // above sees neither:
      //
      // - Core answered `SERVER_SHUTTING_DOWN`, which its admission fence
      //   publishes at the very start of a dispatcher close — long before this
      //   session's own lifecycle is aborted, so `isLive()` is still true.
      // - The lifecycle died between the submit and this line.
      //
      // Both mean nothing was delivered and nothing failed, so both answer the
      // same way. Filing either as `error` puts a failure record on every
      // message that happened to be in flight at shutdown.
      if (
        outcome.status === 'error' &&
        (outcome.code === 'SERVER_SHUTTING_DOWN' ||
          !this.opts.lifecycle.isLive())
      ) {
        return { status: 'not_attempted', reason: 'closed' };
      }
      if (submissionProvesNoAdmission(outcome)) inbound?.retire();
      return outcome;
    } finally {
      inbound?.release();
    }
  }
}
