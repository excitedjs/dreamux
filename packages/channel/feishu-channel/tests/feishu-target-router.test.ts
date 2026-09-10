/**
 * The observed-message ledger: which target this session files a message under.
 *
 * A reply is addressed by message id and Feishu threads it; the ledger's job is
 * the other half — naming the place the reply landed in, so a later reply to
 * *it* is filed there too. That place is read from the message replied to, and
 * only when it is in the chat the caller named: a stale or copied id must not
 * quietly move a conversation somewhere else.
 */
import { describe, expect, it } from 'vitest';

import { FeishuTargetRouter } from '../src/feishu-target-router.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';

const silent = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

function router(): FeishuTargetRouter {
  return new FeishuTargetRouter({ chatModes: {}, log: silent });
}

describe('the target an outbound message is filed under', () => {
  it('follows the named message into its topic', () => {
    const r = router();
    r.observe('om_asked', topicTarget('oc_room', 'omt_thread'));

    expect(r.outboundTarget('oc_room', 'om_asked')).toEqual(
      topicTarget('oc_room', 'omt_thread'),
    );
  });

  it('names the chat itself when no message is named', () => {
    const r = router();
    r.observe('om_asked', topicTarget('oc_room', 'omt_thread'));

    expect(r.outboundTarget('oc_room', undefined)).toEqual(
      chatTarget('oc_room', 'group'),
    );
  });

  it('ignores a message from another chat rather than following it there', () => {
    const r = router();
    r.observe('om_elsewhere', topicTarget('oc_other', 'omt_thread'));

    // Deliberate: a stale or copied id must not file a message meant for one
    // conversation under another. The named chat wins.
    expect(r.outboundTarget('oc_room', 'om_elsewhere')).toEqual(
      chatTarget('oc_room', 'group'),
    );
  });
});
