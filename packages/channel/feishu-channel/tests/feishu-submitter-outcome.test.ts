/**
 * What the submitter answers when the session stops mid-flight.
 *
 * The entry check covers a session that was already dead. It cannot cover one
 * that died while the Command was in Core: by then the submit has started, and
 * the answer arrives after teardown began. Both are the shutdown's doing, so
 * both must reach the caller as the same fact — otherwise every message in
 * flight at shutdown files an error-level failure record.
 */
import { describe, expect, it } from 'vitest';

import { FeishuTeamSubmitter } from '../src/session/submitter.js';
import type { FeishuCommandSubmitOutcome } from '../src/feishu-submit.js';
import type { FeishuSubmission } from '../src/feishu-submit.js';

const CHAT_SUBMISSION = {
  kind: 'chat',
  sourceId: 'om_1',
  text: 'hello',
  attrs: {},
  anchor: { chatId: 'oc_1', messageId: 'om_1' },
} as unknown as FeishuSubmission;

function submitterWith(
  answer: FeishuCommandSubmitOutcome,
  live: () => boolean,
): FeishuTeamSubmitter {
  return new FeishuTeamSubmitter({
    lifecycle: { isLive: live } as never,
    cot: { beginInboundSubmission: () => null } as never,
    commands: {
      teamSubmit: async () => answer,
      dispatcherSubmit: async () => answer,
    } as never,
  });
}

describe('FeishuTeamSubmitter — a session that stops mid-flight', () => {
  it('answers not_attempted when Core fails after the lifecycle ended', async () => {
    // The lifecycle was live at entry, so the submit ran; by the time Core
    // answered, teardown had begun.
    let live = true;
    const submitter = submitterWith(
      { status: 'error', message: 'SERVER_SHUTTING_DOWN' },
      () => live,
    );
    const answering = submitter.submit('team-a', CHAT_SUBMISSION, null);
    live = false;

    await expect(answering).resolves.toEqual({
      status: 'not_attempted',
      reason: 'closed',
    });
  });

  it('answers not_attempted for a Core shutdown refusal even while live', async () => {
    // Core publishes its admission fence at the start of a dispatcher close,
    // and this session's own lifecycle is not aborted until much later. In
    // that window `isLive()` is still true, so the lifecycle cannot be the
    // signal — the code Core answered with is.
    const submitter = submitterWith(
      {
        status: 'error',
        message: "dispatcher 'd' is shutting down",
        code: 'SERVER_SHUTTING_DOWN',
      },
      () => true,
    );

    await expect(
      submitter.submit('team-a', CHAT_SUBMISSION, null),
    ).resolves.toEqual({ status: 'not_attempted', reason: 'closed' });
  });

  it('still reports a failure when the lifecycle is live', async () => {
    // The same Core answer with a healthy session is a real failure and has to
    // stay one.
    const submitter = submitterWith(
      { status: 'error', message: 'core is unavailable' },
      () => true,
    );

    await expect(
      submitter.submit('team-a', CHAT_SUBMISSION, null),
    ).resolves.toEqual({ status: 'error', message: 'core is unavailable' });
  });

  it('does not rewrite a Core decision when the lifecycle ended', async () => {
    // `rejected` is a decision Core made before admitting anything, and it is
    // still that decision whatever the session is doing; only a failure is
    // ambiguous enough to be the shutdown's.
    let live = true;
    const submitter = submitterWith(
      { status: 'rejected', code: 'TEAM_CLOSED', message: 'closed' },
      () => live,
    );
    const answering = submitter.submit('team-a', CHAT_SUBMISSION, null);
    live = false;

    await expect(answering).resolves.toEqual({
      status: 'rejected',
      code: 'TEAM_CLOSED',
      message: 'closed',
    });
  });
});
