import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

it.each([
  'cli/server',
  'daemon/control',
  'daemon/install',
  'daemon/status',
  'service/workflow-service/runner',
  'mcp/shim',
])(
  'imports built %s without loading the Koffi addon',
  async (entry) => {
    const moduleUrl = new URL(`../dist/${entry}.js`, import.meta.url).href;
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--experimental-vm-modules',
        '--input-type=module',
        '-e',
        `
        const loaded = [];
        const dlopen = process.dlopen;
        process.dlopen = function (...args) {
          if (String(args[1]).includes('koffi')) loaded.push(String(args[1]));
          return Reflect.apply(dlopen, this, args);
        };
        await import(${JSON.stringify(moduleUrl)});
        console.log(JSON.stringify(loaded));
      `,
      ],
      { windowsHide: true, timeout: 10_000 },
    );
    expect(JSON.parse(stdout)).toEqual([]);
  },
  15_000,
);
