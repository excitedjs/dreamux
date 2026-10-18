export function expectOwnerOnlyPermissions(
  path: string,
  unixMode: number,
): Promise<void>;
export function makeWorldReadable(
  path: string,
  unixMode: number,
): Promise<void>;
