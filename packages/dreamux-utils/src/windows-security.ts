import { toNamespacedPath } from 'node:path';
import { promisify } from 'node:util';

type Pointer = bigint | null;

async function loadSecurityApi() {
  const { default: koffi } = await import('koffi');
  const kernel = koffi.load('kernel32.dll');
  const security = koffi.load('advapi32.dll');
  return {
    decode: koffi.decode,
    pointerBits: koffi.sizeof('void *') * 8,
    currentProcess: kernel.func('void * __stdcall GetCurrentProcess()'),
    close: kernel.func('int __stdcall CloseHandle(void *handle)'),
    free: kernel.func('void * __stdcall LocalFree(void *memory)'),
    openToken: security.func(
      'int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)',
    ),
    tokenInformation: security.func(
      'int __stdcall GetTokenInformation(void *token, int kind, void *buffer, uint32_t size, _Out_ uint32_t *needed)',
    ),
    sidString: security.func(
      'int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)',
    ),
    stringSid: security.func(
      'int __stdcall ConvertStringSidToSidW(const char16_t *text, _Out_ void **sid)',
    ),
    membership: security.func(
      'int __stdcall CheckTokenMembership(void *token, void *sid, _Out_ int *member)',
    ),
    descriptor: security.func(
      'int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *text, uint32_t revision, _Out_ void **descriptor, void *size)',
    ),
    owner: security.func(
      'int __stdcall GetSecurityDescriptorOwner(void *descriptor, _Out_ void **owner, _Out_ int *defaulted)',
    ),
    dacl: security.func(
      'int __stdcall GetSecurityDescriptorDacl(void *descriptor, _Out_ int *present, _Out_ void **dacl, _Out_ int *defaulted)',
    ),
    namedSecurity: promisify(
      security.func(
        'uint32_t __stdcall GetNamedSecurityInfoW(const char16_t *path, int kind, uint32_t information, _Out_ void **owner, void *group, void *dacl, void *sacl, _Out_ void **descriptor)',
      ).async,
    ),
    setNamedSecurity: promisify(
      security.func(
        'uint32_t __stdcall SetNamedSecurityInfoW(const char16_t *path, int kind, uint32_t information, void *owner, void *group, void *dacl, void *sacl)',
      ).async,
    ),
    openPipe: promisify(
      kernel.func(
        'void * __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t sharing, void *security, uint32_t disposition, uint32_t flags, void *templateFile)',
      ).async,
    ),
    setSecurity: promisify(
      security.func(
        'uint32_t __stdcall SetSecurityInfo(void *handle, int kind, uint32_t information, void *owner, void *group, void *dacl, void *sacl)',
      ).async,
    ),
  };
}

let api: ReturnType<typeof loadSecurityApi> | undefined;
let identity: { sid: string; administrator: boolean } | undefined;

function securityApi() {
  return (api ??= loadSecurityApi());
}

function currentIdentity(native: Awaited<ReturnType<typeof loadSecurityApi>>) {
  if (identity !== undefined) return identity;
  const token: Pointer[] = [null];
  check(
    native.openToken(native.currentProcess(), 0x0008, token),
    'OpenProcessToken',
  );
  try {
    const size = [0];
    native.tokenInformation(token[0], 1, null, 0, size);
    const buffer = Buffer.alloc(size[0]!);
    check(
      native.tokenInformation(token[0], 1, buffer, buffer.length, size),
      'GetTokenInformation',
    );
    const user = native.decode(buffer, 'void *') as Pointer;
    const sid = sidText(native, user);
    const administrators: Pointer[] = [null];
    check(
      native.stringSid('S-1-5-32-544', administrators),
      'ConvertStringSidToSidW',
    );
    try {
      const member = [0];
      check(
        native.membership(null, administrators[0], member),
        'CheckTokenMembership',
      );
      identity = { sid, administrator: member[0] !== 0 };
      return identity;
    } finally {
      native.free(administrators[0]);
    }
  } finally {
    native.close(token[0]);
  }
}

function sidText(
  native: Awaited<ReturnType<typeof loadSecurityApi>>,
  sid: Pointer,
): string {
  const text: Pointer[] = [null];
  check(native.sidString(sid, text), 'ConvertSidToStringSidW');
  try {
    return native.decode(text[0], 'char16_t', -1) as string;
  } finally {
    native.free(text[0]);
  }
}

