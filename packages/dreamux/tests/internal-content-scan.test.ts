import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const SCAN_SCRIPT = join(
  REPO_ROOT,
  'common',
  'scripts',
  'check-internal-content.mjs',
);
const SEP = '/';
const MOUNT = `${SEP}data00${SEP}`;
const home = (user: string): string => `${SEP}home${SEP}${user}${SEP}`;
const diagnosticStart = performance.now();

function diagnostic(event: string, fields: Record<string, unknown> = {}) {
  console.error(
    'PR476_CONTENT_SCAN_DIAG ' +
      JSON.stringify({
        source: 'test',
        pid: process.pid,
        event,
        monotonicMs: performance.now(),
        elapsedMs: performance.now() - diagnosticStart,
        ...fields,
      }),
  );
}

function diagnosticError(error: unknown): unknown {
  return error instanceof Error
    ? {
        ...error,
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: diagnosticError(error.cause),
      }
    : error;
}

async function temporary(use: (dir: string) => Promise<void>): Promise<void> {
  const testName = expect.getState().currentTestName;
  try {
    diagnostic('temp.mkdtemp.begin', { testName });
    const dir = await mkdtemp(join(tmpdir(), 'internal-content-'));
    diagnostic('temp.mkdtemp.end', { testName, dir });
    try {
      diagnostic('fixture.body.begin', { testName, dir });
      return await use(dir);
    } catch (error) {
      diagnostic('fixture.body.error', {
        testName,
        dir,
        error: diagnosticError(error),
      });
      throw error;
    } finally {
      diagnostic('fixture.body.settled', { testName, dir });
      diagnostic('finally.rm.begin', { testName, dir });
      try {
        await rm(dir, { recursive: true, force: true });
        diagnostic('finally.rm.end', { testName, dir });
      } catch (error) {
        diagnostic('finally.rm.error', {
          testName,
          dir,
          error: diagnosticError(error),
        });
        throw error;
      }
    }
  } catch (error) {
    diagnostic('fixture.error', { testName, error: diagnosticError(error) });
    throw error;
  }
}

function scan(args: string[], cwd?: string) {
  diagnostic('scan.node.request', { args, cwd });
  const child = execa(process.execPath, [SCAN_SCRIPT, ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    reject: false,
    windowsHide: true,
  });
  diagnostic('scan.node.created', { args, cwd, childPid: child.pid });
  child.once('spawn', () =>
    diagnostic('scan.node.spawn', { args, cwd, childPid: child.pid }),
  );
  child.once('exit', (code, signal) =>
    diagnostic('scan.node.exit', {
      args,
      cwd,
      childPid: child.pid,
      code,
      signal,
    }),
  );
  child.once('close', (code, signal) =>
    diagnostic('scan.node.close', {
      args,
      cwd,
      childPid: child.pid,
      code,
      signal,
    }),
  );
  child.stderr?.on('data', (chunk: Buffer) =>
    diagnostic('scan.node.stderr', {
      args,
      cwd,
      childPid: child.pid,
      chunk: chunk.toString(),
    }),
  );
  return child;
}

function reported(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => line.trim())
    .sort();
}

describe('internal-content index scan', () => {
  it('keeps exact placeholder matching and reads staged Unicode paths rather than changed working files', async () => {
    return temporary(async (dir) => {
      diagnostic('index.git.init.begin', { dir });
      await execa('git', ['init', '--quiet', dir]);
      diagnostic('index.git.init.end', { dir });
      const file = join(dir, '用户 notes.txt');
      diagnostic('index.write.staged.begin', { dir });
      await writeFile(
        file,
        [
          `${home('me')}work`,
          `${home('meredith')}work`,
          `${home('mexico')}work`,
          `${home('meredith2')}work`,
          `${home('volta')}bin/node`,
          `${MOUNT}home/someone/work`,
        ].join('\n'),
      );
      diagnostic('index.write.staged.end', { dir });
      diagnostic('index.git.add.begin', { dir });
      await execa('git', ['add', '--', '用户 notes.txt'], { cwd: dir });
      diagnostic('index.git.add.end', { dir });
      diagnostic('index.write.working.begin', { dir });
      await writeFile(file, 'clean working tree');
      diagnostic('index.write.working.end', { dir });
      for (const mode of ['--staged', '--tree']) {
        diagnostic('index.scan.begin', { dir, mode });
        const result = await scan([mode], dir);
        diagnostic('index.scan.end', { dir, mode, exitCode: result.exitCode });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('用户 notes.txt');
        expect(reported(result.stderr)).toEqual([
          MOUNT,
          home('meredith2'),
          home('mexico'),
        ]);
      }
    });
  });

  it('rejects each protected identifier format even in binary file content', async () => {
    return temporary(async (dir) => {
      diagnostic('binary.git.init.begin', { dir });
      await execa('git', ['init', '--quiet', dir]);
      diagnostic('binary.git.init.end', { dir });
      const identifiers = [
        'ou' + '_' + 'A'.repeat(20),
        'oc' + '_' + 'B'.repeat(20),
        'cli' + '_' + 'C'.repeat(16),
      ];
      diagnostic('binary.write.begin', { dir });
      await writeFile(
        join(dir, 'content.bin'),
        `\0${identifiers.join('\0')}\0`,
      );
      diagnostic('binary.write.end', { dir });
      diagnostic('binary.git.add.begin', { dir });
      await execa('git', ['add', 'content.bin'], { cwd: dir });
      diagnostic('binary.git.add.end', { dir });
      diagnostic('binary.scan.begin', { dir });
      const result = await scan(['--staged'], dir);
      diagnostic('binary.scan.end', { dir, exitCode: result.exitCode });
      expect(result.exitCode).toBe(1);
      expect(reported(result.stderr)).toEqual([...identifiers].sort());
    });
  });
});

