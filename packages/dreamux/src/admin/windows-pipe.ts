import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Replace Windows' default Everyone/Anonymous read grants with owner access. */
export async function restrictWindowsPipe(address: string): Promise<void> {
  const name = address.slice('\\\\.\\pipe\\'.length).replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
$rights = [System.IO.Pipes.PipeAccessRights]::ReadWrite -bor [System.IO.Pipes.PipeAccessRights]::ChangePermissions
$pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', '${name}', $rights, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::None, [System.IO.HandleInheritability]::None)
try {
  $pipe.Connect(5000)
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $security = [System.IO.Pipes.PipeSecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new($sid, [System.IO.Pipes.PipeAccessRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow))
  $pipe.SetAccessControl($security)
} finally {
  $pipe.Dispose()
}
`;
  await execFileAsync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true },
  );
}
