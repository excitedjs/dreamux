import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export default async function setup({ provide }) {
  const accountHome = homedir();
  // Unix sockets need a short private root outside shared /tmp.
  const parent = process.platform === 'win32' ? tmpdir() : accountHome;
  const testHome = await mkdtemp(join(parent, '.dt-'));
  const env = {
    HOME: testHome,
    USERPROFILE: testHome,
    CODEX_HOME: join(testHome, '.codex'),
    CLAUDE_CONFIG_DIR: join(testHome, '.claude'),
    DREAMUX_ROOT: join(testHome, '.dreamux'),
    DREAMUX_TEST_AUTH_HOME:
      process.env.DREAMUX_RUN_LIVE_MODEL_GATE === '1'
        ? (process.env.CODEX_HOME ?? join(accountHome, '.codex'))
        : null,
  };
  async function teardown() {
    // Only remove this setup's mkdtemp result, never a path read back from env.
    await rm(testHome, { recursive: true, force: true, maxRetries: 3 });
  }
  try {
    await mkdir(env.CODEX_HOME);
    await mkdir(env.CLAUDE_CONFIG_DIR);
    await mkdir(env.DREAMUX_ROOT);
    provide('isolatedTestEnvironment', env);
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
