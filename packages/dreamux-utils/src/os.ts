/**
 * Generic OS/filesystem utilities shared across Dreamux providers and host,
 * vendored into this leaf package so the provider packages depend on
 * `@excitedjs/dreamux-types` (+ this package) only and never import
 * `@excitedjs/dreamux` core. These are platform primitives (process-group
 * signalling, owner-only dir enforcement, empty-log cleanup, existence probe),
 * NOT Dreamux host layout/path/socket/log contracts — those are supplied by the
 * host through the create context and provider options.
 */

import { access, chmod, lstat, mkdir, stat, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** True when `pid` names a live process (EPERM counts as alive). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    return errno === 'EPERM';
  }
}

/** Probe a POSIX group or the Windows tree's root process (EPERM is alive). */
export function isProcessGroupAlive(pgid: number): boolean {
  if (!Number.isFinite(pgid) || pgid <= 0) return false;
  if (process.platform === 'win32') return isProcessAlive(pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ESRCH') return false;
    if (errno === 'EPERM') return true;
    throw error;
  }
}

/** Signal a POSIX group, or terminate and await a Windows tree including descendants. */
export async function killProcessGroup(
  pgid: number,
  signal: NodeJS.Signals | number,
): Promise<void> {
  if (!Number.isFinite(pgid) || pgid <= 0) return;
  if (process.platform === 'win32') {
    if (signal === 0) return;
    // Windows has no POSIX process groups or catchable SIGTERM. taskkill must
    // discover descendants before killing the parent. Wait for every native
    // process to exit so sqlite files and inherited handles are released too.
    await execFileAsync(
      join(
        process.env['SystemRoot'] ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        TERMINATE_TREE_SCRIPT,
      ],
      {
        windowsHide: true,
        env: { ...process.env, DREAMUX_PROCESS_ID: String(pgid) },
      },
    );
    return;
  }
  try {
    process.kill(-pgid, signal);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === 'ESRCH') return;
    throw e;
  }
}

const TERMINATE_TREE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$rootPid = [int]$env:DREAMUX_PROCESS_ID
$processes = @(Get-CimInstance Win32_Process)
$ids = New-Object 'System.Collections.Generic.List[int]'
$ids.Add($rootPid)
for ($index = 0; $index -lt $ids.Count; $index++) {
  foreach ($item in $processes) {
    if ($item.ParentProcessId -eq $ids[$index] -and -not $ids.Contains([int]$item.ProcessId)) {
      $ids.Add([int]$item.ProcessId)
    }
  }
}
foreach ($targetPid in $ids) {
  if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {
    $ErrorActionPreference = 'Continue'
    & "$env:SystemRoot\\System32\\taskkill.exe" /PID $targetPid /T /F 2>$null | Out-Null
    $ErrorActionPreference = 'Stop'
  }
}
$remaining = @(Get-Process -Id $ids.ToArray() -ErrorAction SilentlyContinue)
foreach ($item in $remaining) {
  if (-not $item.WaitForExit(5000)) { throw 'process tree did not exit after taskkill' }
}
`;

export interface EnsureOwnerOnlyDirOptions {
  /** Current-user uid probe override (tests). */
  getuid?: () => number;
}

/**
 * Create/adopt an owner-only directory: 0700 on POSIX, a protected current-user
 * DACL on Windows. Reject symlink leaves and directories owned by another user.
 */
export async function ensureOwnerOnlyDir(
  path: string,
  options: EnsureOwnerOnlyDirOptions = {},
): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(
      `refusing to use Dreamux runtime directory ${path}: it is a symlink, not a real directory`,
    );
  }
  const getuid = options.getuid ?? process.getuid?.bind(process);
  if (getuid !== undefined && info.uid !== getuid()) {
    throw new Error(
      `refusing to use Dreamux runtime directory ${path}: it is owned by uid ${info.uid}, ` +
        `not the current user (uid ${getuid()})`,
    );
  }
  if (process.platform === 'win32') {
    await setWindowsOwnerOnlyAccess(path, 'directory');
    return;
  }
  if ((info.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
  }
}

/** Tighten an existing regular file; never follow a symlink to another path. */
export async function ensureOwnerOnlyFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      `refusing to use Dreamux private file ${path}: it is not a regular file`,
    );
  }
  if (process.platform === 'win32') {
    await setWindowsOwnerOnlyAccess(path, 'file');
  } else {
    await chmod(path, 0o600);
  }
}

async function setWindowsOwnerOnlyAccess(
  path: string,
  kind: 'file' | 'directory',
): Promise<void> {
  await execFileAsync(
    join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      OWNER_ONLY_ACCESS_SCRIPT,
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        DREAMUX_PRIVATE_PATH: path,
        DREAMUX_PRIVATE_KIND: kind,
      },
    },
  );
}

const OWNER_ONLY_ACCESS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$existing = Get-Acl -LiteralPath $env:DREAMUX_PRIVATE_PATH
$owner = $existing.GetOwner([System.Security.Principal.SecurityIdentifier])
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
if ($owner -ne $sid -and -not ($owner.Value -eq 'S-1-5-32-544' -and $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator))) {
  throw 'refusing to use private Dreamux path: it is owned by a different Windows user'
}
if ($env:DREAMUX_PRIVATE_KIND -eq 'directory') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
}
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule($rule)
if ($env:DREAMUX_PRIVATE_KIND -eq 'directory') {
  [System.IO.Directory]::SetAccessControl($env:DREAMUX_PRIVATE_PATH, $acl)
} else {
  [System.IO.File]::SetAccessControl($env:DREAMUX_PRIVATE_PATH, $acl)
}
`;

/**
 * Remove `path` only if it exists and is zero bytes. Best-effort: a missing,
 * non-empty, or busy file is left untouched and never throws.
 */
export async function removeEmptyLogFile(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (info.size === 0) await unlink(path);
  } catch {
    /* best effort — missing/busy/non-empty files are left as-is */
  }
}

/** Best-effort existence probe — the async replacement for `existsSync`. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
