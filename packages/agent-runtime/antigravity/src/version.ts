export const MIN_ANTIGRAVITY_VERSION = '1.5.15';

export function parseAntigravityVersion(
  raw: string,
): [number, number, number] | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function antigravityVersionSatisfies(raw: string): boolean {
  const got = parseAntigravityVersion(raw);
  const min = parseAntigravityVersion(MIN_ANTIGRAVITY_VERSION)!;
  if (got === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (got[index]! > min[index]!) return true;
    if (got[index]! < min[index]!) return false;
  }
  return true;
}
