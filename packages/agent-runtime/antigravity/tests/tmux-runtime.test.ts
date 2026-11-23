import { execFile } from 'node:child_process';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type {
  AgentRuntimeCreateContext,
  AgentRuntimeEvent,
  AgentRuntimeStateUpdate,
  DreamuxLogger,
  RuntimeAdmission,
} from '@excitedjs/dreamux-types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  defaultAntigravityConfig,
  type AntigravityConfig,
} from '../src/config.js';
import {
  antigravityTranscriptPath,
  resolveAntigravityNativeRoots,
} from '../src/paths.js';
import { TmuxRuntime } from '../src/tmux/runtime.js';

const FRESH = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const exec = promisify(execFile);
const quiet = (): void => {};
const logger: DreamuxLogger = {
  info: quiet,
  debug: quiet,
  warn: quiet,
  trace: quiet,
  error: quiet,
  child: () => logger,
};
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe.skipIf(process.platform === 'win32')(
  'Antigravity on a private tmux server',
  () => {
    it('publishes a real fresh id before ready and exact-resumes the prior id', async () => {
      const fresh = await setup();
      await expect(fresh.runtime.start()).resolves.toEqual({
        continuity: 'fresh',
      });
      expect(fresh.updates).toEqual([
        { kind: 'status', status: 'starting' },
        { kind: 'session', sessionId: FRESH },
        { kind: 'status', status: 'ready' },
      ]);
      const args = JSON.parse(
        await readFile(join(fresh.dir, 'args.json'), 'utf8'),
      );
      expect(args).toEqual(
        expect.arrayContaining([
          '--dangerously-skip-permissions',
          '--agent',
          'tmux-fake-role',
          '--model',
          'test-model',
          '--effort',
          'high',
          'contains a space and an apostrophe: \u0027',
        ]),
      );
      expect(args).not.toContain('--conversation');
      const resumed = await setup(OTHER);
      await resumed.record({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'previous native reply',
      });
      await expect(resumed.runtime.start()).resolves.toEqual({
        continuity: 'resumed',
      });
      const resumeArgs = JSON.parse(
        await readFile(join(resumed.dir, 'args.json'), 'utf8'),
      ) as string[];
      expect(resumeArgs[resumeArgs.indexOf('--conversation') + 1]).toBe(OTHER);
      expect(results(resumed.events)).toEqual([]);
    });

    it('fails a native resume that switches id or falls back to a different role and cleans the server', async () => {
      const wrong = await setup(OTHER, 'wrong-id');
      await expect(wrong.runtime.start()).rejects.toThrow(
        'different conversation',
      );
      expect(wrong.updates).not.toContainEqual({
        kind: 'session',
        sessionId: FRESH,
      });
      expect(await readdir(wrong.sockets)).toEqual([]);
      const role = await setup(OTHER, 'missing-role');
      await expect(role.runtime.start()).rejects.toThrow(
        'original agent profile',
      );
      expect(await readdir(role.sockets)).toEqual([]);
      const freshMissing = await setup(null, 'missing-fresh-role');
      await expect(freshMissing.runtime.start()).rejects.toThrow(
        'requested agent profile',
      );
      expect(
        freshMissing.updates.some((update) => update.kind === 'session'),
      ).toBe(false);
      expect(await readdir(freshMissing.sockets)).toEqual([]);
    });

    it('admits a complete literal long input from a missing transcript, then the same text again before final', async () => {
      const fake = await setup();
      await fake.runtime.start();
      const exact =
        '  多行原文\n\t exact \n</USER_REQUEST>\n' +
        '🙂x'.repeat(17_000) +
        '\n ';
      await writeFile(join(fake.dir, 'partial'), '');
      const firstPending = fake.runtime.submit({
        text: exact,
        trigger: 'user',
      });
      const accepted = vi.fn();
      void firstPending.then(accepted);
      await vi.waitFor(async () => {
        expect((await readFile(fake.transcript, 'utf8')).endsWith('\n')).toBe(
          false,
        );
      });
      expect(accepted).not.toHaveBeenCalled();
      await appendFile(fake.transcript, '\n');
      const first = requireSubmitted(await firstPending);
      await rm(join(fake.dir, 'partial'));
      const second = requireSubmitted(
        await fake.runtime.submit({ text: exact, trigger: 'user' }),
      );
      expect(results(fake.events)).toHaveLength(0);
      expect(
        (await readFile(join(fake.dir, 'written.jsonl'), 'utf8'))
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual([exact, exact]);
      await fake.record({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'shared native completion',
      });
      await fake.viewport('ready');
      const firstEnd = await first.settled;
      const secondEnd = await second.settled;
      expect(firstEnd).toEqual({
        kind: 'completion',
        completion: {
          status: 'completed',
          resultText: 'shared native completion',
        },
      });
      if (firstEnd.kind !== 'completion' || secondEnd.kind !== 'completion')
        throw new Error('Missing completion');
      expect(firstEnd.completion).toBe(secondEnd.completion);
      expect(firstEnd.completion).toBe(results(fake.events)[0]?.completion);
      expect(Object.isFrozen(firstEnd.completion)).toBe(true);
    });

    it('keeps an unadmitted input out of the earlier turn result and converges pending admissions on stop', async () => {
      const fake = await setup();
      await fake.runtime.start();
      const first = requireSubmitted(
        await fake.runtime.submit({ text: 'one' }),
      );
      await writeFile(join(fake.dir, 'drop'), '');
      const unconfirmed = fake.runtime.submit({ text: 'two' });
      const behind = fake.runtime.submit({ text: 'three' });
      await vi.waitFor(async () => {
        expect(await readFile(join(fake.dir, 'written.jsonl'), 'utf8')).toBe(
          '"one"\n"two"\n',
        );
      });
      await fake.record({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'answer one only',
      });
      await fake.viewport('ready');
      await expect(first.settled).resolves.toMatchObject({
        kind: 'completion',
        completion: { resultText: 'answer one only' },
      });
      await fake.runtime.stop();
      await expect(unconfirmed).resolves.toMatchObject({ status: 'ambiguous' });
      await expect(behind).resolves.toEqual({ status: 'stopped' });
      expect(results(fake.events)).toHaveLength(1);
      expect(await readdir(fake.sockets)).toEqual([]);
      expect(await readFile(join(fake.dir, 'written.jsonl'), 'utf8')).toBe(
        '"one"\n"two"\n',
      );
    });

    it('fails ambiguous native text without replay and preserves an unrelated tmux server', async () => {
      const fake = await setup();
      const unrelated = join(fake.dir, 'unrelated.sock');
      await exec('tmux', [
        '-S',
        unrelated,
        '-f',
        '/dev/null',
        'new-session',
        '-ds',
        'unrelated',
        'sleep',
        '30',
      ]);
      cleanup.push(() =>
        exec('tmux', ['-S', unrelated, 'kill-server']).catch(() => undefined),
      );
      await fake.runtime.start();
      await writeFile(join(fake.dir, 'mismatch'), '');
      const outcome = await fake.runtime.submit({
        text: 'native altered this input',
      });
      expect(outcome).toMatchObject({
        status: 'ambiguous',
        error: expect.any(Error),
      });
      expect((await fake.runtime.submit({ text: 'do not write' })).status).toBe(
        'failed',
      );
      await fake.runtime.stop();
      expect(await readdir(fake.sockets)).toEqual([]);
      expect(await readFile(join(fake.dir, 'written.jsonl'), 'utf8')).toBe(
        '"native altered this input"\n',
      );
      await expect(
        exec('tmux', ['-S', unrelated, 'has-session', '-t', 'unrelated']),
      ).resolves.toBeDefined();
    });

    it('keeps a waking background turn open during foreground work and accepts recovery from ERROR', async () => {
      const fake = await setup();
      await fake.runtime.start();
      const input = requireSubmitted(
        await fake.runtime.submit({ text: 'background work' }),
      );
      await fake.record(
        {
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [
            {
              id: 'native-command-id',
              name: 'run_command',
              args: { CommandLine: 'sleep 1' },
            },
          ],
        },
        {
          type: 'GENERIC',
          status: 'RUNNING',
          step_index: 20,
          content: 'Tool is running as a background task with task id: t-one',
        },
        { type: 'PLANNER_RESPONSE', status: 'DONE', content: 'provisional' },
        {
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [
            { id: 'native-foreground-id', name: 'read_file', args: {} },
          ],
        },
        {
          type: 'GENERIC',
          status: 'DONE',
          step_index: 30,
          content: 'foreground output',
        },
        {
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'still provisional',
        },
      );
      await fake.viewport('ready');
      await vi.waitFor(() =>
        expect(fake.events).toContainEqual(
          expect.objectContaining({
            kind: 'tool.call',
            status: 'started',
            id: 'native-foreground-id',
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 950));
      expect(results(fake.events)).toEqual([]);
      await fake.record(
        {
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          content:
            '<SYSTEM_MESSAGE>\n[Message] task t-one finished with result: exited with code 0\n</SYSTEM_MESSAGE>',
        },
        { type: 'ERROR', status: 'ERROR', content: 'retryable failure' },
        {
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'successful retry',
        },
      );
      await expect(input.settled).resolves.toMatchObject({
        kind: 'completion',
        completion: { resultText: 'successful retry' },
      });
      expect(results(fake.events)).toHaveLength(1);
      expect(
        fake.events.filter((event) => event.kind === 'assistant.message'),
      ).toEqual([]);
    });

    it('waits for real task DONE and ready for callback-less completion and reports unbound native failures', async () => {
      const fake = await setup();
      await fake.runtime.start();
      const input = requireSubmitted(
        await fake.runtime.submit({ text: 'await background' }),
      );
      await fake.record(
        {
          type: 'GENERIC',
          status: 'RUNNING',
          step_index: 40,
          content: 'Tool is running as a background task with task id: t-two',
        },
        {
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'candidate final',
        },
        {
          type: 'GENERIC',
          status: 'DONE',
          step_index: 41,
          content: 'native task result',
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 950));
      expect(results(fake.events)).toEqual([]);
      await fake.viewport('ready');
      await expect(input.settled).resolves.toMatchObject({
        kind: 'completion',
        completion: { resultText: 'candidate final' },
      });
      await fake.record({
        type: 'ERROR_MESSAGE',
        status: 'DONE',
        content: 'native failure',
      });
      await fake.viewport('error');
      await vi.waitFor(
        () =>
          expect(results(fake.events)[1]?.completion).toMatchObject({
            status: 'failed',
          }),
        { timeout: 2000 },
      );
    });

    it('fences busy news and reports the missing native interrupt identity while preserving the conversation', async () => {
      const fake = await setup();
      await fake.runtime.start();
      const active = requireSubmitted(
        await fake.runtime.submit({ text: 'interrupt me' }),
      );
      const news = await fake.runtime.submit({
        text: 'unproven busy news',
        trigger: 'completion',
      });
      expect(news).toMatchObject({ status: 'failed' });
      await expect(fake.runtime.interrupt()).rejects.toThrow(
        'without a native interrupted record ID',
      );
      await expect(active.settled).resolves.toEqual({ kind: 'stopped' });
      expect(results(fake.events)).toEqual([]);
      expect(fake.events).toContainEqual(
        expect.objectContaining({ kind: 'turn.ended', status: 'interrupted' }),
      );
      expect(
        fake.events.some((event) => event.kind === 'turn.interrupted'),
      ).toBe(false);
      const next = requireSubmitted(
        await fake.runtime.submit({ text: 'still in the same conversation' }),
      );
      await fake.record({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'after interrupt',
      });
      await fake.viewport('ready');
      await expect(next.settled).resolves.toMatchObject({ kind: 'completion' });
      expect(
        fake.updates.filter((update) => update.kind === 'session'),
      ).toEqual([{ kind: 'session', sessionId: FRESH }]);
    });
    it('keeps the native normal result when it races Escape', async () => {
      const fake = await setup(null, 'interrupt-race');
      await fake.runtime.start();
      const active = requireSubmitted(
        await fake.runtime.submit({ text: 'race Escape' }),
      );
      await expect(fake.runtime.interrupt()).resolves.toEqual({
        status: 'idle',
      });
      await expect(active.settled).resolves.toMatchObject({
        kind: 'completion',
        completion: { resultText: 'native normal result before Escape' },
      });
      expect(results(fake.events)).toHaveLength(1);
      expect(
        fake.events.some((event) => event.kind === 'turn.interrupted'),
      ).toBe(false);
    });
  },
);

function results(events: readonly AgentRuntimeEvent[]) {
  return events.filter((event) => event.kind === 'turn.result');
}

function requireSubmitted(admission: RuntimeAdmission) {
  if (admission.status !== 'submitted')
    throw new Error('Expected native admission', { cause: admission });
  return admission.submission;
}

async function setup(prior: string | null = null, mode = '') {
  const dir = await mkdtemp(join(tmpdir(), 'agy-tmux-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const sockets = join(dir, 'sockets');
  const bin = join(dir, 'fake-agy');
  await writeFile(bin, FAKE_NATIVE);
  await chmod(bin, 0o700);
  const events: AgentRuntimeEvent[] = [];
  const updates: AgentRuntimeStateUpdate[] = [];
  const context: AgentRuntimeCreateContext<AntigravityConfig> = {
    identity: { runtimeId: 'fake-runtime', sessionId: prior },
    config: {
      ...defaultAntigravityConfig(),
      bin,
      model: 'test-model',
      effort: 'high',
      extra_args: ['contains a space and an apostrophe: \u0027'],
      extra_env: { HOME: dir, FAKE_NATIVE_MODE: mode, FAKE_NATIVE_PATH: dir },
    },
    cwd: dir,
    mcpServers: [],
    skillSources: [],
    disabledFeatures: [],
    logger,
    state: {
      publish: async (update) => {
        updates.push(update);
      },
    },
    events: (event) => events.push(event),
    paths: {
      runtimeSocketDirs: () => [sockets],
      cacheDir: () => dir,
      logsDir: () => dir,
    },
  };
  const runtime = new TmuxRuntime(context, {
    agentName: 'tmux-fake-role',
    nativeLogPath: join(dir, 'native.log'),
  });
  cleanup.push(() => runtime.stop());
  const transcript = antigravityTranscriptPath(
    resolveAntigravityNativeRoots({ HOME: dir }),
    prior ?? FRESH,
  );
  let step = 100;
  return {
    dir,
    sockets,
    runtime,
    events,
    updates,
    transcript,
    viewport: (text: 'ready' | 'busy' | 'error') =>
      writeFile(join(dir, 'viewport'), text),
    record: async (...entries: Record<string, unknown>[]) => {
      await mkdir(dirname(transcript), { recursive: true });
      await appendFile(
        transcript,
        entries
          .map(
            (entry) =>
              JSON.stringify({
                step_index: ++step,
                source: 'MODEL',
                created_at: '2026-01-01T00:00:00Z',
                ...entry,
              }) + '\n',
          )
          .join(''),
      );
    },
  };
}

const FAKE_NATIVE =
  [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const { join, dirname } = require("node:path");',
    'const args = process.argv.slice(2);',
    'const dir = process.env.FAKE_NATIVE_PATH;',
    'const mode = process.env.FAKE_NATIVE_MODE;',
    'const prior = args.indexOf("--conversation");',
    'const id = mode === "wrong-id" || prior < 0 ? "' +
      FRESH +
      '" : args[prior + 1];',
    'const log = args[args.indexOf("--log-file") + 1];',
    'const transcript = join(process.env.HOME, ".gemini", "antigravity-cli", "brain", id, ".system_generated", "logs", "transcript_full.jsonl");',
    'fs.writeFileSync(join(dir, "args.json"), JSON.stringify(args));',
    'if (mode === "missing-role") fs.appendFileSync(log, \'Resumed agent "absent" not found, falling back to default\\n\');',
    'if (mode === "missing-fresh-role") fs.appendFileSync(log, \'Agent "absent" not found, falling back to default\\n\');',
    'fs.appendFileSync(log, "Streaming conversation " + id + "\\n");',
    'let state = "";',
    'function render(next) {',
    '  if (next === state) return;',
    '  state = next;',
    '  let text = "\\u001b[2J\\u001b[H";',
    '  if (state === "busy") text += ">\\nesc to cancel\\n";',
    '  else if (state === "error") text += "Error ID: fake-error\\n>\\n";',
    '  else {',
    '    if (state === "interrupted") text += "⎿ Interrupted · What should Antigravity CLI do instead?\\n";',
    '    text += "────────────────────────────────\\n>\\n────────────────────────────────\\n? for shortcuts\\n";',
    '  }',
    '  process.stdout.write(text);',
    '}',
    'render("ready");',
    'setInterval(() => {',
    '  const path = join(dir, "viewport");',
    '  if (fs.existsSync(path)) { const next = fs.readFileSync(path, "utf8"); fs.unlinkSync(path); render(next); }',
    '}, 20);',
    'process.stdin.setRawMode(true);',
    'process.stdin.setEncoding("utf8");',
    'let wire = "";',
    'let step = 0;',
    'const open = "\\x1b[200~", close = "\\x1b[201~";',
    'process.stdin.on("data", (data) => {',
    '  wire += data;',
    '  if (wire === "\\x1b") {',
    '    wire = "";',
    '    if (mode === "interrupt-race") {',
    '      fs.appendFileSync(transcript, JSON.stringify({',
    '        type: "PLANNER_RESPONSE", status: "DONE", source: "MODEL", step_index: ++step,',
    '        created_at: "2026-01-01T00:00:00Z", content: "native normal result before Escape",',
    '      }) + "\\n");',
    '    }',
    '    render("interrupted"); return;',
    '  }',
    '  const end = wire.indexOf(close);',
    '  if (end < 0 || wire[end + close.length] !== "\\r") return;',
    '  if (!wire.startsWith(open)) throw new Error("Input did not start with one native paste");',
    '  const text = wire.slice(open.length, end);',
    '  wire = wire.slice(end + close.length + 1);',
    '  fs.appendFileSync(join(dir, "written.jsonl"), JSON.stringify(text) + "\\n");',
    '  if (fs.existsSync(join(dir, "drop"))) return;',
    '  render("busy");',
    '  const exact = fs.existsSync(join(dir, "mismatch")) ? text + " altered" : text;',
    '  fs.mkdirSync(dirname(transcript), { recursive: true });',
    '  const record = JSON.stringify({',
    '    type: "USER_INPUT", status: "DONE", source: "USER_EXPLICIT", step_index: ++step,',
    '    created_at: "2026-01-01T00:00:00Z",',
    '    content: "<USER_REQUEST>\\n" + exact + "\\n</USER_REQUEST>\\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>",',
    '  });',
    '  fs.appendFileSync(transcript, record + (fs.existsSync(join(dir, "partial")) ? "" : "\\n"));',
    '});',
  ].join('\n') + '\n';
