import { describe, expect, it } from 'vitest';

import { codexSystemPromptReplace } from '../src/provider.js';

describe('Codex systemPrompt mapping', () => {
  it('uses replacement prompt when present', () => {
    expect(
      codexSystemPromptReplace({
        replace: 'complete base prompt',
        append: 'role delta',
      }),
    ).toBe('complete base prompt');
  });

  it('rejects append-only prompt instead of passing it as baseInstructions', () => {
    expect(() =>
      codexSystemPromptReplace({ append: 'architecture reviewer' }),
    ).toThrow(/append-only systemPrompt/);
  });
});
