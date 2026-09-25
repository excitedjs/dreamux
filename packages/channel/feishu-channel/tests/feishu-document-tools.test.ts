/**
 * The three document tools are one definition each, offered to both callers,
 * and the recipient is derived from the caller rather than named in an
 * argument. These tests pin exactly that: neither tool has a field with which
 * a caller could name another recipient.
 */
import { describe, expect, it } from 'vitest';

import {
  listSubscriptionsDef,
  subscribeDocumentDef,
  unsubscribeDocumentDef,
} from '../src/tools/document-tools.js';
import { findFeishuTool } from '../src/tools/registry.js';

describe('the document tools are one definition for both callers', () => {
  it.each(['subscribe_document', 'unsubscribe_document', 'list_subscriptions'])(
    '%s resolves to the same definition for either caller',
    (name) => {
      const forDispatcher = findFeishuTool(name, 'dispatcher');
      const forLeader = findFeishuTool(name, 'team_leader');
      expect(forDispatcher).toBeDefined();
      expect(forLeader).toBe(forDispatcher);
    },
  );

  it('no document tool accepts a field that would name another recipient', () => {
    for (const def of [
      subscribeDocumentDef,
      unsubscribeDocumentDef,
      listSubscriptionsDef,
    ]) {
      const properties = (
        def.inputSchema as {
          properties: Record<string, unknown>;
        }
      ).properties;
      expect(Object.keys(properties)).not.toContain('team_name');
    }
  });
});
