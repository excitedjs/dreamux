/** Collect credentials inside the registering PowerShell process, never in JS. */
export const windowsCredentialScript = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

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

    [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CredPackAuthenticationBufferW(uint flags, string user, string password, IntPtr buffer, ref uint size);

    [DllImport("credui.dll", CharSet = CharSet.Unicode)]
    public static extern uint CredUIPromptForWindowsCredentialsW(ref Info info, uint error, ref uint package, IntPtr input, uint inputSize, out IntPtr output, out uint outputSize, IntPtr save, uint flags);

    [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CredUnPackAuthenticationBufferW(uint flags, IntPtr buffer, uint size, IntPtr user, ref uint userChars, IntPtr domain, ref uint domainChars, IntPtr password, ref uint passwordChars);
}
'@
$inputBuffer = $outputBuffer = $nameBuffer = $domainBuffer = $passwordBuffer = [IntPtr]::Zero
[uint32]$inputSize = 0
[uint32]$outputSize = 0
[uint32]$nameChars = 0
[uint32]$domainChars = 0
[uint32]$passwordChars = 0
$nameBytes = $domainBytes = $passwordBytes = 0
$securePassword = $credential = $null
try {
  $account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  # CRED_PACK_GENERIC_CREDENTIALS matches the dialog's CREDUIWIN_GENERIC mode.
  if (-not [DreamuxCredentialNative]::CredPackAuthenticationBufferW(4, $account, '', [IntPtr]::Zero, [ref]$inputSize)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -ne 122) { throw [ComponentModel.Win32Exception]::new($code) }
  }
  $inputBuffer = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($inputSize)
  if (-not [DreamuxCredentialNative]::CredPackAuthenticationBufferW(4, $account, '', $inputBuffer, [ref]$inputSize)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  $info = [DreamuxCredentialNative+Info]::new()
  $info.Size = [Runtime.InteropServices.Marshal]::SizeOf($info)
  $info.Caption = 'Dreamux Windows service'
  $info.Message = 'Enter the Windows account password (not PIN) for ' + $account + ' to run Dreamux whether or not you are logged on.'
  [uint32]$package = 0
  # CREDUIWIN_GENERIC requests a username/password pair without a save checkbox.
  $code = [DreamuxCredentialNative]::CredUIPromptForWindowsCredentialsW([ref]$info, 0, [ref]$package, $inputBuffer, $inputSize, [ref]$outputBuffer, [ref]$outputSize, [IntPtr]::Zero, 1)
  if ($code -ne 0) { throw [ComponentModel.Win32Exception]::new([int]$code) }
  if (-not [DreamuxCredentialNative]::CredUnPackAuthenticationBufferW(0, $outputBuffer, $outputSize, [IntPtr]::Zero, [ref]$nameChars, [IntPtr]::Zero, [ref]$domainChars, [IntPtr]::Zero, [ref]$passwordChars)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -ne 122) { throw [ComponentModel.Win32Exception]::new($code) }
  }
  $nameBytes = 2 * $nameChars
  $domainBytes = 2 * $domainChars
  $passwordBytes = 2 * $passwordChars
  $nameBuffer = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($nameBytes)
  if ($domainBytes -gt 0) { $domainBuffer = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($domainBytes) }
  $passwordBuffer = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($passwordBytes)
  if (-not [DreamuxCredentialNative]::CredUnPackAuthenticationBufferW(0, $outputBuffer, $outputSize, $nameBuffer, [ref]$nameChars, $domainBuffer, [ref]$domainChars, $passwordBuffer, [ref]$passwordChars)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  $name = [Runtime.InteropServices.Marshal]::PtrToStringUni($nameBuffer)
  $domain = if ($domainChars -gt 0) { [Runtime.InteropServices.Marshal]::PtrToStringUni($domainBuffer) } else { '' }
  $enteredAccount = if ($domain) { $domain + '\' + $name } else { $name }
  $enteredSid = [System.Security.Principal.NTAccount]::new($enteredAccount).Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($enteredSid -ne $user) { throw 'The Windows service must use the current Windows account.' }
  $securePassword = [Security.SecureString]::new()
  for ($index = 0; $index -lt $passwordChars - 1; $index++) {
    $securePassword.AppendChar([char]([Runtime.InteropServices.Marshal]::ReadInt16($passwordBuffer, 2 * $index) -band 0xffff))
  }
  $securePassword.MakeReadOnly()
  $credential = [System.Management.Automation.PSCredential]::new($account, $securePassword)
} finally {
  foreach ($buffer in @(
    @{ Pointer = $inputBuffer; Size = $inputSize },
    @{ Pointer = $outputBuffer; Size = $outputSize },
    @{ Pointer = $nameBuffer; Size = $nameBytes },
    @{ Pointer = $domainBuffer; Size = $domainBytes },
    @{ Pointer = $passwordBuffer; Size = $passwordBytes }
  )) {
    if ($buffer.Pointer -ne [IntPtr]::Zero) {
      try {
        [Runtime.InteropServices.Marshal]::Copy([byte[]]::new($buffer.Size), 0, $buffer.Pointer, $buffer.Size)
      } finally {
        [Runtime.InteropServices.Marshal]::FreeCoTaskMem($buffer.Pointer)
      }
    }
  }
  if ($null -eq $credential -and $null -ne $securePassword) { $securePassword.Dispose() }
}
`;
