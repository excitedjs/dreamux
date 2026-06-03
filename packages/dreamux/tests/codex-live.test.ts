/**
 * Live integration test against a real codex app-server.
 *
 * CI installs `@openai/codex@latest` before this test runs. Local developer
 * machines use whatever `codex` is on PATH. This test exists to catch the
 * two compat bugs fixed in PR #5 plus the serve-foundation shape:
 *   - dropped `--approval-policy` flag (now `-c approval_policy=...`)
 *   - LSP-style `initialize` / `initialized` handshake required before
 *     any business RPC
 *   - app-server listen socket must not live under `/tmp`
 *   - app-server startup must use a network-enabled sandbox/profile
 *
 * **Default behavior**: missing/unparseable `codex --version` fails loudly.
 * The whole point is to verify compatibility; a silent skip in CI defeats it.
 *
 * **Escape hatch**: set `DREAMUX_SKIP_LIVE_CODEX=1` to explicitly opt out
 * (e.g. dev machines without codex, or pre-merge sandboxes). The skip
 * emits a loud `console.warn` so it's visible in test output.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { CodexProcess } from '../src/codex/supervisor.js';
import { CodexWsClient } from '../src/codex/rpc.js';
import { performInitializeHandshake } from '../src/codex/handshake.js';
import { feishuMcpCodexArgs } from '../src/codex/mcp-config.js';
import { codexArgsToCli, parseCodexArgs } from '../src/runtime/codex-args.js';
import { dreamuxBinPath } from '../src/runtime/package-bin.js';
import type { ThreadStartResponse } from '../src/codex/types.js';

export const SKIP_ENV = 'DREAMUX_SKIP_LIVE_CODEX';

export type Detection =
  | { state: 'ok'; version: string }
  | { state: 'missing'; reason: string };

/**
 * Pure-ish decision logic, split out so it can be unit-tested without
 * actually executing `codex`. `versionFetcher` is what would normally call
 * `codex --version`; returning `null` (or throwing) means codex is missing.
 */
export function classifyDetection(
  rawOutput: string | null,
): Detection {
  if (rawOutput === null) {
    return { state: 'missing', reason: 'codex CLI did not respond to --version' };
  }
  const m = rawOutput.match(/(\d+\.\d+\.\d+)/);
  if (!m) return { state: 'missing', reason: `unparseable codex --version output: ${rawOutput}` };
  return { state: 'ok', version: m[1]! };
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

function versionAtLeast(version: string, min: string): boolean {
  const actualParts = version.split('.').map((part) => Number.parseInt(part, 10));
  const minParts = min.split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(actualParts.length, minParts.length); i += 1) {
    const actual = actualParts[i] ?? 0;
    const expected = minParts[i] ?? 0;
    if (actual > expected) return true;
    if (actual < expected) return false;
  }
  return true;
}

interface McpServerStatusListResponse {
  data: Array<{
    name: string;
    tools?: Record<string, { name: string }>;
  }>;
}

describe('codex live integration', () => {
  const skipRequested = process.env[SKIP_ENV] === '1';
  const detection = detectCodex();

  if (skipRequested) {
    // Opt-in skip — loud so it can't be missed in CI / local output.
    console.warn(
      `[codex-live] SKIPPED via ${SKIP_ENV}=1. ` +
        `Detected codex: state=${detection.state}` +
        (detection.state === 'ok' ? ` version=${detection.version}` : '') +
        `. Real codex app-server compatibility is NOT being verified by this run.`,
    );
    it.skip(`live integration skipped via ${SKIP_ENV}=1`, () => {
      /* skipped on purpose */
    });
    return;
  }

  if (detection.state === 'missing') {
    it('requires codex on PATH', () => {
      throw new Error(
        `dreamux's codex compat test requires the codex CLI on PATH. ` +
          `Detection: ${detection.reason}. ` +
          `Install @openai/codex@latest, or set ${SKIP_ENV}=1 to explicitly opt out (loud skip).`,
      );
    });
    return;
  }

  // From here on we know codex is on PATH and reports a parseable version.

  it(
    `spawns codex ${detection.version}, completes init handshake, starts a thread`,
    async () => {
      const dir = mkdtempSync(join(homedir(), '.dreamux-e2e-'));
      const socketPath = join(dir, 'codex.sock');
      const cwd = join(dir, 'cwd');

      // Use the same parser the runtime uses — exercises the
      // `-c approval_policy=never` codepath end-to-end.
      const extraArgs = codexArgsToCli(
        parseCodexArgs('{"sandboxMode":"danger-full-access"}'),
      );

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
          // userAgent shape is daemon-driven (older lines echoed the
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

  it(
    `spawns codex ${detection.version} with the Feishu stdio MCP shim`,
    async () => {
      if (!versionAtLeast(detection.version, '0.136.0')) {
        throw new Error(
          `dreamux's Feishu MCP injection gate requires codex >= 0.136.0; detected ${detection.version}`,
        );
      }

      const dreamuxBin = dreamuxBinPath();
      if (!isAbsolute(dreamuxBin) || !existsSync(dreamuxBin)) {
        throw new Error(
          `dreamux Feishu MCP live test requires an absolute built dreamux bin path; got ${dreamuxBin}`,
        );
      }

      const dir = mkdtempSync(join(homedir(), '.dreamux-e2e-'));
      const socketPath = join(dir, 'codex.sock');
      const cwd = join(dir, 'cwd');
      const extraArgs = [
        ...codexArgsToCli(
          parseCodexArgs('{"sandboxMode":"danger-full-access"}'),
        ),
        ...feishuMcpCodexArgs({
          dispatcherId: 'dispatcher-a',
          adminSocketPath: join(dir, 'admin.sock'),
          command: dreamuxBin,
        }),
      ];

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
          await performInitializeHandshake(client);
          const status = await client.request<McpServerStatusListResponse>(
            'mcpServerStatus/list',
            {},
          );
          const feishu = status.data.find((server) => server.name === 'feishu');
          expect(feishu).toBeDefined();
          expect(feishu?.tools?.['reply']?.name).toBe('reply');
          expect(feishu?.tools?.['react']?.name).toBe('react');
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

// Unit coverage of the classification logic itself — these run regardless of
// whether codex is installed, and prove that detection behaves as the live
// test above relies on.
describe('codex detection logic', () => {
  it('classifies parseable versions as ok', () => {
    expect(classifyDetection('codex-cli 0.135.0')).toEqual({
      state: 'ok',
      version: '0.135.0',
    });
    expect(classifyDetection('codex-cli 0.136.0')).toEqual({
      state: 'ok',
      version: '0.136.0',
    });
    expect(classifyDetection('codex-cli 1.0.0')).toEqual({
      state: 'ok',
      version: '1.0.0',
    });
  });

  it('classifies missing/unparseable inputs as missing', () => {
    expect(classifyDetection(null).state).toBe('missing');
    expect(classifyDetection('not a version string').state).toBe('missing');
    expect(classifyDetection('').state).toBe('missing');
  });

  it('compares codex semver versions', () => {
    expect(versionAtLeast('0.136.0', '0.136.0')).toBe(true);
    expect(versionAtLeast('0.137.0', '0.136.0')).toBe(true);
    expect(versionAtLeast('0.135.9', '0.136.0')).toBe(false);
  });
});
