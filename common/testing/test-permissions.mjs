import { chmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(
  new URL('../../packages/dreamux-utils/package.json', import.meta.url),
);
let native;

/** Independent native oracle: inspect the actual ACL, not the production setter. */
function windows() {
  if (native) return native;
  const koffi = require('koffi');
  const kernel = koffi.load('kernel32.dll');
  const security = koffi.load('advapi32.dll');
  native = {
    koffi,
    free: kernel.func('void * __stdcall LocalFree(void *memory)'),
    close: kernel.func('int __stdcall CloseHandle(void *handle)'),
    open: kernel.func(
      'void * __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t sharing, void *security, uint32_t disposition, uint32_t flags, void *templateFile)',
    ),
    currentProcess: kernel.func('void * __stdcall GetCurrentProcess()'),
    lastError: kernel.func('uint32_t __stdcall GetLastError()'),
    clearError: kernel.func('void __stdcall SetLastError(uint32_t error)'),
    openToken: security.func(
      'int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)',
    ),
    tokenInformation: security.func(
      'int __stdcall GetTokenInformation(void *token, int kind, void *buffer, uint32_t size, _Out_ uint32_t *needed)',
    ),
    privilege: security.func(
      'int __stdcall LookupPrivilegeValueW(const char16_t *system, const char16_t *name, void *luid)',
    ),
    adjustPrivileges: security.func(
      'int __stdcall AdjustTokenPrivileges(void *token, int disableAll, void *newState, uint32_t bufferLength, void *previousState, _Out_ uint32_t *returnLength)',
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
    descriptorString: security.func(
      'int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *descriptor, uint32_t revision, uint32_t information, _Out_ void **text, void *size)',
    ),
    owner: security.func(
      'int __stdcall GetSecurityDescriptorOwner(void *descriptor, _Out_ void **owner, _Out_ int *defaulted)',
    ),
    dacl: security.func(
      'int __stdcall GetSecurityDescriptorDacl(void *descriptor, _Out_ int *present, _Out_ void **dacl, _Out_ int *defaulted)',
    ),
    control: security.func(
      'int __stdcall GetSecurityDescriptorControl(void *descriptor, _Out_ uint16_t *control, _Out_ uint32_t *revision)',
    ),
    ace: security.func(
      'int __stdcall GetAce(void *acl, uint32_t index, _Out_ void **ace)',
    ),
    getNamed: security.func(
      'uint32_t __stdcall GetNamedSecurityInfoW(const char16_t *path, int kind, uint32_t information, _Out_ void **owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)',
    ),
    getHandle: security.func(
      'uint32_t __stdcall GetSecurityInfo(void *handle, int kind, uint32_t information, _Out_ void **owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)',
    ),
    setNamed: security.func(
      'uint32_t __stdcall SetNamedSecurityInfoW(const char16_t *path, int kind, uint32_t information, void *owner, void *group, void *dacl, void *sacl)',
    ),
  };
  return native;
}

function sidText(sid) {
  const api = windows();
  const text = [null];
  assert.ok(api.sidString(sid, text));
  try {
    return api.koffi.decode(text[0], 'char16_t', -1);
  } finally {
    api.free(text[0]);
  }
}

export function currentWindowsUserSid() {
  const api = windows();
  const token = [null];
  assert.ok(api.openToken(api.currentProcess(), 8, token));
  try {
    const size = [0];
    api.tokenInformation(token[0], 1, null, 0, size);
    const buffer = Buffer.alloc(size[0]);
    assert.ok(api.tokenInformation(token[0], 1, buffer, buffer.length, size));
    return sidText(api.koffi.decode(buffer, 'void *'));
  } finally {
    api.close(token[0]);
  }
}

export function isWindowsAdministrator() {
  const api = windows();
  const sid = [null],
    member = [0];
  assert.ok(api.stringSid('S-1-5-32-544', sid));
  try {
    assert.ok(api.membership(null, sid[0], member));
    return member[0] !== 0;
  } finally {
    api.free(sid[0]);
  }
}

export function readWindowsPermissions(path, pipe = false) {
  const api = windows();
  const owner = [null],
    dacl = [null],
    descriptor = [null];
  let handle;
  try {
    if (pipe) {
      handle = api.open(path, 0x20000, 0, null, 3, 0, null);
      assert.notEqual(BigInt.asIntN(64, handle), -1n);
      assert.equal(
        api.getHandle(handle, 6, 7, owner, null, dacl, null, descriptor),
        0,
      );
    } else {
      assert.equal(
        api.getNamed(path, 1, 7, owner, null, dacl, null, descriptor),
        0,
      );
    }
    const control = [0];
    assert.ok(api.control(descriptor[0], control, [0]));
    assert.notEqual(dacl[0], null, 'a NULL DACL grants everyone full access');
    const count = api.koffi.decode(dacl[0], 4, 'uint16_t');
    const rules = [];
    for (let index = 0; index < count; index++) {
      const ace = [null];
      assert.ok(api.ace(dacl[0], index, ace));
      const type = api.koffi.decode(ace[0], 'uint8_t');
      assert.ok(
        type === 0 || type === 1,
        `unexpected fixture ACE type ${type}`,
      );
      rules.push({
        sid: sidText(ace[0] + 8n),
        type: type === 0 ? 'Allow' : 'Deny',
        mask: api.koffi.decode(ace[0], 4, 'uint32_t'),
        flags: api.koffi.decode(ace[0], 1, 'uint8_t'),
      });
    }
    const text = [null];
    assert.ok(api.descriptorString(descriptor[0], 1, 7, text, null));
    try {
      return {
        owner: sidText(owner[0]),
        protected: (control[0] & 0x1000) !== 0,
        rules,
        sddl: api.koffi.decode(text[0], 'char16_t', -1),
      };
    } finally {
      api.free(text[0]);
    }
  } finally {
    if (descriptor[0] !== null) api.free(descriptor[0]);
    if (handle !== undefined) api.close(handle);
  }
}

/** Apply an exact ACL only to a caller-owned disposable fixture. */
export function setWindowsFixturePermissions(path, sddl) {
  const api = windows();
  const descriptor = [null],
    owner = [null],
    dacl = [null];
  assert.ok(api.descriptor(sddl, 1, descriptor, null));
  try {
    assert.ok(api.owner(descriptor[0], owner, [0]));
    assert.ok(api.dacl(descriptor[0], [0], dacl, [0]));
    assert.equal(
      api.setNamed(
        path,
        1,
        0x80000004 + (owner[0] === null ? 0 : 1),
        owner[0],
        null,
        dacl[0],
        null,
      ),
      0,
    );
  } finally {
    api.free(descriptor[0]);
  }
}

/** A foreign-owner fixture requires SeRestorePrivilege; restore the exact prior token state. */
export function withWindowsRestorePrivilege(action) {
  const api = windows();
  const token = [null];
  assert.ok(api.openToken(api.currentProcess(), 0x28, token));
  const previous = Buffer.alloc(16);
  let adjusted = false;
  try {
    const luid = Buffer.alloc(8);
    assert.ok(api.privilege(null, 'SeRestorePrivilege', luid));
    const privileges = Buffer.alloc(16);
    privileges.writeUInt32LE(1, 0);
    luid.copy(privileges, 4);
    privileges.writeUInt32LE(2, 12);
    api.clearError(0);
    const result = api.adjustPrivileges(
      token[0],
      0,
      privileges,
      previous.length,
      previous,
      [0],
    );
    const error = api.lastError();
    assert.ok(result);
    assert.equal(error, 0, 'fixture requires the restore privilege');
    adjusted = true;
    return action();
  } finally {
    if (adjusted)
      assert.ok(api.adjustPrivileges(token[0], 0, previous, 0, null, null));
    api.close(token[0]);
  }
}

export function holdWindowsReadLock(path) {
  const api = windows();
  const handle = api.open(path, 0x80000000, 1, null, 3, 0, null);
  assert.notEqual(BigInt.asIntN(64, handle), -1n);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    assert.ok(api.close(handle));
  };
}

/** Deliberately loosen a test fixture before exercising permission tightening. */
export async function makeWorldReadable(path, unixMode) {
  if (process.platform !== 'win32') {
    await chmod(path, unixMode);
    return;
  }
  const sid = currentWindowsUserSid();
  // Keep the owner's inheritable grant when loosening a directory. Replacing it
  // with a non-inheritable ACE also strips access from existing child fixtures.
  const inheritance = (await stat(path)).isDirectory() ? 'OICI' : '';
  setWindowsFixturePermissions(
    path,
    `D:P(A;${inheritance};FA;;;${sid})(A;;FR;;;WD)(A;;FA;;;SY)`,
  );
}

/** Assert the native privacy contract, not Windows' synthetic mode bits. */
export async function expectOwnerOnlyPermissions(path, unixMode) {
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, unixMode);
    return;
  }
  const permissions = readWindowsPermissions(path);
  const sid = currentWindowsUserSid();
  assert.equal(permissions.owner, sid);
  assert.equal(permissions.rules.length, 1);
  const { flags, ...rule } = permissions.rules[0];
  // New files may inherit the private parent's ACL. Protection and inheritance
  // flags describe how the ACL was obtained, not who can access this object.
  assert.equal(flags & 0x08, 0, 'the owner grant must apply to this object');
  assert.deepEqual(rule, {
    sid,
    type: 'Allow',
    mask: 0x1f01ff,
  });
}
