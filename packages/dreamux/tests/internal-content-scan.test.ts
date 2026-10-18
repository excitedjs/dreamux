import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

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
const dirs: string[] = [];
const SEP = '/';
const MOUNT = `${SEP}data00${SEP}`;
const home = (user: string): string => `${SEP}home${SEP}${user}${SEP}`;

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'internal-content-'));
  dirs.push(dir);
  return dir;
}

function scan(args: string[], cwd?: string) {
  return execa(process.execPath, [SCAN_SCRIPT, ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    reject: false,
    windowsHide: true,
  });
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
    const dir = await temporary();
    await execa('git', ['init', '--quiet', dir]);
    const file = join(dir, '用户 notes.txt');
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
    await execa('git', ['add', '--', '用户 notes.txt'], { cwd: dir });
    await writeFile(file, 'clean working tree');
    for (const mode of ['--staged', '--tree']) {
      const result = await scan([mode], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('用户 notes.txt');
      expect(reported(result.stderr)).toEqual([
        MOUNT,
        home('meredith2'),
        home('mexico'),
      ]);
    }
  });

  it('rejects each protected identifier format even in binary file content', async () => {
    const dir = await temporary();
    await execa('git', ['init', '--quiet', dir]);
    const identifiers = [
      'ou' + '_' + 'A'.repeat(20),
      'oc' + '_' + 'B'.repeat(20),
      'cli' + '_' + 'C'.repeat(16),
    ];
    await writeFile(join(dir, 'content.bin'), `\0${identifiers.join('\0')}\0`);
    await execa('git', ['add', 'content.bin'], { cwd: dir });
    const result = await scan(['--staged'], dir);
    expect(result.exitCode).toBe(1);
    expect(reported(result.stderr)).toEqual([...identifiers].sort());
  });
});

describe('internal-content tarball scan', () => {
  async function pack(name: string, content: string): Promise<string> {
    const dir = await temporary();
    await mkdir(join(dir, 'package', 'dist'), { recursive: true });
    await writeFile(
      join(dir, 'package', 'package.json'),
      '{"name":"fixture"}\n',
    );
    await writeFile(join(dir, 'package', 'dist', 'index.js'), content);
    const archive = join(dir, `${name}.tgz`);
    await execa('tar', ['-czf', archive, '-C', dir, 'package'], {
      windowsHide: true,
    });
    return archive;
  }

  it('rejects source-only placeholders and near matches in packed files', async () => {
    const archive = await pack(
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
    const result = await scan(['--tarball', archive]);
    expect(result.exitCode).toBe(1);
    expect(reported(result.stderr)).toEqual([
      MOUNT,
      home('example'),
      home('linuxbrew2'),
      home('someone'),
    ]);
  });

  it('accepts public install locations and rejects missing or invalid archives', async () => {
    const archive = await pack(
      'clean',
      [home('volta'), home('linuxbrew')].join('\n'),
    );
    expect((await scan(['--tarball', archive])).exitCode).toBe(0);
    expect(
      (await scan(['--tarball', join(dirname(archive), 'missing.tgz')]))
        .exitCode,
    ).toBe(2);
    await writeFile(archive, 'not an archive');
    expect((await scan(['--tarball', archive])).exitCode).toBe(2);
  });
});
