import type { Argv } from 'yargs';

import { validateDispatcherId } from '../../state/dispatcher-id.js';

export function requiredString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  throw new Error(`missing required option --${name}`);
}

export function requiredDispatcherId(value: unknown): string {
  return validateDispatcherId(requiredString(value, 'id'));
}

export function withRequiredDispatcherId<T>(y: Argv<T>): Argv<T & { id: string }> {
  return y.option('id', {
    type: 'string',
    demandOption: true,
    describe: 'Dispatcher id',
  }) as Argv<T & { id: string }>;
}
