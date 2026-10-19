import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  environmentValue,
  resolveExecutableOnPath,
  spawnCommand,
} from '../src/process-command.js';

describe('native command launch', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('passes arguments to a native executable without shell interpretation', async () => {
    const args = ['a b', 'a"b', 'x&y', '%PATH%', 'trailing\\'];
    const child = await spawnCommand('node', [
      '-e',
      'console.log(JSON.stringify(process.argv.slice(1)))',
      '--',
      ...args,
    ]);
    let stdout = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const [code] = await once(child, 'close');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(args);
  });

  it.skipIf(process.platform !== 'win32')(
    'selects the same executable as Node with merged Path and PATH overrides',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'dreamux path override '));
      const ambient = join(root, 'ambient');
      const override = join(root, 'override');
      const command = 'fixture-provider.exe';
      for (const directory of [ambient, override]) {
        await mkdir(directory);
        await copyFile(process.execPath, join(directory, command));
      }
      const env = { Path: ambient, ...{ PATH: override } };
      const args = [
        '-e',
        'console.log(JSON.stringify({ exe: process.execPath, path: process.env.PATH }))',
      ];
      const native = await promisify(execFile)(command, args, {
        env,
        windowsHide: true,
      });
      const expected = { exe: join(override, command), path: override };
      expect(JSON.parse(native.stdout)).toEqual(expected);
      const child = await spawnCommand(command, args, { env });
      let stdout = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      const [code] = await once(child, 'close');
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual(expected);
    },
  );

  it.skipIf(process.platform !== 'win32').each([
    { Dreamux_Test_Env: 'ambient', DREAMUX_TEST_ENV: 'override' },
    { DREAMUX_TEST_ENV: 'override', Dreamux_Test_Env: 'ambient' },
    { Dreamux_Test_Env: 'ambient', DREAMUX_TEST_ENV: undefined },
    { Dreamux_Test_Env: undefined, DREAMUX_TEST_ENV: 'override' },
  ])('matches Node environment selection for %j', async (env) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '-e',
        'console.log(JSON.stringify(process.env.DREAMUX_TEST_ENV ?? null))',
      ],
      { env, windowsHide: true },
    );
    expect(environmentValue(env, 'DREAMUX_TEST_ENV') ?? null).toEqual(
      JSON.parse(stdout),
    );
  });

  it.skipIf(process.platform !== 'win32')(
    'resolves and launches npm command shims from a PATH containing spaces',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'dreamux command spaces '));
      const binDir = join(root, 'node_modules', '.bin');
      await mkdir(binDir, { recursive: true });
      const script = join(root, 'argv.cjs');
      await writeFile(
        script,
        'console.log(JSON.stringify(process.argv.slice(2)))',
      );
      const shim = join(binDir, 'test-command.cmd');
      await writeFile(
        shim,
        `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      );
      const env = {
        Path: `${join(root, 'missing')}${delimiter}${binDir}`,
        PATHEXT: '.EXE;.CMD',
      };
      expect(
        (await resolveExecutableOnPath('test-command', env))?.toLowerCase(),
      ).toBe(shim.toLowerCase());
      const args = [
        'a b',
        'a"b',
        'x&y',
        '%PATH%',
        'trailing\\',
        '{"hello":"x | y"}',
      ];
      const child = await spawnCommand('test-command', args, { env });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const [code] = await once(child, 'close');
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      expect(JSON.parse(stdout)).toEqual(args);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'launches an npm Node shim with complete multiline arguments',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'dreamux npm shim '));
      const script = join(root, 'argv.cjs');
      await writeFile(
        script,
        'console.log(JSON.stringify(process.argv.slice(2)))',
      );
      await writeFile(
        join(root, 'test-command.cmd'),
        `@ECHO off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\argv.cjs" %*\r\n`,
      );
      const args = [
        'first\nsecond',
        '<system-reminder>\r\nline one\r\nline two\r\n</system-reminder>',
        'x&y',
        '%PATH%',
        '{"hello":"a b"}',
      ];
      const child = await spawnCommand('test-command', args, {
        env: {
          Path: `${root}${delimiter}${dirname(process.execPath)}`,
          PATHEXT: '.EXE;.CMD',
        },
      });
      let stdout = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      const [code] = await once(child, 'close');
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual(args);
    },
  );
});
