import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DispatcherRepo } from '../src/db/repository.js';
import { openDatabase } from '../src/db/schema.js';
import { runOnboard } from '../src/onboard/run.js';
import {
  answersFromOptions,
  type OnboardCliOptions,
} from '../src/onboard/wizard.js';
import type { CommandRunner, OnboardAnswers } from '../src/onboard/types.js';
import {
  dispatcherCodexConfigPath,
  dispatcherCodexHome,
  dispatcherCodexPluginsDir,
  resetRuntimeConfig,
} from '../src/runtime/paths.js';

class FakeRunner implements CommandRunner {
  launchdLoaded = false;
  readonly calls: Array<{
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }> = [];

  async run(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    } = {},
  ): Promise<void> {
    this.calls.push({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
    });
    if (options.dryRun) return;

    if (
      command === 'codex' &&
      args.join(' ') ===
        'plugin marketplace add excitedjs/dreamux --sparse .agents/plugins --sparse codex-marketplace/plugins/codexmux'
    ) {
      const codexHome = requiredEnv(options.env, 'CODEX_HOME');
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(
        join(codexHome, 'config.toml'),
        `[marketplaces.dreamux]
source = "excitedjs/dreamux"
source_type = "github"
`,
      );
      return;
    }
    if (command === 'codex' && args.join(' ') === 'plugin add codexmux@dreamux') {
      const codexHome = requiredEnv(options.env, 'CODEX_HOME');
      const pluginRoot = join(
        codexHome,
        'plugins',
        'cache',
        'dreamux',
        'codexmux',
        '0.1.0',
      );
      mkdirSync(pluginRoot, { recursive: true });
      writeFileSync(join(pluginRoot, 'plugin.json'), '{"name":"codexmux"}');
      return;
    }
    if (command === 'claude' && args.join(' ') === 'plugin marketplace add excitedjs/claudemux --scope user') {
      const claudeConfigDir = requiredEnv(options.env, 'CLAUDE_CONFIG_DIR');
      mkdirSync(join(claudeConfigDir, 'plugins'), { recursive: true });
      writeFileSync(
        join(claudeConfigDir, 'settings.json'),
        JSON.stringify({
          extraKnownMarketplaces: {
            claudemux: {
              source: {
                source: 'github',
                repo: 'excitedjs/claudemux',
              },
            },
          },
        }),
      );
      writeFileSync(
        join(claudeConfigDir, 'plugins', 'known_marketplaces.json'),
        JSON.stringify({
          claudemux: {
            source: {
              source: 'github',
              repo: 'excitedjs/claudemux',
            },
          },
        }),
      );
      return;
    }
    if (command === 'claude' && args.join(' ') === 'plugin install claudemux@claudemux --scope user') {
      const claudeConfigDir = requiredEnv(options.env, 'CLAUDE_CONFIG_DIR');
      const pluginDir = join(claudeConfigDir, 'plugins', 'claudemux');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'plugin.json'), '{"name":"claudemux"}');
      return;
    }
    if (command === 'launchctl' && args[0] === 'bootstrap') {
      this.launchdLoaded = true;
      return;
    }
    if (command === 'launchctl' && args[0] === 'bootout') {
      this.launchdLoaded = false;
      return;
    }
  }

  async check(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    } = {},
  ): Promise<boolean> {
    void options;
    return command === 'launchctl' &&
      args[0] === 'print' &&
      this.launchdLoaded;
  }

  async capture(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      dryRun?: boolean;
    } = {},
  ): Promise<string> {
    void args;
    void options.cwd;
    void options.dryRun;
    if (command !== 'claude') return '';
    const claudeConfigDir = requiredEnv(options.env, 'CLAUDE_CONFIG_DIR');
    const installed = existsSync(
      join(claudeConfigDir, 'plugins', 'claudemux', 'plugin.json'),
    );
    return installed ? '[{"name":"claudemux"}]' : '[]';
  }
}

