/**
 * Live integration test against a real codex app-server.
 *
 * Pinned to **codex 0.134.x** — the version family the dreamux MVP was
 * developed and verified against. This test exists to catch the exact two
 * compat bugs fixed in PR #5:
 *   - dropped `--approval-policy` flag (now `-c approval_policy=...`)
 *   - LSP-style `initialize` / `initialized` handshake required before
 *     any business RPC
 *
 * **Default behavior**: codex missing OR version doesn't match `0.134.x`
 * → the test FAILS loudly. The whole point is to verify compatibility; a
 * silent skip in CI defeats it.
 *
 * **Escape hatch**: set `DREAMUX_SKIP_LIVE_CODEX=1` to explicitly opt out
 * (e.g. dev machines without codex, or pre-merge sandboxes). The skip
 * emits a loud `console.warn` so it's visible in test output.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexProcess } from '../src/codex/supervisor.js';
import { CodexWsClient } from '../src/codex/rpc.js';
import { performInitializeHandshake } from '../src/codex/handshake.js';
import { codexArgsToCli, parseCodexArgs } from '../src/runtime/codex-args.js';
import type { ThreadStartResponse } from '../src/codex/types.js';

export const SKIP_ENV = 'DREAMUX_SKIP_LIVE_CODEX';
/** The version family this compat test pins. Bump deliberately when the dispatcher is verified against a newer codex line. */
export const TARGET_VERSION_RE = /^0\.134\./;
const TARGET_LABEL = '0.134.x';

export type Detection =
  | { state: 'ok'; version: string }
  | { state: 'missing'; reason: string }
  | { state: 'wrong-version'; version: string };

/**
 * Pure-ish decision logic, split out so it can be unit-tested without
 * actually executing `codex`. `versionFetcher` is what would normally call
 * `codex --version`; returning `null` (or throwing) means codex is missing.
 */
export function classifyDetection(
  rawOutput: string | null,
  regex: RegExp = TARGET_VERSION_RE,
): Detection {
  if (rawOutput === null) {
    return { state: 'missing', reason: 'codex CLI did not respond to --version' };
  }
  const m = rawOutput.match(/(\d+\.\d+\.\d+)/);
  if (!m) return { state: 'missing', reason: `unparseable codex --version output: ${rawOutput}` };
  const version = m[1]!;
  if (!regex.test(version)) {
    return { state: 'wrong-version', version };
  }
  return { state: 'ok', version };
}

function detectCodex(): Detection {
  let out: string;
  try {
    out = execSync('codex --version', {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { state: 'missing', reason };
  }
  return classifyDetection(out);
}

describe('codex 0.134 live integration', () => {
  const skipRequested = process.env[SKIP_ENV] === '1';
  const detection = detectCodex();

  if (skipRequested) {
    // Opt-in skip — loud so it can't be missed in CI / local output.
    console.warn(
      `[codex-0134-live] SKIPPED via ${SKIP_ENV}=1. ` +
        `Detected codex: state=${detection.state}` +
        (detection.state !== 'missing' ? ` version=${detection.version}` : '') +
        `. Real codex ${TARGET_LABEL} compatibility is NOT being verified by this run.`,
    );
    it.skip(`live integration skipped via ${SKIP_ENV}=1`, () => {
      /* skipped on purpose */
    });
    return;
  }

  if (detection.state === 'missing') {
    it(`requires codex ${TARGET_LABEL} on PATH (not installed)`, () => {
      throw new Error(
        `dreamux's codex compat test requires the codex CLI on PATH. ` +
          `Detection: ${detection.reason}. ` +
          `Install codex-cli ${TARGET_LABEL}, or set ${SKIP_ENV}=1 to explicitly opt out (loud skip).`,
      );
    });
    return;
  }

  if (detection.state === 'wrong-version') {
    it(`requires codex ${TARGET_LABEL} (found ${detection.version})`, () => {
      throw new Error(
        `dreamux's codex compat test pins ${TARGET_LABEL} but found ${detection.version}. ` +
          `Install the matching codex line (or bump TARGET_VERSION_RE if the dispatcher has been verified against a newer one), ` +
          `or set ${SKIP_ENV}=1 to explicitly opt out (loud skip).`,
      );
    });
    return;
  }

  // From here on we know codex is on PATH and reports a 0.134.x version.

  it(
    `spawns codex ${detection.version}, completes init handshake, starts a thread`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dreamux-e2e-'));
      const socketPath = join(dir, 'codex.sock');
      const cwd = join(dir, 'cwd');

      // Use the same parser the runtime uses — exercises the
      // `-c approval_policy=never` codepath end-to-end.
      const extraArgs = codexArgsToCli(parseCodexArgs('{}'));

      const proc = new CodexProcess({
        socketPath,
        cwd,
        stdoutLogPath: join(dir, 'stdout.log'),
        stderrLogPath: join(dir, 'stderr.log'),
        extraArgs,
        readyTimeoutMs: 15_000,
      });

      try {
        await proc.start();
        const client = new CodexWsClient({ socketPath });
        try {
          await client.ready();
          const init = await performInitializeHandshake(client);
          // userAgent shape is daemon-driven (in 0.134 it echoes the
          // client name into a long descriptor) — don't assert content
          // beyond non-empty string.
          expect(typeof init.userAgent).toBe('string');
          expect(init.userAgent.length).toBeGreaterThan(0);
          expect(init.platformOs).toBeDefined();

          // The real test: a business RPC after handshake must not get
          // "Not initialized". Response shape is the daemon's concern.
          const ts = await client.request<ThreadStartResponse>(
            'thread/start',
            {},
          );
          expect(typeof ts.thread.id).toBe('string');
          expect(ts.thread.id.length).toBeGreaterThan(0);
        } finally {
          client.close();
        }
      } finally {
        await proc.reap();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

// Unit coverage of the classification logic itself — these run regardless
// of whether codex is installed, and prove that the four detection
// branches (ok / missing / wrong-version / unparseable) actually behave
// as the live test above relies on.
describe('codex 0.134 detection logic', () => {
  it('classifies a matching version as ok', () => {
    expect(classifyDetection('codex-cli 0.134.0')).toEqual({
      state: 'ok',
      version: '0.134.0',
    });
    expect(classifyDetection('codex-cli 0.134.17')).toEqual({
      state: 'ok',
      version: '0.134.17',
    });
  });

  it('classifies an older or newer codex line as wrong-version', () => {
    expect(classifyDetection('codex-cli 0.133.5')).toEqual({
      state: 'wrong-version',
      version: '0.133.5',
    });
    expect(classifyDetection('codex-cli 0.135.0')).toEqual({
      state: 'wrong-version',
      version: '0.135.0',
    });
    expect(classifyDetection('codex-cli 1.0.0')).toEqual({
      state: 'wrong-version',
      version: '1.0.0',
    });
  });

  it('classifies missing/unparseable inputs as missing', () => {
    expect(classifyDetection(null).state).toBe('missing');
    expect(classifyDetection('not a version string').state).toBe('missing');
    expect(classifyDetection('').state).toBe('missing');
  });
});
