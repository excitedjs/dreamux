import { describe, expect, it } from 'vitest';

import {
  codexSystemPromptAppend,
  codexSystemPromptReplace,
} from '../src/provider.js';

describe('Codex systemPrompt mapping', () => {
  it('uses replacement prompt when present', () => {
    expect(
      codexSystemPromptReplace({
        replace: 'complete base prompt',
        append: 'role delta',
      }),
    ).toBe('complete base prompt');
  });

  it('keeps append-only prompt out of baseInstructions', () => {
    expect(codexSystemPromptReplace({ append: 'architecture reviewer' }))
      .toBeUndefined();
    expect(codexSystemPromptAppend({ append: 'architecture reviewer' }))
      .toBe('architecture reviewer');
  });

  it('does not duplicate dispatcher append when replacement prompt is present', () => {
    const prompt = {
      replace: 'complete base prompt',
      append: 'same dispatcher prompt as append guidance',
    };
    expect(codexSystemPromptReplace(prompt)).toBe('complete base prompt');
    expect(codexSystemPromptAppend(prompt)).toBeUndefined();
  });

  it('uses replace-only prompt as baseInstructions', () => {
    expect(codexSystemPromptReplace({ replace: 'complete base prompt' }))
      .toBe('complete base prompt');
    expect(codexSystemPromptAppend({ replace: 'complete base prompt' }))
      .toBeUndefined();
  });
});
