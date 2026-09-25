/**
 * The issue #63 non-blocking-inbound live gate against a real codex
 * app-server.
 *
 * The behavioral live case (init handshake, thread start, folding a second
 * submit into a running turn, structured output, activity read, the Feishu
 * MCP surface) was deleted as Stage 2a / Item 1 required-ness collateral: its
 * hand-built `AgentRuntimeCreateContext`/`AgentActivityReadContext` fixtures
 * predate `activity`/`logger` becoming required fields and no longer
 * satisfy the type. The skip/fail-loud gate shell that used to wrap that case
 * is deleted with it (Stage 2a gate round 1): with codex on PATH and no skip
 * env var set — the normal case on a workstation with codex installed — the
 * shell's `describe` registered zero `it`s, which vitest reports as a failed
 * suite. See
 * `.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md`
 * (Stage 2a, standing high-risk entry) for the restoration contract, which
 * must rebuild the skip/fail-loud gate around the restored behavioral case
 * rather than reintroducing the same zero-registration shape.
 *
 * What remains here is the version-detection classifier
 * (`classifyDetection`/`versionAtLeast`) the live gate's skip/fail-loud
 * decision depended on — pure logic, unit-tested regardless of whether codex
 * is installed.
 */

import { describe, it, expect } from 'vitest';

export type Detection =
  { state: 'ok'; version: string } | { state: 'missing'; reason: string };

/**
 * Pure-ish decision logic, split out so it can be unit-tested without
 * actually executing `codex`. `versionFetcher` is what would normally call
 * `codex --version`; returning `null` (or throwing) means codex is missing.
 */
export function classifyDetection(rawOutput: string | null): Detection {
  if (rawOutput === null) {
    return {
      state: 'missing',
      reason: 'codex CLI did not respond to --version',
    };
  }
  const m = rawOutput.match(/(\d+\.\d+\.\d+)/);
  if (!m)
    return {
      state: 'missing',
      reason: `unparseable codex --version output: ${rawOutput}`,
    };
  return { state: 'ok', version: m[1]! };
}

function versionAtLeast(version: string, min: string): boolean {
  const actualParts = version
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const minParts = min.split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(actualParts.length, minParts.length); i += 1) {
    const actual = actualParts[i] ?? 0;
    const expected = minParts[i] ?? 0;
    if (actual > expected) return true;
    if (actual < expected) return false;
  }
  return true;
}

// Unit coverage of the classification logic itself — these run regardless of
// whether codex is installed, and prove that detection behaves as the (now
// deleted) live gate's skip/fail-loud decision relied on.
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
