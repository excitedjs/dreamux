/**
 * The four Collaboration Space MCP tools are Channel-owned and Dispatcher-only
 * (COVERAGE CELL F). They read and write nothing but this Channel's own
 * `FeishuSpaceRecord` policy rows through `FeishuToolSession`; no Core
 * Collaboration Space state, Command, event, or type is referenced anywhere
 * in this module — the whole capability is a plain read/write over a Feishu
 * record projected into a stable wire shape.
 */
import { describe, expect, it } from 'vitest';

import {
  bindSpaceDef,
  getSpaceDef,
  listSpacesDef,
  unbindSpaceDef,
} from '../src/tools/space-tools.js';

describe('Collaboration Space tools — Dispatcher-only catalog', () => {
  it('none of the four tools are ever offered to a TeamLeader', () => {
    for (const def of [bindSpaceDef, unbindSpaceDef, getSpaceDef, listSpacesDef]) {
      expect(def.callers).toEqual(['dispatcher']);
      expect(def.callers).not.toContain('team_leader');
    }
  });
});
