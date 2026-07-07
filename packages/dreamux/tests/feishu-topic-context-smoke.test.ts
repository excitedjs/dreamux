import { describe, expect, it } from 'vitest';

import { runFeishuTopicContextSmoke } from '../src/dev/feishu-topic-context-smoke.js';

describe('Feishu topic context smoke', () => {
  it('routes distinct topic targets to isolated dispatcher runtimes', async () => {
    const result = await runFeishuTopicContextSmoke();

    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual(['a-1', 'a-2', 'b-1', 'a-3']);
    expect(result.globalRuntimeIds).toHaveLength(2);
    expect(result.targetRuntimeIds).toHaveLength(3);
    expect(Object.values(result.targetInputs)).toEqual(
      expect.arrayContaining([
        ['a-1', 'a-2'],
        ['b-1'],
        ['a-3'],
      ]),
    );
    expect(result.resumedRuntimeIds.length).toBeGreaterThanOrEqual(2);
  });
});
