#!/usr/bin/env node
// Mandatory staged lint, author identity, secret and internal-content gates.
import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { authorEmailError } from './check-author-emails.mjs';

const execFileAsync = promisify(execFile);
const git = async (args) =>
  (await execFileAsync('git', args, { windowsHide: true })).stdout.trimEnd();
async function exists(path, mode) {
  try {
    await access(path, mode);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return false;
    throw error;
  }
}
async function run(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} failed with exit code ${code}`)),
    );
  });
}

async function main() {
  const root = resolve(await git(['rev-parse', '--show-toplevel']));
  const staged = (
    await git([
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACMR',
      '-z',
      '--',
      '*.ts',
    ])
  )
    .split('\0')
    .filter(Boolean);
  const packages = new Map();
  for (const file of staged) {
    let directory = dirname(resolve(root, file));
    while (directory !== root && directory !== dirname(directory)) {
      if (await exists(join(directory, 'eslint.config.js'))) {
        const relative = resolve(root, file)
          .slice(directory.length + 1)
          .replaceAll('\\', '/');
        if (relative.startsWith('src/') || relative.startsWith('tests/')) {
          const files = packages.get(directory) ?? [];
          files.push(relative);
          packages.set(directory, files);
        }
        break;
      }
      directory = dirname(directory);
    }
  }
  for (const [directory, files] of packages) {
    let eslint;
    try {
      const require = createRequire(join(directory, 'package.json'));
      eslint = join(
        dirname(require.resolve('eslint/package.json')),
        'bin',
        'eslint.js',
      );
    } catch {
      throw new Error(
        '[staged-eslint] ESLint is missing. Run: node common/scripts/install-run-rush.js update',
      );
    }
    await run(process.execPath, [eslint, ...files], directory);
  }
  const email =
    process.env.GIT_AUTHOR_EMAIL ||
    (await git(['config', '--get', 'user.email']).catch(() => ''));
  const authorError = authorEmailError(email);
  if (authorError)
    throw new Error(
      `[author-identity] ${authorError}. Set an allowed email with git config user.email.`,
    );

  const binary = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks';
  const pathKey = Object.keys(process.env).find(
    (key) => key.toLowerCase() === 'path',
  );
  const directories = [
    ...(process.env[pathKey] ?? '').split(delimiter).filter(Boolean),
    ...(process.env.GITLEAKS_INSTALL_DIR
      ? [process.env.GITLEAKS_INSTALL_DIR]
      : []),
    join(homedir(), '.local', 'bin'),
  ];
  let gitleaks;
  for (const directory of directories) {
    const candidate = join(directory, binary);
    if (await exists(candidate, constants.X_OK)) {
      gitleaks = candidate;
      break;
    }
  }
  if (!gitleaks)
    throw new Error(
      '[anti-leak] gitleaks is not installed — refusing to commit. This gate must not be skipped. Install it: node common/scripts/install-gitleaks.mjs',
    );
  await run(
    gitleaks,
    [
      'git',
      '--staged',
      '--config',
      join(root, '.gitleaks.toml'),
      '--redact',
      '--exit-code',
      '1',
      '-v',
    ],
    root,
  );
  await run(
    process.execPath,
    [join(root, 'common', 'scripts', 'check-internal-content.mjs'), '--staged'],
    root,
  );
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
