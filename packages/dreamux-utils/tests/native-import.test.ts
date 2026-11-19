import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const utilsModule = new URL('../dist/index.js', import.meta.url).href;
const execFileAsync = promisify(execFile);

async function probe(body: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        const loaded = [];
        const dlopen = process.dlopen;
        process.dlopen = function (...args) {
          if (String(args[1]).includes('koffi')) loaded.push(String(args[1]));
          return Reflect.apply(dlopen, this, args);
        };
        const utils = await import(${JSON.stringify(utilsModule)});
        ${body}
      `,
    ],
    { windowsHide: true, timeout: 10_000 },
  );
  return JSON.parse(stdout) as unknown;
}

it('imports the built utils barrel without loading the Koffi addon', async () => {
  expect(await probe('console.log(JSON.stringify(loaded));')).toEqual([]);
}, 15_000);

it.skipIf(process.platform !== 'win32')(
  'loads Koffi on concurrent first Windows capability calls',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dreamux-lazy-native-'));
    try {
      const result = await probe(`
        assert.deepEqual(loaded, []);
        const { randomUUID } = await import('node:crypto');
        const { join } = await import('node:path');
        const operations = Array.from({ length: 4 }, async () => {
          const name = 'Local\\\\Dreamux-lazy-' + randomUUID();
          const job = await utils.WindowsJob.create(name);
          try {
            assert.equal(await job.containsCurrentProcess(), false);
            const opened = await utils.WindowsJob.open(name);
            assert.ok(opened);
            opened.close();
            const acquired = await utils.WindowsJob.acquire(name);
            acquired.close();
          } finally {
            job.close();
            job.close();
          }
          assert.equal(await utils.WindowsJob.open(name), null);
        });
        operations.push(...Array.from({ length: 4 }, (_, index) =>
          utils.ensureOwnerOnlyDir(join(${JSON.stringify(root)}, String(index)))
        ));
        await Promise.all(operations);
        console.log(JSON.stringify({ loads: loaded.length, operations: operations.length }));
      `);
      expect(result).toEqual({ loads: 1, operations: 8 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
