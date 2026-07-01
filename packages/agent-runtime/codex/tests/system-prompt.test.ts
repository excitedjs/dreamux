import { describe, expect, it } from 'vitest';

import {
  codexSystemPromptAppend,
  codexSystemPromptReplace,
} from '../src/provider.js';
import { renderCodexSystemPromptAppend } from '../src/runtime-support.js';

describe('Codex systemPrompt mapping', () => {
  it('uses replacement prompt when present', () => {
    expect(
      codexSystemPromptReplace({
        replace: 'complete base prompt',
        append: ['role delta'],
      }),
    ).toBe('complete base prompt');
  });

  it('keeps append-only prompt out of baseInstructions', () => {
    expect(codexSystemPromptReplace({ append: ['architecture reviewer'] }))
      .toBeUndefined();
    expect(codexSystemPromptAppend({ append: ['architecture reviewer'] }))
      .toEqual(['architecture reviewer']);
  });

  it('treats empty append arrays and empty append items as no append', () => {
    expect(codexSystemPromptAppend({ append: [] })).toBeUndefined();
    expect(codexSystemPromptAppend({ append: ['', ''] })).toBeUndefined();
    expect(codexSystemPromptAppend({ append: ['', 'role delta'] })).toEqual([
      'role delta',
    ]);
  });

  it('does not duplicate dispatcher append when replacement prompt is present', () => {
    const prompt = {
      replace: 'complete base prompt',
      append: ['same dispatcher prompt as append guidance'],
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

  it('wraps each append item separately and escapes XML text', () => {
    expect(
      renderCodexSystemPromptAppend([
        'Default TeamLeader identity.',
        'Use <danger> & never close </developer-reminder>',
      ]),
    ).toBe(
      '<developer-reminder>\n' +
        'Default TeamLeader identity.\n' +
        '</developer-reminder>\n\n' +
        '<developer-reminder>\n' +
        'Use &lt;danger&gt; &amp; never close &lt;/developer-reminder&gt;\n' +
        '</developer-reminder>',
    );
  });
});