function writePrivateCodexAuth(answers: OnboardAnswers): void {
  const authPath = join(dispatcherCodexHome(answers.dispatcherId), 'auth.json');
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(authPath, '{}', { mode: 0o600 });
}

function writeClaudeMarketplace(answers: OnboardAnswers): void {
  const settingsPath = join(answers.claudeConfigDir, 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      extraKnownMarketplaces: {
        claudemux: {
          source: {
            source: 'github',
            repo: answers.claudeMarketplaceSource,
          },
        },
      },
    }),
  );
}

function countCalls(
  runner: FakeRunner,
  command: string,
  argsPrefix: string[],
): number {
  return runner.calls.filter((call) =>
    call.command === command &&
    argsPrefix.every((arg, index) => call.args[index] === arg),
  ).length;
}

describe('dreamux onboard', () => {
  let root: string;
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(homedir(), '.dreamux-onboard-'));
    previousCodexHome = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = join(root, 'codex');
  });

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previousCodexHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('writes dispatcher state, records subprocess files, and passes the serve doctor', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
      claudeConfigDir: join(root, 'claude'),
      dreamuxBin: '/usr/local/bin/dreamux',
      botAppId: 'app-test',
      botAppSecret: 'secret-test',
    });
    writePrivateCodexAuth(answers);

    const result = await runOnboard({
      answers,
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
    });

    expect(result.doctor.ok).toBe(true);
    expect(result.service).toMatchObject({
      platform: 'systemd',
      registered: true,
      started: true,
    });
    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      [
        'codex',
        [
          'plugin',
          'marketplace',
          'add',
          'excitedjs/dreamux',
          '--sparse',
          '.agents/plugins',
          '--sparse',
          'codex-marketplace/plugins/codexmux',
        ],
      ],
      ['codex', ['plugin', 'add', 'codexmux@dreamux']],
      [
        'claude',
        [
          'plugin',
          'marketplace',
          'add',
          'excitedjs/claudemux',
          '--scope',
          'user',
        ],
      ],
      ['claude', ['plugin', 'install', 'claudemux@claudemux', '--scope', 'user']],
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'dreamux.service']],
    ]);
    expect(runner.calls[0]?.env?.['CODEX_HOME']).toBe(
      dispatcherCodexHome('flow'),
    );
    expect(runner.calls[2]?.env?.['CLAUDE_CONFIG_DIR']).toBe(
      join(root, 'claude'),
    );

    const dreamuxConfig = JSON.parse(
      readFileSync(join(root, 'config', 'config.json'), 'utf8'),
    ) as Record<string, any>;
    expect(dreamuxConfig['feishu']['bots']['flow']).toEqual({
      app_id: 'app-test',
      app_secret: 'secret-test',
    });
    expect(
      existsSync(
        join(
          dispatcherCodexPluginsDir('flow'),
          'cache',
          'dreamux',
          'codexmux',
          '0.1.0',
          'plugin.json',
        ),
      ),
    ).toBe(true);

    const db = openDatabase({ path: join(root, 'runtime', 'state.db') });
    try {
      const row = new DispatcherRepo(db).get('flow');
      expect(row).toMatchObject({
        dispatcher_id: 'flow',
        bot_app_id: 'app-test',
        bot_secret_ref: 'config:flow',
        status: 'declared',
        enabled: 1,
        codex_cwd: join(root, 'dispatcher-cwd'),
      });
      expect(JSON.parse(row?.codex_args_json ?? '{}')).toEqual({
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
        extraArgs: [],
      });
    } finally {
      db.close();
    }

    const ledger = new Map(result.files.map((entry) => [entry.path, entry]));
    expect(ledger.get(join(root, 'config', 'config.json'))?.status).toBe(
      'created',
    );
    expect(ledger.get(dispatcherCodexConfigPath('flow'))?.status).toBe(
      'created',
    );
    expect(ledger.get(dispatcherCodexConfigPath('flow'))?.reason).toContain(
      'codex plugin install',
    );
    expect(
      ledger.get(
        join(
          dispatcherCodexPluginsDir('flow'),
          'cache',
          'dreamux',
          'codexmux',
          '0.1.0',
          'plugin.json',
        ),
      )?.status,
    ).toBe('created');
    expect(
      ledger.get(join(root, 'claude', 'plugins', 'claudemux', 'plugin.json'))
        ?.status,
    ).toBe('created');
    expect(
      ledger.get(
        join(root, 'home', '.config', 'systemd', 'user', 'dreamux.service'),
      )?.status,
    ).toBe('created');
    expect(
      ledger.get(join(root, 'runtime', 'logs', 'daemon.stdout.log'))?.status,
    ).toBe('created');
    expect(ledger.get(join(root, 'runtime', 'state.db'))?.status).toBe(
      'created',
    );
  });

  it('does not let an interactive shell token satisfy the managed service doctor', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
      claudeConfigDir: join(root, 'claude'),
      registerService: true,
    });

    await expect(
      runOnboard({
        answers,
        runner,
        platform: 'linux',
        homeDir: join(root, 'home'),
        env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
      }),
    ).rejects.toThrow(
      'managed service environments do not inherit your interactive shell auth token',
    );
  });

  it('skips already-installed plugins and already-loaded launchd services on rerun', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
      claudeConfigDir: join(root, 'claude'),
      registerService: true,
      startService: true,
    });
    writePrivateCodexAuth(answers);

    await runOnboard({
      answers,
      runner,
      platform: 'darwin',
      homeDir: join(root, 'home'),
      uid: 501,
      env: {},
    });
    await runOnboard({
      answers,
      runner,
      platform: 'darwin',
      homeDir: join(root, 'home'),
      uid: 501,
      env: {},
    });

    expect(countCalls(runner, 'codex', ['plugin', 'marketplace', 'add'])).toBe(1);
    expect(countCalls(runner, 'codex', ['plugin', 'add'])).toBe(1);
    expect(countCalls(runner, 'claude', ['plugin', 'marketplace', 'add'])).toBe(1);
    expect(countCalls(runner, 'claude', ['plugin', 'install'])).toBe(1);
    expect(countCalls(runner, 'launchctl', ['bootstrap'])).toBe(1);
    expect(countCalls(runner, 'launchctl', ['bootout'])).toBe(0);
    expect(countCalls(runner, 'launchctl', ['kickstart'])).toBe(2);
  });

  it('preserves existing config globals and other Feishu bots on rerun', async () => {
    const runner = new FakeRunner();
    const existingRuntimeDir = join(root, 'existing-runtime');
    const ignoredRuntimeDir = join(root, 'ignored-runtime');
    const configDir = join(root, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        runtime_dir: existingRuntimeDir,
        admin_socket: join(root, 'admin.sock'),
        codex: {
          approval_policy: 'on-failure',
          sandbox_mode: 'danger-full-access',
          extra_args: ['--model', 'local-default'],
          initialize_timeout_ms: 12345,
        },
        outbound: {
          retries: 7,
          retry_delay_ms: 321,
        },
        feishu: {
          bots: {
            flow: {
              app_id: 'app-flow',
              app_secret: 'secret-flow',
            },
          },
        },
      }),
    );
    const answers = testAnswers({
      configDir,
      runtimeDir: ignoredRuntimeDir,
      dispatcherId: 'docs',
      dispatcherCwd: join(root, 'docs-cwd'),
      claudeConfigDir: join(root, 'claude'),
      registerService: false,
      botAppId: 'app-docs',
      botAppSecret: 'secret-docs',
    });

    await runOnboard({
      answers,
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: { CODEX_ACCESS_TOKEN: 'interactive-token-test' },
    });

    const saved = JSON.parse(
      readFileSync(join(configDir, 'config.json'), 'utf8'),
    ) as Record<string, any>;
    expect(saved['runtime_dir']).toBe(existingRuntimeDir);
    expect(saved['admin_socket']).toBe(join(root, 'admin.sock'));
    expect(saved['codex']).toMatchObject({
      approval_policy: 'on-failure',
      sandbox_mode: 'danger-full-access',
      extra_args: ['--model', 'local-default'],
      initialize_timeout_ms: 12345,
    });
    expect(saved['outbound']).toEqual({
      retries: 7,
      retry_delay_ms: 321,
    });
    expect(saved['feishu']['bots']).toEqual({
      flow: {
        app_id: 'app-flow',
        app_secret: 'secret-flow',
      },
      docs: {
        app_id: 'app-docs',
        app_secret: 'secret-docs',
      },
    });
    expect(existsSync(ignoredRuntimeDir)).toBe(false);

    const db = openDatabase({ path: join(existingRuntimeDir, 'state.db') });
    try {
      expect(new DispatcherRepo(db).get('docs')).toMatchObject({
        dispatcher_id: 'docs',
        bot_app_id: 'app-docs',
        bot_secret_ref: 'config:docs',
        codex_cwd: join(root, 'docs-cwd'),
      });
    } finally {
      db.close();
    }
  });

  it('does not re-add an existing Claude marketplace before installing the plugin', async () => {
    const runner = new FakeRunner();
    const answers = testAnswers({
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
      claudeConfigDir: join(root, 'claude'),
      registerService: true,
    });
    writePrivateCodexAuth(answers);
    writeClaudeMarketplace(answers);

    await runOnboard({
      answers,
      runner,
      platform: 'linux',
      homeDir: join(root, 'home'),
      env: {},
    });

    expect(countCalls(runner, 'claude', ['plugin', 'marketplace', 'add'])).toBe(0);
    expect(countCalls(runner, 'claude', ['plugin', 'install'])).toBe(1);
  });

  it('fails non-interactive setup when required channel inputs are missing', () => {
    const options: OnboardCliOptions = {
      yes: true,
      configDir: join(root, 'config'),
      runtimeDir: join(root, 'runtime'),
    };

    expect(() => answersFromOptions(options, false)).toThrow(
      'non-interactive onboard requires --bot-app-id',
    );
  });

  it('defaults non-interactive dispatcher cwd to the current working directory', () => {
    const answers = answersFromOptions(
      {
        yes: true,
        configDir: join(root, 'config'),
        runtimeDir: join(root, 'runtime'),
        botAppId: 'app-test',
        botAppSecret: 'secret-test',
      },
      false,
    );

    expect(answers.dispatcherCwd).toBe(process.cwd());
  });
});

