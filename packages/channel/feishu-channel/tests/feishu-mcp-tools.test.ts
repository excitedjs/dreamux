import { describe, expect, it } from 'vitest';

import {
  FEISHU_TOOLS,
  buildToolCatalog,
  parseFeishuMcpToolInput,
} from '../src/index.js';

describe('Feishu MCP tool surface', () => {
  it('does not expose pairing approval as an access MCP tool', () => {
    expect(FEISHU_TOOLS.map((tool) => tool.name)).toEqual([
      'reply',
      'react',
      'list_chat_bots',
    ]);
    expect(buildToolCatalog().map((tool) => tool.name)).not.toContain('access');
    expect(() =>
      parseFeishuMcpToolInput('access', { code: '<PAIRING_TOKEN_HEX>' }),
    ).toThrow(/unknown Feishu tool 'access'/);
  });
});
