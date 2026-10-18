export function expectOwnerOnlyPermissions(
  path: string,
  unixMode: number,
): Promise<void>;
export function makeWorldReadable(
  path: string,
  unixMode: number,
): Promise<void>;
export function currentWindowsUserSid(): string;
export function isWindowsAdministrator(): boolean;
export function readWindowsPermissions(
  path: string,
  pipe?: boolean,
): {
  owner: string;
  protected: boolean;
  sddl: string;
  rules: { sid: string; type: 'Allow' | 'Deny'; mask: number; flags: number }[];
};
export function setWindowsFixturePermissions(path: string, sddl: string): void;
export function withWindowsRestorePrivilege<T>(action: () => T): T;
export function holdWindowsReadLock(path: string): () => Promise<void>;
