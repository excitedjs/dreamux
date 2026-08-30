/**
 * Absence guard for the minimize-provider-boundaries deleted surfaces
 * (`.agents/tasks/architecture/minimize-provider-boundaries/`).
 *
 * `@excitedjs/dreamux-types` is the contract surface external providers
 * compile against, so a surface this refactor deleted from Core's
 * implementation can still resurface here, silently, as a re-widened public
 * type. This is a literal text scan rather than a `keyof` check because most
 * entries below name a whole vocabulary (a routing concept, a persisted-state
 * shape, a command name) rather than one interface's member set — the other
 * test files in this package cover the member-level absences with `keyof`
 * equality instead (e.g. `AgentRuntime` being exactly start/submit/stop).
 *
 * Every pattern here was verified against current `src/` to have zero
 * legitimate hits before being added (see the node adjacent to this file's
 * commit): this list intentionally excludes tokens that collide with a
 * legitimate current field (`providerRef` is a legitimate
 * `AgentRuntimeProviderConfigReadContext` / `ProviderOnboardContext` field;
 * `duplicate` is legitimate prose and the public `TeamSubmitResult.status`
 * value) — those are covered by the targeted `keyof`/union tests instead.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = walk(srcRoot);

/**
 * Deleted-surface tokens with zero legitimate current use anywhere in
 * `src/`. Each is unique enough (a full removed method/field/vocabulary name)
 * that no plausible future doc sentence should need to spell it out either.
 */
const BANNED_TOKENS: readonly string[] = [
  // Pull-style AgentRuntime handle members the seam deliberately deleted.
  'waitIdle',
  'getCheckpoint',
  'wasCheckpointResumed',
  'getContext',
  'getStatus',
  // Transcript-reading surface replaced by readRecentActivity.
  'readTranscript',
  'transcript_locator',
  // Core Collaboration Space / target-routing vocabulary, now Channel-owned.
  'ChannelRoutes',
  'resolveTarget',
  'resolveInboundBinding',
  'messageBelongsToTarget',
  'target_key',
  'binding_fallbacks',
  // Retired Command / MCP names.
  'bind_channel',
  'transfer_back',
  'invoke_tool',
  'team_member',
  // Retired persisted-state filenames (host-owned; never a types-package concern).
  'name-claim.json',
  'team-create-requests.json',
  // Retired provenance/origin concepts.
  'ChannelOrigin',
  'turnOrigin',
  // Retired submitInput seam options.
  'reopenClosed',
  'AbortSignal',
  // Deleted RuntimeCompletion member.
  'displaySubmission',
  // Deleted AgentRuntimeSubmissionInput/turn-input discriminators.
  'channelInput',
  'completionInput',
];

describe('dreamux-types carries no minimize-provider-boundaries deleted surface', () => {
  for (const file of sourceFiles) {
    const relative = file.slice(srcRoot.length + 1);
    it(`${relative} references none of the deleted-surface tokens`, () => {
      const text = readFileSync(file, 'utf8');
      const hits = BANNED_TOKENS.filter((token) => text.includes(token));
      expect(hits).toEqual([]);
    });
  }

  it('ChannelSession never grows a reply/react shorthand method call', () => {
    // Belt-and-suspenders alongside the keyof check in
    // channel-provider-contract.test.ts: this greps for the call-site shape
    // specifically, in case a future member is named differently but is
    // still invoked as `.reply(` / `.react(` somewhere in this package.
    for (const file of sourceFiles) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/\.reply\(/);
      expect(text).not.toMatch(/\.react\(/);
    }
  });
});
