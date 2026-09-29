/**
 * The reply tool's contract: three fields, a body that reaches Feishu exactly
 * as written, and a platform refusal the model can act on.
 *
 * Mentions are no longer a separate argument — they are written in the body in
 * Feishu's own syntax — so the schema is the place that has to stay closed.
 */
import { describe, expect, it } from 'vitest';

import { findFeishuTool } from '../src/tools/registry.js';

describe('the reply tool contract', () => {
  it('takes exactly chat_id, message_id and text', () => {
    const def = findFeishuTool('reply', 'team_leader');
    const schema = def?.inputSchema as {
      properties: Record<string, { description?: string }>;
      required: string[];
      additionalProperties: boolean;
    };

    expect(Object.keys(schema.properties).sort()).toEqual([
      'chat_id',
      'message_id',
      'text',
    ]);
    expect(schema.required.sort()).toEqual(['chat_id', 'text']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties['text']?.description).toContain(
      '<at user_id="ou_example">Example</at>',
    );
  });

  it('carries nothing beyond those three fields into the session call', () => {
    const def = findFeishuTool('reply', 'team_leader');

    // The closed schema is what refuses an unknown argument upstream; parsing
    // additionally keeps one from reaching the send path if it ever did.
    expect(
      def?.parse({
        chat_id: 'oc_chat',
        text: 'hi',
        mention_user_ids: ['ou_example'],
      }),
    ).toEqual({ chatId: 'oc_chat', text: 'hi' });
  });
});
