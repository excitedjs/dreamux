import { execFile } from 'node:child_process';
import { chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

/** Deliberately loosen a test fixture before exercising permission tightening. */
export async function makeWorldReadable(path, unixMode) {
  if (process.platform !== 'win32') {
    await chmod(path, unixMode);
    return;
  }
  await promisify(execFile)(
    join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe'),
    [path, '/grant', '*S-1-1-0:RX'],
    { windowsHide: true },
  );
}

/** Assert the effective native privacy contract, not Windows' synthetic mode bits. */
export async function expectOwnerOnlyPermissions(path, unixMode) {
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, unixMode);
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $env:DREAMUX_TEST_PATH
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$foreign = @($rules | Where-Object { $_.IdentityReference -ne $sid })
$full = @($rules | Where-Object { $_.IdentityReference -eq $sid -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl })
@{ foreign = $foreign.Count; full = $full.Count; owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -eq $sid } | ConvertTo-Json -Compress
`;
  const { stdout } = await promisify(execFile)(
    join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      env: {
        // PowerShell 7 module paths cannot be inherited by Windows PowerShell.
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key.toLowerCase() !== 'psmodulepath',
          ),
        ),
        DREAMUX_TEST_PATH: path,
      },
    },
  );
  assert.deepEqual(JSON.parse(stdout), { foreign: 0, full: 1, owner: true });
}
