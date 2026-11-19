import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startVitest } from 'vitest/node';

const root = process.argv[2];
const vitest = await startVitest('test', [], {
  root,
  config: join(root, 'vitest.config.mjs'),
  watch: true,
  maxWorkers: 1,
  minWorkers: 1,
});
let home;
try {
  if (!vitest) throw new Error('Vitest did not start');
  const first = JSON.parse(
    (await readFile(process.env.ISOLATION_REPORT, 'utf8')).trim(),
  );
  home = first.imported.home;
  await access(home);
  await vitest.rerunFiles();
  await access(home);
} finally {
  await vitest?.close();
}
await writeFile(
  join(root, 'watch.json'),
  JSON.stringify({ home, runnerAuth: process.env.DREAMUX_TEST_AUTH_HOME }),
);