describe('internal-content tarball scan', () => {
  async function pack(
    dir: string,
    name: string,
    content: string,
  ): Promise<string> {
    diagnostic('pack.mkdir.begin', { dir, name });
    await mkdir(join(dir, 'package', 'dist'), { recursive: true });
    diagnostic('pack.mkdir.end', { dir, name });
    diagnostic('pack.write.manifest.begin', { dir, name });
    await writeFile(
      join(dir, 'package', 'package.json'),
      '{"name":"fixture"}\n',
    );
    diagnostic('pack.write.manifest.end', { dir, name });
    diagnostic('pack.write.index.begin', { dir, name });
    await writeFile(join(dir, 'package', 'dist', 'index.js'), content);
    diagnostic('pack.write.index.end', { dir, name });
    const archive = join(dir, `${name}.tgz`);
    diagnostic('pack.tar.request', { dir, name, archive });
    const child = execa('tar', ['-czf', archive, '-C', dir, 'package'], {
      windowsHide: true,
    });
    diagnostic('pack.tar.created', {
      dir,
      name,
      archive,
      childPid: child.pid,
      spawnfile: child.spawnfile,
    });
    child.once('spawn', () =>
      diagnostic('pack.tar.spawn', { dir, name, archive, childPid: child.pid }),
    );
    child.once('exit', (code, signal) =>
      diagnostic('pack.tar.exit', {
        dir,
        name,
        archive,
        childPid: child.pid,
        code,
        signal,
      }),
    );
    child.once('close', (code, signal) =>
      diagnostic('pack.tar.close', {
        dir,
        name,
        archive,
        childPid: child.pid,
        code,
        signal,
      }),
    );
    diagnostic('pack.tar.await.begin', {
      dir,
      name,
      archive,
      childPid: child.pid,
    });
    await child;
    diagnostic('pack.tar.await.end', {
      dir,
      name,
      archive,
      childPid: child.pid,
    });
    return archive;
  }

  it('rejects source-only placeholders and near matches in packed files', async () => {
    return temporary(async (dir) => {
      diagnostic('leaky.pack.begin', { dir });
      const archive = await pack(
        dir,
        'leaky',
        [
          home('volta'),
          home('linuxbrew'),
          home('linuxbrew2'),
          home('example'),
          home('someone'),
          MOUNT,
        ].join('\n'),
      );
      diagnostic('leaky.pack.end', { dir, archive });
      diagnostic('leaky.scan.begin', { dir, archive });
      const result = await scan(['--tarball', archive]);
      diagnostic('leaky.scan.end', { dir, archive, exitCode: result.exitCode });
      expect(result.exitCode).toBe(1);
      expect(reported(result.stderr)).toEqual([
        MOUNT,
        home('example'),
        home('linuxbrew2'),
        home('someone'),
      ]);
    });
  });

  it('accepts public install locations and rejects missing or invalid archives', async () => {
    return temporary(async (dir) => {
      diagnostic('clean.pack.begin', { dir });
      const archive = await pack(
        dir,
        'clean',
        [home('volta'), home('linuxbrew')].join('\n'),
      );
      diagnostic('clean.pack.end', { dir, archive });
      diagnostic('clean.scan.valid.begin', { dir, archive });
      expect((await scan(['--tarball', archive])).exitCode).toBe(0);
      diagnostic('clean.scan.valid.end', { dir, archive });
      diagnostic('clean.scan.missing.begin', { dir, archive });
      expect(
        (await scan(['--tarball', join(dirname(archive), 'missing.tgz')]))
          .exitCode,
      ).toBe(2);
      diagnostic('clean.scan.missing.end', { dir, archive });
      diagnostic('clean.write.invalid.begin', { dir, archive });
      await writeFile(archive, 'not an archive');
      diagnostic('clean.write.invalid.end', { dir, archive });
      diagnostic('clean.scan.invalid.begin', { dir, archive });
      expect((await scan(['--tarball', archive])).exitCode).toBe(2);
      diagnostic('clean.scan.invalid.end', { dir, archive });
    });
  });
});
