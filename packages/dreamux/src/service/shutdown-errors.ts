export async function collectShutdownFailure(
  failures: unknown[],
  task: () => Promise<void> | void,
): Promise<void> {
  try {
    await task();
  } catch (err) {
    failures.push(err);
  }
}

export function throwShutdownFailures(
  failures: readonly unknown[],
  message: string,
): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError([...failures], message);
}
