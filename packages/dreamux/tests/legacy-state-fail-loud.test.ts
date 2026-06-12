import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  detectLegacyDispatcherState,
  legacyDispatcherStateMessage,
} from '../src/dispatcher-service/legacy-state.js';
import { TeamMateIdentityStore } from '../src/dispatcher-service/teammate/identity-store.js';
import { ChannelBindingStore } from '../src/dispatcher-service/channel-binding/store.js';
import {
  dispatcherChannelBindingsPath,
  dispatcherTeamDir,
  dispatcherTeamMateDir,
  dispatcherTeamMateRecordPath,
  resetRuntimeConfig,
} from '../src/platform/paths.js';

const DISPATCHER = 'flow';
const silentLog = { warn(): void {} };

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
      writeRaw(dispatcherTeamMateRecordPath(DISPATCHER, 'solo'), { version: 1 });
      expect(await detectLegacyDispatcherState(DISPATCHER)).toEqual([]);
    });

    it.each([
      ['teammate/identities', () => join(dispatcherTeamMateDir(DISPATCHER), 'identities', 'x.json')],
      ['teammate/sessions.jsonl', () => join(dispatcherTeamMateDir(DISPATCHER), 'sessions.jsonl')],
      ['teammate/history', () => join(dispatcherTeamMateDir(DISPATCHER), 'history', 'x.jsonl')],
      ['team/ledger', () => join(dispatcherTeamDir(DISPATCHER), 'ledger', 'x.jsonl')],
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
        writeRaw(dispatcherTeamMateRecordPath(DISPATCHER, 'alice'), {
          ...base,
          [field]: 'legacy',
        });
        const store = new TeamMateIdentityStore(silentLog);
        await expect(store.get(DISPATCHER, 'alice')).rejects.toThrow(
          new RegExp(`removed in issue #199 \\(${field}\\)`),
        );
      },
    );

    it('reads a clean record without complaint', async () => {
      writeRaw(dispatcherTeamMateRecordPath(DISPATCHER, 'alice'), base);
      const store = new TeamMateIdentityStore(silentLog);
      const identity = await store.get(DISPATCHER, 'alice');
      expect(identity?.name).toBe('alice');
    });

    it('fails loud (does NOT skip) on the list() path for a removed-field record', async () => {
      // A clean record + a stale one: list() must not silently drop the stale
      // record (which would hide it from teammate.list / teammate.history); it
      // re-throws the legacy-state error.
      writeRaw(dispatcherTeamMateRecordPath(DISPATCHER, 'alice'), base);
      writeRaw(dispatcherTeamMateRecordPath(DISPATCHER, 'stale'), {
        ...base,
        name: 'stale',
        checkpoint: null,
      });
      const store = new TeamMateIdentityStore(silentLog);
      await expect(store.list(DISPATCHER)).rejects.toThrow(/removed in issue #199/);
    });

    it('still tolerates a genuinely unreadable (non-legacy) record in list()', async () => {
      // Resilience is preserved for corrupt JSON: it warns + skips, only the
      // good record is returned. Old-state detection must not over-reach into
      // every read failure.
      writeRaw(dispatcherTeamMateRecordPath(DISPATCHER, 'alice'), base);
      writeFileSync(
        dispatcherTeamMateRecordPath(DISPATCHER, 'broken'),
        '{ not json',
        { mode: 0o600 },
      );
      const store = new TeamMateIdentityStore(silentLog);
      const names = (await store.list(DISPATCHER)).map((identity) => identity.name);
      expect(names).toEqual(['alice']);
    });
  });

  describe('channel-binding reader rejects pre-#199 team_id rows', () => {
    it('fails loud on a row keyed by team_id instead of team_name', async () => {
      writeRaw(dispatcherChannelBindingsPath(DISPATCHER), {
        version: 1,
        bindings: [
          {
            provider: 'builtin:feishu',
            chat_id: 'chat-x',
            chat_type: 'group',
            team_id: 'gamma',
            leader_name: 'lead-1',
            active: true,
            created_at: 1,
            updated_at: 1,
            deactivated_at: null,
          },
        ],
      });
      const store = new ChannelBindingStore();
      await expect(store.list(DISPATCHER)).rejects.toThrow(/keyed by team_id/);
    });

    it('accepts a current team_name-keyed binding', async () => {
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
      const bindings = await store.list(DISPATCHER);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.team_name).toBe('gamma');
    });
  });
});
