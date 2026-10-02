/** Owns the complete channel submission, from anchor claim through Core admission. */
import type { FeishuCotAdapter } from '../cot/adapter.js';
import type { FeishuCoreCommands } from '../feishu-core-commands.js';
import {
  submissionProvesNoAdmission,
  type FeishuSubmission,
  type FeishuSubmitOutcome,
} from '../feishu-submit.js';
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
  ): Promise<FeishuSubmitOutcome> {
    if (!this.opts.lifecycle.isLive()) {
      return { status: 'error', message: 'Feishu session is not live' };
    }
    // Only a chat submission has a visible message to hang a card under; a
    // document comment opens none, and registers no correlation to suppress.
    const inbound =
      submission.kind === 'chat'
        ? this.opts.cot.beginInboundSubmission({
            teamName,
            anchor: submission.anchor,
            sourceId: submission.sourceId,
          })
        : null;
    try {
      const outcome =
        teamName !== null
          ? await this.opts.commands.teamSubmit(teamName, submission)
          : await this.opts.commands.dispatcherSubmit(submission);
      if (submissionProvesNoAdmission(outcome)) inbound?.retire();
      return outcome;
    } finally {
      inbound?.release();
    }
  }
}
