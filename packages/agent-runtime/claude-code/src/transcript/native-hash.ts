const MASK_64 = (1n << 64n) - 1n;
const SECRET = [
  0xa0761d6478bd642fn,
  0xe7037ed1a0b428dbn,
  0x8ebc6af09c88c6e3n,
  0x589965cc75374cc3n,
] as const;

export function claudeNativePathHash(value: string): string {
  return wyhash(new TextEncoder().encode(value), 0n).toString(36);
}

function wyhash(input: Uint8Array, seed: bigint): bigint {
  let state = uint64(seed) ^ mix(uint64(seed) ^ SECRET[0], SECRET[1]);
  let left: bigint;
  let right: bigint;
  const length = input.length;
  if (length <= 16) {
    if (length >= 4) {
      const end = length - 4;
      const quarter = (length >> 3) << 2;
      left = (read(input, 0, 4) << 32n) | read(input, quarter, 4);
      right =
        (read(input, end, 4) << 32n) |
        read(input, end - quarter, 4);
    } else if (length > 0) {
      left =
        (BigInt(input[0]!) << 16n) |
        (BigInt(input[length >> 1]!) << 8n) |
        BigInt(input[length - 1]!);
      right = 0n;
    } else {
      left = 0n;
      right = 0n;
    }
  } else {
    const lanes = [state, state, state];
    let offset = 0;
    while (offset + 48 < length) {
      for (let lane = 0; lane < lanes.length; lane += 1) {
        lanes[lane] = mix(
          read(input, offset + 16 * lane, 8) ^ SECRET[lane + 1]!,
          read(input, offset + 16 * lane + 8, 8) ^ lanes[lane]!,
        );
      }
      offset += 48;
    }
    lanes[0] = lanes[0]! ^ lanes[1]! ^ lanes[2]!;
    while (offset + 16 < length) {
      lanes[0] = mix(
        read(input, offset, 8) ^ SECRET[1],
        read(input, offset + 8, 8) ^ lanes[0]!,
      );
      offset += 16;
    }
    left = read(input, length - 16, 8);
    right = read(input, length - 8, 8);
    state = lanes[0]!;
  }
  const product = multiply(
    left ^ SECRET[1],
    right ^ state,
  );
  return mix(
    product.low ^ SECRET[0] ^ BigInt(length),
    product.high ^ SECRET[1],
  );
}

function read(
  input: Uint8Array,
  offset: number,
  length: number,
): bigint {
  let value = 0n;
  for (let index = 0; index < length; index += 1) {
    value |= BigInt(input[offset + index] ?? 0) << BigInt(index * 8);
  }
  return uint64(value);
}

function mix(left: bigint, right: bigint): bigint {
  const product = multiply(left, right);
  return product.low ^ product.high;
}

function multiply(
  left: bigint,
  right: bigint,
): { low: bigint; high: bigint } {
  const product = uint64(left) * uint64(right);
  return {
    low: uint64(product),
    high: uint64(product >> 64n),
  };
}

function uint64(value: bigint): bigint {
  return value & MASK_64;
}
