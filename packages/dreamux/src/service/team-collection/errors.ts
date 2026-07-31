export class TeamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamUnavailableError';
  }
}

export function teamErrorInfo(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { type: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}
