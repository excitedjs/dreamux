import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { once } from 'node:events';
import { access, constants, readFile, stat } from 'node:fs/promises';
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve a file using the supplied PATH and Windows PATHEXT, without a shell. */
export async function resolveExecutableOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<string | null> {
  if (bin === '') return null;
  const pathValue = environmentValue(env, 'PATH') ?? '';
  const candidates =
    bin.includes(sep) || bin.includes('/')
      ? [isAbsolute(bin) ? bin : resolve(cwd, bin)]
      : pathValue
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => resolve(cwd, dir.replace(/^"|"$/g, ''), bin));
  const extensions =
    process.platform === 'win32' && extname(bin) === ''
      ? (environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : [''];
  for (const candidate of candidates) {
    for (const extension of extensions) {
      const path = candidate + extension;
      try {
        await access(
          path,
          process.platform === 'win32' ? constants.F_OK : constants.X_OK,
        );
        if ((await stat(path)).isFile()) return path;
      } catch {
        // Search the remaining PATH entries when this candidate is absent.
      }
    }
  }
  return null;
}

/** Windows environment variable names are case-insensitive. */
export function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const key =
    process.platform === 'win32'
      ? Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase())
      : name;
  return key === undefined ? undefined : env[key];
}

/** Let Windows PowerShell rebuild its own module paths when launched from pwsh. */
export function windowsPowerShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // A pwsh -> Node -> powershell.exe launch otherwise inherits PowerShell 7's
  // modules, whose shared names shadow incompatible Windows PowerShell modules.
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
  );
}

/** Spawn a native executable or a Windows command shim with literal arguments. */
export async function spawnCommand(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): Promise<ChildProcess> {
  const resolved =
    process.platform === 'win32' && !options.shell
      ? ((await resolveExecutableOnPath(
          command,
          options.env,
          options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd,
        )) ?? command)
      : command;
  let child: ChildProcess;
  if (
    process.platform !== 'win32' ||
    options.shell ||
    !/\.(?:cmd|bat)$/i.test(resolved)
  ) {
    child = spawn(resolved, [...args], { ...options, windowsHide: true });
  } else {
    const nodeEntry = await npmNodeEntry(resolved, options);
    if (nodeEntry !== null) {
      child = spawn(nodeEntry.node, [nodeEntry.script, ...args], {
        ...options,
        windowsHide: true,
      });
    } else {
      if (args.some((arg) => /[\r\n]/.test(arg))) {
        throw new Error(
          'Windows batch commands cannot preserve multiline arguments; configure the executable directly',
        );
      }
      child = spawnWindowsCommand(resolved, args, options);
    }
  }
  await once(child, 'spawn');
  return child;
}

/** npm's Node shim is a launcher description; cmd.exe would truncate multiline prompts. */
async function npmNodeEntry(
  command: string,
  options: SpawnOptions,
): Promise<{ node: string; script: string } | null> {
  const shim = await readFile(command, 'utf8');
  if (!/SET\s+"_prog=node(?:\.exe)?"/i.test(shim)) return null;
  const target = shim.match(/"%_prog%"\s+"%dp0%[\\/]([^"\r\n]+)"\s+%\*/i)?.[1];
  if (target === undefined) return null;
  const cwd =
    options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd;
  const node =
    (await resolveExecutableOnPath(
      join(dirname(command), 'node.exe'),
      options.env,
      cwd,
    )) ??
    (await resolveExecutableOnPath('node', options.env, cwd)) ??
    'node';
  return { node, script: resolve(dirname(command), target) };
}

function spawnWindowsCommand(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  // npm shims forward %* through a second cmd parse. Escape both passes so
  // model-supplied JSON, paths, and shell metacharacters remain literal argv.
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  const escape = (value: string): string => value.replace(meta, '^$1');
  const quote = (value: string): string =>
    escape(
      escape(
        `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`,
      ),
    );
  const line = [escape(normalize(command)), ...args.map(quote)].join(' ');
  return spawn(
    environmentValue(options.env ?? process.env, 'ComSpec') ??
      join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    ['/d', '/s', '/c', `"${line}"`],
    {
      ...options,
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  );
}
