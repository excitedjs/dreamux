/** Collect credentials inside the registering PowerShell process, never in JS. */
export const windowsCredentialScript = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DreamuxCredentialNative
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Info
    {
        public int Size;
        public IntPtr Parent;
        public string Message;
        public string Caption;
        public IntPtr Banner;
    }

    [DllImport("credui.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern uint CredUIPromptForCredentialsW(ref Info info, string target, IntPtr context, uint error, [In, Out] StringBuilder user, uint userChars, IntPtr password, uint passwordChars, [MarshalAs(UnmanagedType.Bool)] ref bool save, uint flags);
}
'@
# wincred.h limits, with one additional UTF-16 code unit for each terminator.
[uint32]$nameChars = 514
[uint32]$passwordChars = 257
$passwordBytes = 2 * $passwordChars
$passwordBuffer = [IntPtr]::Zero
$securePassword = $credential = $null
try {
  $account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $name = [Text.StringBuilder]::new($account, [int]$nameChars)
  $passwordBuffer = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($passwordBytes)
  [Runtime.InteropServices.Marshal]::Copy([byte[]]::new($passwordBytes), 0, $passwordBuffer, $passwordBytes)
  $info = [DreamuxCredentialNative+Info]::new()
  $info.Size = [Runtime.InteropServices.Marshal]::SizeOf($info)
  $info.Caption = 'Dreamux Windows service'
  $info.Message = 'Enter the Windows account password (not PIN) for ' + $account + ' to run Dreamux whether or not you are logged on.'
  $save = $false
  # KEEP_USERNAME | GENERIC_CREDENTIALS | DO_NOT_PERSIST | ALWAYS_SHOW_UI.
  $code = [DreamuxCredentialNative]::CredUIPromptForCredentialsW([ref]$info, 'Dreamux Windows service', [IntPtr]::Zero, 0, $name, $nameChars, $passwordBuffer, $passwordChars, [ref]$save, 0x140082)
  if ($code -ne 0) { throw [ComponentModel.Win32Exception]::new([int]$code) }
  $securePassword = [Security.SecureString]::new()
  for ($index = 0; $index -lt $passwordChars - 1; $index++) {
    $character = [char]([Runtime.InteropServices.Marshal]::ReadInt16($passwordBuffer, 2 * $index) -band 0xffff)
    if ($character -eq [char]0) { break }
    $securePassword.AppendChar($character)
  }
  $securePassword.MakeReadOnly()
  $credential = [System.Management.Automation.PSCredential]::new($account, $securePassword)
} finally {
  if ($passwordBuffer -ne [IntPtr]::Zero) {
    try {
      [Runtime.InteropServices.Marshal]::Copy([byte[]]::new($passwordBytes), 0, $passwordBuffer, $passwordBytes)
    } finally {
      [Runtime.InteropServices.Marshal]::FreeCoTaskMem($passwordBuffer)
    }
  }
  if ($null -eq $credential -and $null -ne $securePassword) { $securePassword.Dispose() }
}
`;