function testAnswers(overrides: Partial<OnboardAnswers>): OnboardAnswers {
  return {
    configDir: join(rootForTest(overrides), 'config'),
    runtimeDir: join(rootForTest(overrides), 'runtime'),
    dispatcherId: 'flow',
    dispatcherCwd: join(rootForTest(overrides), 'dispatcher-cwd'),
    codexBin: 'codex',
    codexMarketplaceSource: 'excitedjs/dreamux',
    codexMarketplaceSparse: [
      '.agents/plugins',
      'codex-marketplace/plugins/codexmux',
    ],
    codexMarketplaceName: 'dreamux',
    codexPluginRef: 'codexmux@dreamux',
    claudeBin: 'claude',
    claudeConfigDir: join(rootForTest(overrides), 'claude'),
    claudeMarketplaceSource: 'excitedjs/claudemux',
    claudeMarketplaceSparse: [],
    claudeMarketplaceName: 'claudemux',
    claudePluginRef: 'claudemux@claudemux',
    botAppId: 'app-test',
    botAppSecret: 'secret-test',
    registerService: true,
    startService: true,
    dreamuxBin: '/usr/local/bin/dreamux',
    dryRun: false,
    ...overrides,
  };
}

function rootForTest(overrides: Partial<OnboardAnswers>): string {
  const fromConfig = overrides.configDir;
  if (fromConfig !== undefined) return join(fromConfig, '..');
  return homedir();
}

function requiredEnv(env: NodeJS.ProcessEnv | undefined, name: string): string {
  const value = env?.[name];
  if (value === undefined || value === '') {
    throw new Error(`missing test env ${name}`);
  }
  return value;
}
