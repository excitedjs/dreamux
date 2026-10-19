import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { startVitest } from 'vitest/node';

const root = process.argv[2];
const blocked = join(dirname(root), 'ordinary-file');
const original = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
  TMPDIR: process.env.TMPDIR,
};
await writeFile(blocked, 'not a directory');
// Unix creates the isolated home under HOME; Windows uses TEMP.
Object.assign(process.env, {
  HOME: blocked,
  USERPROFILE: blocked,
  TMP: blocked,
  TEMP: blocked,
  TMPDIR: blocked,
});
const vitest = await startVitest('test', [], {
  root,
  config: join(root, 'vitest.config.mjs'),
  watch: true,
  maxWorkers: 1,
  minWorkers: 1,
});
let result;
try {
  if (!vitest) throw new Error('Vitest did not start');
  const initialImportAbsent = await access(
    process.env.ISOLATION_IMPORT_MARKER,
  ).then(
    () => false,
    (error) => {
      if (error.code !== 'ENOENT') throw error;
      return true;
    },
  );
  // Vite also caches this temporary path, so repair the filesystem itself.
  await unlink(blocked);
  await mkdir(blocked);
  Object.assign(process.env, original);
  // This is the native watch "a" / Enter path, including normalized file names.
  const files = await vitest.getTestFilepaths();
  await vitest.changeNamePattern('', files, 'rerun all tests');
  result = {
    initialImportAbsent,
    rerunStates: vitest.state.getFiles().map((file) => file.result?.state),
    errors: vitest.state
      .getFiles()
      .flatMap((file) =>
        (file.result?.errors ?? []).map((error) => error.message),
      ),
  };
} finally {
  await vitest?.close();
}
await writeFile(join(root, 'watch.json'), JSON.stringify(result));
