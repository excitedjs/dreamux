import { homedir } from 'node:os';

// Evaluated on import, before the test body or any test hook runs.
export const observed = {
  home: homedir(),
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  DREAMUX_ROOT: process.env.DREAMUX_ROOT,
  authSource: process.env.DREAMUX_TEST_AUTH_HOME,
};