function ownerOnlyDescriptor(
  native: Awaited<ReturnType<typeof loadSecurityApi>>,
  directory: boolean,
) {
  const { sid } = currentIdentity(native);
  const descriptor: Pointer[] = [null];
  check(
    native.descriptor(
      `O:${sid}D:P(A;${directory ? 'OICI' : ''};FA;;;${sid})`,
      1,
      descriptor,
      null,
    ),
    'ConvertStringSecurityDescriptorToSecurityDescriptorW',
  );
  const owner: Pointer[] = [null];
  const dacl: Pointer[] = [null];
  try {
    check(
      native.owner(descriptor[0], owner, [0]),
      'GetSecurityDescriptorOwner',
    );
    check(
      native.dacl(descriptor[0], [0], dacl, [0]),
      'GetSecurityDescriptorDacl',
    );
    return { descriptor: descriptor[0], owner: owner[0], dacl: dacl[0] };
  } catch (error) {
    native.free(descriptor[0]);
    throw error;
  }
}

/** Keep a current-user security descriptor alive across creation of a native kernel object. */
export async function withWindowsOwnerOnlySecurityDescriptor<T>(
  use: (descriptor: bigint) => Promise<T>,
): Promise<T> {
  const native = await securityApi();
  const { sid } = currentIdentity(native);
  const descriptor: Pointer[] = [null];
  check(
    native.descriptor(`O:${sid}D:P(A;;GA;;;${sid})`, 1, descriptor, null),
    'ConvertStringSecurityDescriptorToSecurityDescriptorW',
  );
  try {
    return await use(descriptor[0]!);
  } finally {
    native.free(descriptor[0]);
  }
}

/** Adopt current-user paths, including Administrators-owned paths under an elevated token. */
export async function setWindowsOwnerOnlyAccess(
  path: string,
  kind: 'file' | 'directory',
): Promise<void> {
  const nativePath = toNamespacedPath(path);
  const native = await securityApi();
  const user = currentIdentity(native);
  const owner: Pointer[] = [null];
  const existing: Pointer[] = [null];
  checkStatus(
    await native.namedSecurity(
      nativePath,
      1,
      1,
      owner,
      null,
      null,
      null,
      existing,
    ),
    'GetNamedSecurityInfoW',
    path,
  );
  try {
    const sid = sidText(native, owner[0]!);
    if (sid !== user.sid && !(sid === 'S-1-5-32-544' && user.administrator)) {
      throw new Error(
        'refusing to use private Dreamux path: it is owned by a different Windows user',
      );
    }
  } finally {
    native.free(existing[0]);
  }
  const desired = ownerOnlyDescriptor(native, kind === 'directory');
  try {
    checkStatus(
      await native.setNamedSecurity(
        nativePath,
        1,
        0x80000005,
        desired.owner,
        null,
        desired.dacl,
        null,
      ),
      'SetNamedSecurityInfoW',
      path,
    );
  } finally {
    native.free(desired.descriptor);
  }
}

/** Protect the existing pipe before the host admits clients; no transport bytes are exchanged. */
export async function restrictWindowsPipe(address: string): Promise<void> {
  const native = await securityApi();
  const handle = (await native.openPipe(
    address,
    0x00040000,
    0,
    null,
    3,
    0,
    null,
  )) as Pointer;
  if (handle === null || BigInt.asIntN(native.pointerBits, handle) === -1n) {
    throw new Error(
      `CreateFileW could not open the Windows management pipe ${address}`,
    );
  }
  try {
    const desired = ownerOnlyDescriptor(native, false);
    try {
      checkStatus(
        await native.setSecurity(
          handle,
          6,
          0x80000004,
          null,
          null,
          desired.dacl,
          null,
        ),
        'SetSecurityInfo',
        address,
      );
    } finally {
      native.free(desired.descriptor);
    }
  } finally {
    native.close(handle);
  }
}

function check(result: unknown, operation: string): void {
  if (!result) throw new Error(`${operation} failed`);
}

function checkStatus(status: unknown, operation: string, path: string): void {
  if (status !== 0)
    throw new Error(
      `${operation} failed for ${path} (Windows error ${String(status)})`,
    );
}
