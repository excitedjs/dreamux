import {
  ensureDirectory,
  recordFileTreeChanges,
  snapshotFiles,
} from './ledger.js';
import type { CommandRunner, OnboardAnswers, OnboardFileLedger } from './types.js';

export interface PluginInstallOptions {
  answers: OnboardAnswers;
  codexHome: string;
  ledger: OnboardFileLedger;
  runner: CommandRunner;
}

export async function installCodexmuxPlugin(
  options: PluginInstallOptions,
): Promise<void> {
  ensureDirectory(options.codexHome, options.ledger, 'dispatcher CODEX_HOME', {
    dryRun: options.answers.dryRun,
  });
  const before = snapshotFiles(options.codexHome);
  await options.runner.run(
    options.answers.codexBin,
    [
      'plugin',
      'marketplace',
      'add',
      options.answers.codexMarketplaceSource,
      ...sparseArgs(options.answers.codexMarketplaceSparse),
    ],
    {
      env: { ...process.env, CODEX_HOME: options.codexHome },
      dryRun: options.answers.dryRun,
    },
  );
  await options.runner.run(
    options.answers.codexBin,
    ['plugin', 'add', options.answers.codexPluginRef],
    {
      env: { ...process.env, CODEX_HOME: options.codexHome },
      dryRun: options.answers.dryRun,
    },
  );
  recordFileTreeChanges(
    options.codexHome,
    before,
    options.ledger,
    'codex plugin install',
  );
}

export async function installClaudemuxPlugin(
  options: PluginInstallOptions,
): Promise<void> {
  ensureDirectory(
    options.answers.claudeConfigDir,
    options.ledger,
    'Claude config directory',
    { dryRun: options.answers.dryRun },
  );
  const before = snapshotFiles(options.answers.claudeConfigDir);
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: options.answers.claudeConfigDir,
  };
  await options.runner.run(
    options.answers.claudeBin,
    [
      'plugin',
      'marketplace',
      'add',
      options.answers.claudeMarketplaceSource,
      ...sparseArgs(options.answers.claudeMarketplaceSparse),
      '--scope',
      'user',
    ],
    { env, dryRun: options.answers.dryRun },
  );
  await options.runner.run(
    options.answers.claudeBin,
    ['plugin', 'install', options.answers.claudePluginRef, '--scope', 'user'],
    { env, dryRun: options.answers.dryRun },
  );
  recordFileTreeChanges(
    options.answers.claudeConfigDir,
    before,
    options.ledger,
    'claude plugin install',
  );
}

function sparseArgs(paths: string[]): string[] {
  return paths.flatMap((path) => ['--sparse', path]);
}
