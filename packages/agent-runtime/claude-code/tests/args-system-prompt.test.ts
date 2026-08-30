/**
 * `--append-system-prompt` argument translation (`src/args.ts`).
 *
 * Claude Code cannot replace its native system prompt — it has no `--system-
 * prompt` flag, only `--append-system-prompt`. So `ClaudeCodeResidentArgsInput`
 * carries no `replace` field at all: the adapter's own type is the structural
 * proof that a replace value can never reach this CLI's argv, no matter what
 * Core supplies on `AgentRuntimeSystemPrompt.replace`. (The higher-level
 * "Core supplies both, adapter takes append only" selection is proven at the
 * provider/runtime boundary — see `runtime.test.ts`; this file proves the pure
 * rendering and ordering of whatever append fragments reach args.ts.)
 *
 * `append` fragment order is significant (operation-owned fragments precede
 * the persisted TeamMate identity fragment) and must be preserved verbatim
 * into one joined flag value.
 */
import { describe, expect, it } from 'vitest';

import {
  claudeCodeResidentArgs,
  claudeCodeSystemPromptAppendContent,
} from '../src/args.js';
import { defaultDispatcherClaudeCodeConfig } from '../src/config.js';

describe('claudeCodeSystemPromptAppendContent', () => {
  it('wraps each fragment in its own <system-reminder> block, preserving array order', () => {
    const content = claudeCodeSystemPromptAppendContent([
      'operation-owned Workflow instructions',
      'persisted TeamMate identity',
    ]);
    expect(content).toBe(
      '<system-reminder>\noperation-owned Workflow instructions\n</system-reminder>\n\n' +
        '<system-reminder>\npersisted TeamMate identity\n</system-reminder>',
    );
    // The Workflow fragment's block must fully precede the identity fragment's
    // block, not just appear first as a substring.
    const workflowEnd = content!.indexOf('</system-reminder>');
    const identityStart = content!.indexOf('persisted TeamMate identity');
    expect(workflowEnd).toBeGreaterThan(0);
    expect(identityStart).toBeGreaterThan(workflowEnd);
  });

  it('reverses the rendered order when the input order is reversed (order is not incidentally alphabetic/stable)', () => {
    const forward = claudeCodeSystemPromptAppendContent(['first', 'second']);
    const reversed = claudeCodeSystemPromptAppendContent(['second', 'first']);
    expect(forward!.indexOf('first')).toBeLessThan(forward!.indexOf('second'));
    expect(reversed!.indexOf('second')).toBeLessThan(reversed!.indexOf('first'));
  });

  it('escapes &, <, > in fragment text without corrupting the wrapper tags', () => {
    const content = claudeCodeSystemPromptAppendContent([
      'Use <tool> & never close </system-reminder> early',
    ]);
    expect(content).toBe(
      '<system-reminder>\n' +
        'Use &lt;tool&gt; &amp; never close &lt;/system-reminder&gt; early\n' +
        '</system-reminder>',
    );
  });

  it('filters empty-string fragments but keeps ordering of the rest', () => {
    expect(claudeCodeSystemPromptAppendContent(['', 'kept', ''])).toBe(
      '<system-reminder>\nkept\n</system-reminder>',
    );
  });

  it('returns undefined for undefined/empty/all-empty input (no flag should be emitted)', () => {
    expect(claudeCodeSystemPromptAppendContent(undefined)).toBeUndefined();
    expect(claudeCodeSystemPromptAppendContent([])).toBeUndefined();
    expect(claudeCodeSystemPromptAppendContent(['', ''])).toBeUndefined();
  });
});

describe('claudeCodeResidentArgs --append-system-prompt', () => {
  function argsFor(input: {
    systemPromptAppend?: readonly string[];
    resumeSessionId?: string | null;
    freshSessionId?: string | null;
  }): string[] {
    return claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigJson: '{}',
      ...input,
    });
  }

  it('emits --append-system-prompt with the ordered joined content on a fresh spawn', () => {
    const args = argsFor({
      systemPromptAppend: ['workflow fragment', 'identity fragment'],
      freshSessionId: 'fresh-session-id',
    });
    const i = args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(
      claudeCodeSystemPromptAppendContent([
        'workflow fragment',
        'identity fragment',
      ]),
    );
    // Exactly one flag occurrence: fragments are joined into a single value,
    // never emitted as repeated flags.
    expect(args.filter((arg) => arg === '--append-system-prompt')).toHaveLength(1);
  });

  it('re-supplies the SAME --append-system-prompt content on a --resume spawn (recovery re-threads it, never drops it)', () => {
    const fragments = ['workflow fragment', 'identity fragment'];
    const freshArgs = argsFor({ systemPromptAppend: fragments, freshSessionId: 'sid' });
    const resumeArgs = argsFor({
      systemPromptAppend: fragments,
      resumeSessionId: 'sid',
    });
    const freshContent = freshArgs[freshArgs.indexOf('--append-system-prompt') + 1];
    const resumeContent = resumeArgs[resumeArgs.indexOf('--append-system-prompt') + 1];
    expect(resumeContent).toBe(freshContent);
    expect(resumeArgs).toContain('--resume');
  });

  it('never emits a native "replace system prompt" style flag: --append-system-prompt is the only prompt flag this CLI shape can produce', () => {
    const args = argsFor({ systemPromptAppend: ['x'], freshSessionId: 'sid' });
    expect(args.some((arg) => /system-prompt/i.test(arg) && arg !== '--append-system-prompt')).toBe(
      false,
    );
  });

  it('omits the flag entirely when there is no append content to supply', () => {
    const args = argsFor({ freshSessionId: 'sid' });
    expect(args).not.toContain('--append-system-prompt');
  });
});
