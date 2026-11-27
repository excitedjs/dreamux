/**
 * `dreamux channel add <npm package name>`: onboarding for one Dispatcher
 * that carries one channel of a registered plugin. The plugin is a real
 * package in a temporary plugin directory; the prompts and the command
 * runner are fakes.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { text } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandRunner } from '../src/platform/command-runner.js';
import { addChannel } from '../src/onboard/channel-add.js';
import type { RunOnboardOptions } from '../src/onboard/run.js';
import { testSingleDispatcherFileObject } from './helpers/config.js';
import { writeNpmPackage } from './helpers/npm-packages.js';

vi.mock('@clack/prompts', () => ({
  text: vi.fn(async () => ''),
  password: vi.fn(async () => ''),
  confirm: vi.fn(async () => false),
  isCancel: () => false,
  cancel: () => {},
}));

const CHANNEL = '@acme/chan';
/** One channel whose onboarding asks for one value. */
const CHANNEL_SOURCE = `export default () => ({
  name: 'acme',
  contribute(host) {
    host.channelProviders.contribute('acme', {
      createSession() {},
      onboard: {
        async collect(context, prompts) {
          return { token: await prompts.text({ message: 'acme token' }) };
        },
      },
    });
  },
});`;
const NO_CHANNEL = '@acme/hooks-only';
const NO_CHANNEL_SOURCE = `export default () => ({ name: 'hooks-only' });`;

/** Enough of a shell for onboarding's doctor: every binary is present. */
class FakeRunner implements CommandRunner {
  async run(): Promise<void> {}
  async check(_command: string, args: string[]): Promise<boolean> {
    return args[0] === '--help';
  }
  async capture(): Promise<string> {
    return 'v22.7.0';
  }
}

let root: string;
let home: string;
let configFile: string;
let answers: string[];
let tty: PropertyDescriptor | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dreamux-channel-add-'));
  vi.stubEnv('DREAMUX_ROOT', root);
  home = join(root, 'home');
  configFile = join(root, 'config.json');
  answers = [];
  tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
    writable: true,
  });
  await mkdir(home, { recursive: true });
  vi.mocked(text).mockImplementation(async (options: { message: string }) => {
    const answer = answers.shift();
    if (answer === undefined)
      throw new Error(`no answer for: ${options.message}`);
    return answer;
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(text).mockReset();
  if (tty === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stdin, 'isTTY', tty);
  await rm(root, { recursive: true, force: true });
});

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** A Dispatcher that already exists, in valid file shape with its agent. */
function existing(): {
  agents: Record<string, unknown>[];
  dispatchers: Record<string, unknown>[];
} {
  const file = testSingleDispatcherFileObject({
    id: 'main',
    cwd: join(root, 'work', 'main'),
  });
  return {
    agents: file['agents'] as Record<string, unknown>[],
    dispatchers: file['dispatchers'] as Record<string, unknown>[],
  };
}
const REGISTERED = [`npm:${CHANNEL}`];
// The agent runtime's binary is this Node, so the doctor's version check needs
// no Codex; its access check takes the token from the environment.
function options(): Omit<RunOnboardOptions, 'answers'> {
  return {
    runner: new FakeRunner(),
    platform: 'linux',
    homeDir: home,
    env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
  };
}

describe('channel add', () => {
  it('creates a new Dispatcher with the channel and the provider’s own configuration', async () => {
    const before = existing();
    await writeConfig({ plugins: REGISTERED, ...before });
    await writeNpmPackage(root, CHANNEL, CHANNEL_SOURCE);
    // In order: the Dispatcher, its working directory, the agent runtime, the
    // runtime binary that runtime's onboarding asks for, then the channel's own.
    answers.push(
      'personal',
      join(root, 'work', 'personal'),
      'builtin:codex',
      process.execPath,
      'token-value',
    );

    const result = await addChannel(CHANNEL, options());

    expect(result.dispatcher_id).toBe('personal');
    expect(result.doctor.ok).toBe(true);
    expect(result.service).toBeNull();
    const after = JSON.parse(await readFile(configFile, 'utf8'));
    expect(after['plugins']).toEqual(REGISTERED);
    // Onboarding writes the existing Dispatcher in its resolved shape, with
    // the defaults stated, as `dreamux onboard` does; nothing in it changes.
    expect(after['dispatchers']).toEqual([
      {
        ...before.dispatchers[0],
        enabled: true,
        workspace: { enabled: false },
      },
      {
        id: 'personal',
        agentRuntime: 'personal',
        cwd: join(root, 'work', 'personal'),
        enabled: true,
        workspace: { enabled: false },
        channels: [
          {
            id: 'primary',
            provider: 'builtin:acme',
            config: { token: 'token-value' },
          },
        ],
      },
    ]);
    // The new Dispatcher's agent is added beside the existing one.
    expect(after['agents']).toEqual([
      ...before.agents,
      expect.objectContaining({ id: 'personal', provider: 'builtin:codex' }),
    ]);
  });

  it('refuses a Dispatcher id that exists, changing nothing', async () => {
    await writeConfig({ plugins: REGISTERED, ...existing() });
    await writeNpmPackage(root, CHANNEL, CHANNEL_SOURCE);
    const before = await readFile(configFile, 'utf8');
    answers.push('main');
    await expect(addChannel(CHANNEL, options())).rejects.toThrow(
      /dispatcher main already exists/,
    );
    expect(await readFile(configFile, 'utf8')).toBe(before);
  });

  it('refuses a plugin that contributes no channel', async () => {
    await writeConfig({
      plugins: [`npm:${NO_CHANNEL}`],
      ...testSingleDispatcherFileObject(),
    });
    await writeNpmPackage(root, NO_CHANNEL, NO_CHANNEL_SOURCE);
    await expect(addChannel(NO_CHANNEL, options())).rejects.toThrow(
      `plugin npm:${NO_CHANNEL} contributes no channel`,
    );
  });

  it('refuses a plugin that is not registered', async () => {
    await writeConfig(testSingleDispatcherFileObject());
    await expect(addChannel(CHANNEL, options())).rejects.toThrow(
      `plugin npm:${CHANNEL} is not registered; run: dreamux plugin add ${CHANNEL}`,
    );
  });

  it('refuses without a terminal', async () => {
    delete (process.stdin as { isTTY?: boolean }).isTTY;
    await expect(addChannel(CHANNEL, options())).rejects.toThrow(
      /needs a terminal/,
    );
  });
});
