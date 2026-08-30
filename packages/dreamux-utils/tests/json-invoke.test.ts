/**
 * The transport-neutral JSON invoke request/result boundary (json-invoke.ts).
 *
 * Per the operator decision this shared infrastructure must know no Command
 * name, MCP tool, Team, or Channel — assert that neutrality via a source-text
 * scan (appropriate here because absence of those vocabulary tokens IS the
 * contract), plus the actual round-trip and failure-classification behavior.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { PublicInvokeFailure, settleJsonInvoke } from '../src/json-invoke.js';

describe('settleJsonInvoke', () => {
  it('settles a successful body as { ok: true, value }', async () => {
    const result = await settleJsonInvoke(async () => ({ hello: 'world' }));
    expect(result).toEqual({ ok: true, value: { hello: 'world' } });
  });

  it('turns a thrown PublicInvokeFailure into { ok: false, message }', async () => {
    const result = await settleJsonInvoke(async () => {
      throw new PublicInvokeFailure('bad argument: missing id');
    });
    expect(result).toEqual({ ok: false, message: 'bad argument: missing id' });
  });

  it('lets an unrelated thrown error propagate rather than being swallowed into ok:false', async () => {
    // A failure nobody decided to publish is not a result — the boundary must
    // NOT convert an unexpected bug into a settled outcome.
    const bug = new TypeError('unexpected null');
    await expect(
      settleJsonInvoke(async () => {
        throw bug;
      }),
    ).rejects.toBe(bug);
  });

  it('classifies strictly by instanceof, not by error.name lookalike', async () => {
    // A hand-built object merely named "PublicInvokeFailure" must still
    // propagate — unlike unsupported-feature.ts's deliberately structural
    // marker, this boundary's marker is instanceof-checked and never crosses
    // the package edge, so a lookalike from elsewhere must NOT be treated as
    // a decided refusal.
    const lookalike = Object.assign(new Error('looks like a refusal'), {
      name: 'PublicInvokeFailure',
    });
    await expect(
      settleJsonInvoke(async () => {
        throw lookalike;
      }),
    ).rejects.toBe(lookalike);
  });

  it('propagates a rejection that is not an Error instance at all', async () => {
    await expect(
      settleJsonInvoke(async () => {
        // Deliberately rejects with a non-Error value: the contract is that
        // settleJsonInvoke propagates it untouched rather than wrapping it.
        throw 'a plain string rejection';
      }),
    ).rejects.toBe('a plain string rejection');
  });
});

describe('PublicInvokeFailure', () => {
  it('is a real Error carrying the given message and a stable name', () => {
    const failure = new PublicInvokeFailure('nope');
    expect(failure).toBeInstanceOf(Error);
    expect(failure.name).toBe('PublicInvokeFailure');
    expect(failure.message).toBe('nope');
  });
});

describe('json-invoke.ts source neutrality (issue #209 operator decision)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, '..', 'src', 'json-invoke.ts'), 'utf8');

  it('imports only @excitedjs/dreamux-types, never a host/Core/domain package', () => {
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*import /.test(line));
    expect(importLines).toHaveLength(1);
    expect(importLines[0]).toContain('@excitedjs/dreamux-types');
  });

  it('names no Command, MCP tool, Team, or Channel vocabulary anywhere in the file', () => {
    // Whole-token, case-sensitive scan so this stays unambiguous the same way
    // dreamux-types' no-host-types guard does — a match here means the
    // transport-neutral boundary was leaked into.
    const forbiddenTokens = ['Command', 'MCP', 'Team', 'Channel'];
    for (const token of forbiddenTokens) {
      const pattern = new RegExp(`\\b${token}\\b`);
      expect(source, `source must not mention "${token}"`).not.toMatch(pattern);
    }
  });
});
