import { execFile } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { observed } from './observe-home.mjs';

await writeFile(process.env.ISOLATION_IMPORT_MARKER, 'test module imported');
// These writes also prove the directories exist before test-module evaluation.
for (const directory of new Set([
  observed.home,
  observed.CODEX_HOME,
  observed.CLAUDE_CONFIG_DIR,
  observed.DREAMUX_ROOT,
])) {
  await writeFile(join(directory, 'test-marker'), 'isolated import');
}

it('observes native homes and inherited child environment', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { observed } from ${JSON.stringify(new URL('./observe-home.mjs', import.meta.url).href)};
console.log(JSON.stringify(observed));`,
    ],
    { windowsHide: true },
  );
  const auth = observed.authSource
    ? await readFile(join(observed.authSource, 'auth.json'), 'utf8')
    : null;
  await appendFile(
    process.env.ISOLATION_REPORT,
    `${JSON.stringify({ imported: observed, child: JSON.parse(stdout), auth })}\n`,
  );
  expect(process.env.ISOLATION_FAIL).not.toBe('1');
});
