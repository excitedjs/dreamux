import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  detectLegacyDispatcherState,
  legacyDispatcherStateMessage,
} from '../src/service/legacy-state.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import {
  ChannelBindingStore,
  detectLegacyChannelBindingStore,
} from '../src/service/channel-binding/store.js';
import { detectAmbiguousV2ChannelBindingRoutes } from '../src/service/channel-binding/preflight.js';
import {
  dispatcherAgentIdentityPath,
  dispatcherChannelBindingsPath,
  dispatcherCollaborationSpacesPath,
  dispatcherTeamDir,
  dispatcherTeamMateDir,
  resetRuntimeConfig,
} from '../src/platform/paths.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';

const DISPATCHER = 'flow';
const silentLog: DreamuxLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

/** The #233 per-entity identity path for a dispatcher-owned teammate. */
function teammateIdentityPath(name: string): string {
  return dispatcherAgentIdentityPath({
    dispatcherId: DISPATCHER,
    name,
    teamId: null,
    role: 'teammate',
  });
}

function writeRaw(path: string, raw: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

describe('issue #199 Slice 5 — pre-#199 local state fails loud', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-legacy-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  describe('detectLegacyDispatcherState (removed state paths)', () => {
    it('reports nothing when only the current layout is present', async () => {
      writeRaw(teammateIdentityPath('solo'), { version: 1 });
      expect(await detectLegacyDispatcherState(DISPATCHER)).toEqual([]);
    });

    it.each([
      ['teammate/identities', () => join(dispatcherTeamMateDir(DISPATCHER), 'identities', 'x.json')],
      ['teammate/sessions.jsonl', () => join(dispatcherTeamMateDir(DISPATCHER), 'sessions.jsonl')],
      ['teammate/history', () => join(dispatcherTeamMateDir(DISPATCHER), 'history', 'x.jsonl')],
      ['team/ledger', () => join(dispatcherTeamDir(DISPATCHER), 'ledger', 'x.jsonl')],
      // #233: the flat Phase-1 leaves replaced by the per-entity directory layout.
      ['teammate/records', () => join(dispatcherTeamMateDir(DISPATCHER), 'records', 'x.json')],
      ['teammate/turns', () => join(dispatcherTeamMateDir(DISPATCHER), 'turns', 'x.jsonl')],
      ['team/records', () => join(dispatcherTeamDir(DISPATCHER), 'records', 'x.json')],
      ['team/channel-bindings.json', () => join(dispatcherTeamDir(DISPATCHER), 'channel-bindings.json')],
    ])('detects the removed %s path', async (_label, makePath) => {
      writeRaw(makePath(), { stale: true });
      const findings = await detectLegacyDispatcherState(DISPATCHER);
      expect(findings).toHaveLength(1);
      // Message names the path and tells the operator to delete it (0.x rebuild).
      const message = legacyDispatcherStateMessage(DISPATCHER, findings);
      expect(message).toContain(findings[0]!.path);
      expect(message).toMatch(/does not migrate old state/);
      expect(message).toMatch(/Delete/);
    });

    it('aggregates multiple removed paths', async () => {
      writeRaw(join(dispatcherTeamMateDir(DISPATCHER), 'sessions.jsonl'), {});
      writeRaw(join(dispatcherTeamDir(DISPATCHER), 'ledger', 'team.jsonl'), {});
      expect(await detectLegacyDispatcherState(DISPATCHER)).toHaveLength(2);
    });
  });

  describe('teammate record reader rejects pre-#199 fields', () => {
    const base = {
      version: 1,
      dispatcher_id: DISPATCHER,
      name: 'alice',
      agent_runtime: 'codex',
      cwd: '/tmp/work',
    };

    it.each(['checkpoint', 'checkpoint_kind', 'session_ref', 'display_name', 'close_status'])(
      'fails loud on the removed %s field',
      async (field) => {
        writeRaw(teammateIdentityPath('alice'), {
          ...base,
          [field]: 'legacy',
        });
        const store = new AgentIdentityStore(silentLog);
        await expect(store.get(DISPATCHER, 'alice')).rejects.toThrow(
          new RegExp(`removed in issue #199 \\(${field}\\)`),
        );
      },
    );

    it('reads a clean record without complaint', async () => {
      writeRaw(teammateIdentityPath('alice'), base);
      const store = new AgentIdentityStore(silentLog);
      const identity = await store.get(DISPATCHER, 'alice');
      expect(identity?.name).toBe('alice');
      expect(identity?.skill_sources).toEqual([]);
    });

    it('fails loud (does NOT skip) on the list() path for a removed-field record', async () => {
      // A clean record + a stale one: list() must not silently drop the stale
      // record (which would hide it from teammate.list / teammate.history); it
      // re-throws the legacy-state error.
      writeRaw(teammateIdentityPath('alice'), base);
      writeRaw(teammateIdentityPath('stale'), {
        ...base,
        name: 'stale',
        checkpoint: null,
      });
      const store = new AgentIdentityStore(silentLog);
      await expect(store.list(DISPATCHER)).rejects.toThrow(/removed in issue #199/);
    });

    it('still tolerates a genuinely unreadable (non-legacy) record in list()', async () => {
      // Resilience is preserved for corrupt JSON: it warns + skips, only the
      // good record is returned. Old-state detection must not over-reach into
      // every read failure.
      writeRaw(teammateIdentityPath('alice'), base);
      const brokenPath = teammateIdentityPath('broken');
      mkdirSync(dirname(brokenPath), { recursive: true });
      writeFileSync(brokenPath, '{ not json', { mode: 0o600 });
      const store = new AgentIdentityStore(silentLog);
      const names = (await store.list(DISPATCHER)).map((identity) => identity.name);
      expect(names).toEqual(['alice']);
    });
  });

  describe('channel-binding reader reuses compatible v2 stores (#209 binding store v3)', () => {
    it('fails loud on a version 1 store without routing-key columns', async () => {
      // The old store was version 1, keyed by (provider, chat_id) with no
      // channel_id / target_key. 0.x does not migrate it.
      writeRaw(dispatcherChannelBindingsPath(DISPATCHER), {
        version: 1,
        bindings: [
          {
            provider: 'builtin:feishu',
            chat_id: 'chat-x',
            chat_type: 'group',
            team_name: 'gamma',
            leader_name: 'lead-1',
            active: true,
            created_at: 1,
            updated_at: 1,
            deactivated_at: null,
          },
        ],
      });
      const store = new ChannelBindingStore();
      await expect(store.list(DISPATCHER)).rejects.toThrow(
        /not a compatible version .*delete .*channel-bindings\.json/s,
      );
    });

    it('reuses a compatible v2 store as explicit bindings with claim_id null', async () => {
      writeRaw(dispatcherChannelBindingsPath(DISPATCHER), {
        version: 2,
        bindings: [
          {
            channel_id: 'primary',
            provider: 'builtin:feishu',
            target_type: 'group',
            target_key: 'chat-x',
            display: null,
            canonical_url: null,
            meta: { chat_id: 'chat-x', chat_type: 'group' },
            team_name: 'gamma',
            leader_name: 'lead-1',
            active: true,
            created_at: 1,
            updated_at: 1,
            deactivated_at: null,
          },
        ],
      });
      const store = new ChannelBindingStore();
      const bindings = await store.list(DISPATCHER);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        channel_id: 'primary',
        target_key: 'chat-x',
        team_name: 'gamma',
        claim_id: null,
      });
    });

    it('fails loud on a v2 row without routing-key columns', async () => {
      writeRaw(dispatcherChannelBindingsPath(DISPATCHER), {
        version: 2,
        bindings: [
          {
            provider: 'builtin:feishu',
            chat_id: 'chat-x',
            chat_type: 'group',
            team_name: 'gamma',
            leader_name: 'lead-1',
            active: true,
            created_at: 1,
            updated_at: 1,
            deactivated_at: null,
          },
        ],
      });
      const store = new ChannelBindingStore();
      await expect(store.list(DISPATCHER)).rejects.toThrow(
        /missing channel_id \/ target_key .*delete .*channel-bindings\.json/s,
      );
    });

    it('fails loud on a v3 row missing claim_id route provenance', async () => {
      writeRaw(dispatcherChannelBindingsPath(DISPATCHER), {
        version: 3,
        bindings: [
          {
            channel_id: 'primary',
            provider: 'builtin:feishu',
            target_type: 'group',
            target_key: 'chat-x',
            display: null,
            canonical_url: null,
            meta: { chat_id: 'chat-x', chat_type: 'group' },
            team_name: 'gamma',
            leader_name: 'lead-1',
            active: true,
            created_at: 1,
            updated_at: 1,
            deactivated_at: null,
          },
        ],
      });
      const store = new ChannelBindingStore();
      await expect(store.list(DISPATCHER)).rejects.toThrow(
        /missing claim_id route provenance/,
      );
    });

    it('accepts a current v3 binding keyed by (channel_id, target_key)', async () => {
      writeRaw(dispatcherChannelBindingsPath(DISPATCHER), {
        version: 3,
        bindings: [
          {
            channel_id: 'primary',
            provider: 'builtin:feishu',
            target_type: 'group',
            target_key: 'chat-x',
            display: null,
            canonical_url: null,
            meta: { chat_id: 'chat-x', chat_type: 'group' },
            team_name: 'gamma',
            leader_name: 'lead-1',
            claim_id: null,
            active: true,
            created_at: 1,
            updated_at: 1,
            deactivated_at: null,
          },
        ],
      });
      const store = new ChannelBindingStore();
      const bindings = await store.list(DISPATCHER);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.team_name).toBe('gamma');
      expect(bindings[0]!.target_key).toBe('chat-x');
      expect(bindings[0]!.channel_id).toBe('primary');
    });
  });

  // The serve/doctor boot probes surface incompatible binding state at startup
  // rather than lazily on first inbound. Pin both layers directly:
  // `detectLegacyChannelBindingStore` validates row syntax, while
  // `detectAmbiguousV2ChannelBindingRoutes` checks whether reusable v2 rows
  // overlap open collaboration target state and are therefore provenance-ambiguous.
  describe('channel-binding serve/doctor boot probes (#209)', () => {
    it('returns the rebuild message for an incompatible version 1 store', async () => {
      writeRaw(dispatcherChannelBindingsPath(DISPATCHER), {
        version: 1,
        bindings: [{ provider: 'builtin:feishu', chat_id: 'chat-x' }],
      });
      const message = await detectLegacyChannelBindingStore(DISPATCHER);
      expect(message).toMatch(
        /not a compatible version .*delete .*channel-bindings\.json/s,
      );
    });

    it('returns null for a compatible v2 store', async () => {
      writeRaw(dispatcherChannelBindingsPath(DISPATCHER), {
        version: 2,
        bindings: [
          {
            channel_id: 'primary',
            provider: 'builtin:feishu',
            target_type: 'group',
            target_key: 'chat-x',
            display: null,
            canonical_url: null,
            meta: { chat_id: 'chat-x', chat_type: 'group' },
            team_name: 'gamma',
            leader_name: 'lead-1',
            active: true,
            created_at: 1,
            updated_at: 1,
            deactivated_at: null,
          },
        ],
      });
      await expect(
        detectLegacyChannelBindingStore(DISPATCHER),
      ).resolves.toBeNull();
      await expect(
        detectAmbiguousV2ChannelBindingRoutes(DISPATCHER),
      ).resolves.toBeNull();
    });

    it('fails loud when a v2 route overlaps open collaboration target state', async () => {
      writeRaw(dispatcherChannelBindingsPath(DISPATCHER), {
        version: 2,
        bindings: [
          {
            channel_id: 'primary',
            provider: 'builtin:feishu',
            target_type: 'group',
            target_key: 'chat-x',
            display: null,
            canonical_url: null,
            meta: { chat_id: 'chat-x', chat_type: 'group' },
            team_name: 'gamma',
            leader_name: 'lead-1',
            active: true,
            created_at: 1,
            updated_at: 1,
            deactivated_at: null,
          },
        ],
      });
      writeRaw(dispatcherCollaborationSpacesPath(DISPATCHER), {
        version: 1,
        spaces: [],
        targets: [
          {
            version: 1,
            dispatcher_id: DISPATCHER,
            space_name: 'space-a',
            channel_id: 'primary',
            provider: 'builtin:feishu',
            container_key: 'container-a',
            binding_generation: 1,
            target_key: 'chat-x',
            target_type: 'group',
            target_display: null,
            team_name: 'gamma',
            leader_name: 'lead-1',
            worktree_slug: 'space-a-chat-x',
            lifecycle_status: 'active',
            phase: 'bound',
            claim_event_id: null,
            close_event_id: null,
            last_error: null,
            created_at: 1,
            updated_at: 1,
            closed_at: null,
            detached_at: null,
          },
        ],
      });
      await expect(
        detectAmbiguousV2ChannelBindingRoutes(DISPATCHER),
      ).resolves.toMatch(
        /version 2 .*open collaboration target route.*delete .*channel-bindings\.json/s,
      );
    });

    it('returns null when the store is absent (fresh dispatcher)', async () => {
      await expect(
        detectLegacyChannelBindingStore(DISPATCHER),
      ).resolves.toBeNull();
    });

    it('returns null for a current v3 store', async () => {
      writeRaw(dispatcherChannelBindingsPath(DISPATCHER), {
        version: 3,
        bindings: [
          {
            channel_id: 'primary',
            provider: 'builtin:feishu',
            target_type: 'group',
            target_key: 'chat-x',
            display: null,
            canonical_url: null,
            meta: { chat_id: 'chat-x', chat_type: 'group' },
            team_name: 'gamma',
            leader_name: 'lead-1',
            claim_id: null,
            active: true,
            created_at: 1,
            updated_at: 1,
            deactivated_at: null,
          },
        ],
      });
      await expect(
        detectLegacyChannelBindingStore(DISPATCHER),
      ).resolves.toBeNull();
    });
  });
});
