/**
 * Authorization for `bind_channel`/`unbind_channel`/`list_bindings` is two
 * disjoint tool definitions per name, not one definition branching on caller
 * (COVERAGE CELL F, TeamLeader failure ledger item 21: a capability move must
 * not silently drop TeamLeader self-bind/self-release).
 *
 * The Dispatcher definitions accept an arbitrary `team_name` and reach every
 * route. The TeamLeader definitions have no `team_name` field in their input
 * schema at all — `leaseTeamName` derives the Team from the caller the MCP
 * lease already bound, and passes it as `requireOwner`, so the TeamLeader
 * handler can only ever act on routes that are free or already its own.
 */
import { describe, expect, it } from 'vitest';

import {
  bindChannelDef,
  leaderBindChannelDef,
  leaderUnbindChannelDef,
  listBindingsDef,
  unbindChannelDef,
} from '../src/tools/routing-tools.js';

describe('bind_channel — Dispatcher vs TeamLeader are disjoint definitions', () => {
  it('the TeamLeader input schema has no team_name property at all', () => {
    const props = (
      leaderBindChannelDef.inputSchema as {
        properties: Record<string, unknown>;
      }
    ).properties;
    expect(Object.hasOwn(props, 'team_name')).toBe(false);
    // The Dispatcher schema does require one.
    const dispatcherProps = bindChannelDef.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(dispatcherProps.required).toContain('team_name');
  });

  it('only the Dispatcher catalog advertises bind_channel/unbind_channel/list_bindings', () => {
    expect(bindChannelDef.callers).toEqual(['dispatcher']);
    expect(unbindChannelDef.callers).toEqual(['dispatcher']);
    expect(listBindingsDef.callers).toEqual(['dispatcher']);
    expect(leaderBindChannelDef.callers).toEqual(['team_leader']);
    expect(leaderUnbindChannelDef.callers).toEqual(['team_leader']);
  });
});

describe('unbind_channel — TeamLeader self-release', () => {
  it('the TeamLeader input schema has no team_name property', () => {
    const props = (
      leaderUnbindChannelDef.inputSchema as {
        properties: Record<string, unknown>;
      }
    ).properties;
    expect(Object.hasOwn(props, 'team_name')).toBe(false);
  });
});

describe('list_bindings — query parameters narrow one table read', () => {
  it('rejects a target_kind no binding can be installed with, naming what is accepted', () => {
    expect(() => listBindingsDef.parse({ target_kind: 'p2p' })).toThrow(
      /target_kind must be one of: group, topic/,
    );
  });

  it('advertises the four filters as optional', () => {
    const schema = listBindingsDef.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual([
      'team_name',
      'chat_id',
      'thread_id',
      'target_kind',
    ]);
    expect(schema.required).toEqual([]);
  });
});
