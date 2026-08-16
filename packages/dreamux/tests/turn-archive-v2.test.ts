import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AgentTurnsStore,
  assertNoLegacyTurnArchives,
  LEGACY_TURN_ARCHIVE_REBUILD,
} from '../src/service/agent-entity/turns-store.js';
import { dispatcherAgentTurnsPath, resetRuntimeConfig } from '../src/platform/paths.js';
import type { AgentEntityTurnRecord } from '../src/service/agent-entity/types.js';

const DISPATCHER = 'flow';
const SCOPE = {
  dispatcherId: DISPATCHER,
  name: 'reviewer',
  teamId: null,
  role: 'teammate' as const,
};

describe('v2 terminal Turn archive', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-turn-v2-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('fails boot preflight loudly on a complete v1 archive without a newline', async () => {
    const path = archivePath();
    const legacy = JSON.stringify({ version: 1, type: 'submitted', turn_id: 'old' });
    writeArchive(path, legacy);

    await expect(assertNoLegacyTurnArchives(DISPATCHER)).rejects.toThrow(
      LEGACY_TURN_ARCHIVE_REBUILD,
    );
    expect(readFileSync(path, 'utf8')).toBe(legacy);
  });

  it('does not truncate a complete legacy row before rejecting append', async () => {
    const path = archivePath();
    const legacy = JSON.stringify({ version: 1, type: 'settled', turn_id: 'old' });
    writeArchive(path, legacy);

    await expect(new AgentTurnsStore().appendTerminal(SCOPE, terminalInput(3))).rejects.toThrow(
      LEGACY_TURN_ARCHIVE_REBUILD,
    );
    expect(readFileSync(path, 'utf8')).toBe(legacy);
  });

  it('finds a legacy row after leading blank lines in preflight and append', async () => {
    const path = archivePath();
    const content = `\n  \n${JSON.stringify({ version: 1, type: 'settled' })}\n`;
    writeArchive(path, content);

    await expect(assertNoLegacyTurnArchives(DISPATCHER)).rejects.toThrow(
      LEGACY_TURN_ARCHIVE_REBUILD,
    );
    await expect(new AgentTurnsStore().appendTerminal(SCOPE, terminalInput(3))).rejects.toThrow(
      LEGACY_TURN_ARCHIVE_REBUILD,
    );
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it.each([
    ['top-level Turn ID', { ...terminalRow(1), turn_id: 'forbidden' }],
    [
      'scheduled-origin Turn ID',
      {
        ...terminalRow(1),
        turn_origin: {
          kind: 'scheduled',
          job_id: 'daily-review',
          turn_id: 'forbidden',
        },
      },
    ],
  ])('rejects a v2 row with an unknown %s field', async (_label, row) => {
    const path = archivePath();
    const content = `${JSON.stringify(row)}\n`;
    writeArchive(path, content);

    await expect(assertNoLegacyTurnArchives(DISPATCHER)).rejects.toThrow(
      'invalid v2 terminal Turn archive row',
    );
    await expect(
      new AgentTurnsStore().appendTerminal(SCOPE, terminalInput(3)),
    ).rejects.toThrow('invalid v2 terminal Turn archive row');
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('preserves a complete v2 row without a newline before appending', async () => {
    const path = archivePath();
    writeArchive(path, JSON.stringify(terminalRow(1)));

    await new AgentTurnsStore().appendTerminal(SCOPE, terminalInput(3));

    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(terminalRow(1));
  });

  it('truncates only a torn final fragment before the next append', async () => {
    const path = archivePath();
    writeArchive(
      path,
      `${JSON.stringify(terminalRow(1))}\n{"version":2,"type":"terminal"`,
    );

    const store = new AgentTurnsStore();
    await store.appendTerminal(SCOPE, terminalInput(3));
    const records = [];
    for await (const record of store.stream(SCOPE)) records.push(record);

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(terminalRow(1));
    expect(records[1]).toMatchObject({ version: 2, type: 'terminal', submitted_at: 3 });
  });

  it('accepts the maximum escaped assistant row beyond the old tail window', async () => {
    const path = archivePath();
    const large = terminalRow(1, '\u0000'.repeat(160_000));
    const serialized = JSON.stringify(large);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(256 * 1024);
    writeArchive(path, serialized);

    await expect(
      new AgentTurnsStore().appendTerminal(SCOPE, terminalInput(3)),
    ).resolves.toMatchObject({ version: 2, submitted_at: 3 });
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(2);
  });

  it.each([
    [
      'a complete malformed second row',
      () => `${JSON.stringify(terminalRow(1))}\n{"broken":}\n`,
      /invalid complete Turn archive row/u,
    ],
    [
      'a balanced but invalid final row',
      () => `${JSON.stringify(terminalRow(1))}\n{"broken":]`,
      /invalid complete Turn archive row/u,
    ],
    [
      'an invalid v2 schema row after a valid row',
      () => `${JSON.stringify(terminalRow(1))}\n${JSON.stringify({
        version: 2,
        type: 'terminal',
      })}\n`,
      /invalid v2 terminal Turn archive row/u,
    ],
    [
      'a v1 row mixed after a valid v2 row',
      () => `${JSON.stringify(terminalRow(1))}\n${JSON.stringify({
        version: 1,
        type: 'settled',
      })}\n`,
      new RegExp(escapeRegExp(LEGACY_TURN_ARCHIVE_REBUILD), 'u'),
    ],
    [
      'middle corruption followed by a plausible torn tail',
      () => `${JSON.stringify(terminalRow(1))}\n{"broken":}\n{"version":2`,
      /invalid complete Turn archive row/u,
    ],
    [
      'an oversized non-first row',
      () => `${JSON.stringify(terminalRow(1))}\n${'x'.repeat(2 * 1024 * 1024 + 1)}\n`,
      /Turn archive row exceeds/u,
    ],
  ])('fails append, stream, and boot preflight without mutation for %s', async (
    _label,
    contentFactory,
    expected,
  ) => {
    const path = archivePath();
    const content = contentFactory();
    writeArchive(path, content);
    const store = new AgentTurnsStore();

    await expect(assertNoLegacyTurnArchives(DISPATCHER)).rejects.toThrow(expected);
    await expect(readAll(store)).rejects.toThrow(expected);
    await expect(store.appendTerminal(SCOPE, terminalInput(9))).rejects.toThrow(
      expected,
    );
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('ignores one demonstrably incomplete final fragment in stream and boot, then truncates it on append', async () => {
    const path = archivePath();
    const first = JSON.stringify(terminalRow(1));
    const torn = '{"version":2,"type":"terminal","submitted_at":';
    writeArchive(path, `${first}\n${torn}`);
    const store = new AgentTurnsStore();

    await expect(assertNoLegacyTurnArchives(DISPATCHER)).resolves.toBeUndefined();
    await expect(readAll(store)).resolves.toEqual([terminalRow(1)]);
    expect(readFileSync(path, 'utf8')).toBe(`${first}\n${torn}`);

    await store.appendTerminal(SCOPE, terminalInput(3));
    const rows = await readAll(store);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(terminalRow(1));
    expect(rows[1]).toMatchObject({ submitted_at: 3 });
    expect(readFileSync(path, 'utf8')).toBe(
      `${first}\n${JSON.stringify(rows[1])}\n`,
    );
  });
});

async function readAll(store: AgentTurnsStore): Promise<AgentEntityTurnRecord[]> {
  const records: AgentEntityTurnRecord[] = [];
  for await (const record of store.stream(SCOPE)) records.push(record);
  return records;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function archivePath(): string {
  return dispatcherAgentTurnsPath({
    dispatcherId: SCOPE.dispatcherId,
    name: SCOPE.name,
    teamId: SCOPE.teamId,
    role: SCOPE.role,
  });
}

function writeArchive(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
}

function terminalRow(
  submittedAt: number,
  assistant = 'done',
): AgentEntityTurnRecord {
  return {
    version: 2,
    type: 'terminal',
    submitted_at: submittedAt,
    settled_at: submittedAt + 1,
    turn_origin: 'dispatcher',
    prompt_preview: 'work',
    intent: null,
    settle_status: 'completed',
    assistant,
    assistant_preview: 'done',
    assistant_truncated: false,
  };
}

function terminalInput(submittedAt: number) {
  return {
    submittedAt,
    settledAt: submittedAt + 1,
    turnOrigin: 'dispatcher' as const,
    prompt: 'work',
    intent: null,
    settleStatus: 'completed' as const,
    assistant: 'done',
  };
}
