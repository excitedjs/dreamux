#!/usr/bin/env node
// Run every package's tests with disposable application and account homes.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const accountHome = homedir();
// Unix sockets need a short private root outside shared /tmp. Windows uses pipes.
const temporaryParent = process.platform === 'win32' ? tmpdir() : accountHome;
const testHome = await mkdtemp(join(temporaryParent, '.dt-'));
const env = { ...process.env };
if (env.DREAMUX_RUN_LIVE_MODEL_GATE === '1') {
  env.DREAMUX_TEST_AUTH_HOME = env.CODEX_HOME ?? join(accountHome, '.codex');
} else {
  delete env.DREAMUX_TEST_AUTH_HOME;
}
Object.assign(env, {
  HOME: testHome,
  USERPROFILE: testHome,
  CODEX_HOME: join(testHome, '.codex'),
  CLAUDE_CONFIG_DIR: join(testHome, '.claude'),
  DREAMUX_ROOT: join(testHome, '.dreamux'),
});

try {
  await Promise.all([
    mkdir(env.CODEX_HOME),
    mkdir(env.CLAUDE_CONFIG_DIR),
    mkdir(env.DREAMUX_ROOT),
  ]);
  const require = createRequire(join(process.cwd(), 'package.json'));
  const cli = join(
    dirname(require.resolve('vitest/package.json')),
    'vitest.mjs',
  );
  const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  const forward = (signal) => child.kill(signal);
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    process.exitCode = await new Promise((fulfill, reject) => {
      child.once('error', reject);
      child.once('close', (code) => fulfill(code ?? 1));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
} finally {
  // This is the unique directory returned by mkdtemp, never a child-selected home.
  if (dirname(resolve(testHome)) !== resolve(temporaryParent)) {
    throw new Error('Test home escaped its temporary parent');
  }
  await rm(testHome, { recursive: true, force: true, maxRetries: 3 });
}
