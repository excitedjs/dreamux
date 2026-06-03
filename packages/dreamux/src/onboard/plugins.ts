import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

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
  ensureDirectory(options.codexHome, options.ledger, 'operator Codex home', {
    dryRun: options.answers.dryRun,
  });
  const before = snapshotFiles(options.codexHome);
  const env = { ...process.env, CODEX_HOME: options.codexHome };
  if (!codexMarketplaceConfigured(options)) {
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
        env,
        dryRun: options.answers.dryRun,
      },
    );
  }
  if (!codexPluginInstalled(options.codexHome, options.answers.codexPluginRef)) {
    await options.runner.run(
      options.answers.codexBin,
      ['plugin', 'add', options.answers.codexPluginRef],
      {
        env,
        dryRun: options.answers.dryRun,
      },
    );
  }
  recordFileTreeChanges(
    options.codexHome,
    before,
    options.ledger,
    'codex plugin install',
  );
  if (
    !options.answers.dryRun &&
    !codexPluginInstalled(options.codexHome, options.answers.codexPluginRef)
  ) {
    throw new Error(
      `codex plugin install did not produce ${pluginName(options.answers.codexPluginRef)} under ${join(options.codexHome, 'plugins')}`,
    );
  }
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
  const installedBefore = await claudePluginInstalled(options, env);
  if (!installedBefore) {
    if (!claudeMarketplaceConfigured(options.answers)) {
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
    }
    await options.runner.run(
      options.answers.claudeBin,
      ['plugin', 'install', options.answers.claudePluginRef, '--scope', 'user'],
      { env, dryRun: options.answers.dryRun },
    );
  }
  recordFileTreeChanges(
    options.answers.claudeConfigDir,
    before,
    options.ledger,
    'claude plugin install',
  );
  if (!options.answers.dryRun && !(await claudePluginInstalled(options, env))) {
    throw new Error(
      `claude plugin install did not report ${options.answers.claudePluginRef} in claude plugin list --json`,
    );
  }
}

function sparseArgs(paths: string[]): string[] {
  return paths.flatMap((path) => ['--sparse', path]);
}

function codexMarketplaceConfigured(options: PluginInstallOptions): boolean {
  const configPath = join(options.codexHome, 'config.toml');
  if (!existsSync(configPath)) return false;
  try {
    const parsed = parseToml(readFileSync(configPath, 'utf8'));
    const marketplaces = recordValue(recordValue(parsed)['marketplaces']);
    const marketplace = recordValue(
      marketplaces[options.answers.codexMarketplaceName],
    );
    return marketplace['source'] === options.answers.codexMarketplaceSource;
  } catch {
    return false;
  }
}

function codexPluginInstalled(codexHome: string, ref: string): boolean {
  return hasPathSegment(join(codexHome, 'plugins'), pluginName(ref), 6);
}

function claudeMarketplaceConfigured(answers: OnboardAnswers): boolean {
  return (
    claudeSettingsHasMarketplace(answers) ||
    claudeKnownMarketplacesHasMarketplace(answers)
  );
}

function claudeSettingsHasMarketplace(answers: OnboardAnswers): boolean {
  const settingsPath = join(answers.claudeConfigDir, 'settings.json');
  const parsed = readJsonObject(settingsPath);
  if (parsed === null) return false;
  const marketplaces = recordValue(parsed['extraKnownMarketplaces']);
  const marketplace = recordValue(marketplaces[answers.claudeMarketplaceName]);
  return claudeMarketplaceSourceMatches(marketplace, answers);
}

function claudeKnownMarketplacesHasMarketplace(
  answers: OnboardAnswers,
): boolean {
  const knownPath = join(
    answers.claudeConfigDir,
    'plugins',
    'known_marketplaces.json',
  );
  const parsed = readJsonObject(knownPath);
  if (parsed === null) return false;
  const marketplace = recordValue(parsed[answers.claudeMarketplaceName]);
  return claudeMarketplaceSourceMatches(marketplace, answers);
}

function claudeMarketplaceSourceMatches(
  marketplace: Record<string, unknown>,
  answers: OnboardAnswers,
): boolean {
  if (Object.keys(marketplace).length === 0) return false;
  const source = recordValue(marketplace['source']);
  const directSource = stringValue(marketplace['source']);
  if (directSource === answers.claudeMarketplaceSource) return true;
  const repo = stringValue(source['repo']);
  if (repo === answers.claudeMarketplaceSource) return true;
  const path = stringValue(source['path']);
  if (path === answers.claudeMarketplaceSource) return true;
  const url = stringValue(source['url']);
  if (url === answers.claudeMarketplaceSource) return true;
  return false;
}

async function claudePluginInstalled(
  options: PluginInstallOptions,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (options.answers.dryRun) return false;
  let raw: string;
  try {
    raw = await options.runner.capture(
      options.answers.claudeBin,
      ['plugin', 'list', '--json'],
      { env },
    );
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const expected = pluginName(options.answers.claudePluginRef);
  const expectedRef = options.answers.claudePluginRef;
  return parsed.some((item) => {
    const record = recordValue(item);
    return [record['name'], record['id'], record['plugin'], record['ref']].some(
      (value) => value === expected || value === expectedRef,
    );
  });
}

function pluginName(ref: string): string {
  return ref.split('@')[0] ?? ref;
}

function hasPathSegment(root: string, segment: string, maxDepth: number): boolean {
  if (!existsSync(root)) return false;
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (basename(current.path) === segment) return true;
    if (current.depth >= maxDepth) continue;
    let entries: string[];
    try {
      entries = readdirSync(current.path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current.path, entry);
      try {
        if (statSync(child).isDirectory()) {
          stack.push({ path: child, depth: current.depth + 1 });
        }
      } catch {
        /* ignore transient filesystem races */
      }
    }
  }
  return false;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return recordValue(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}
