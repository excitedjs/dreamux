import type { CommandModule } from 'yargs';

import type { JsonValue } from '@excitedjs/dreamux-types';

import { AdminClientError, adminJsonInvoker } from '../../admin/client.js';

export type DreamuxCommand = CommandModule<{}, any>;

export function noopHandler(): void {
  // Group commands only dispatch to their subcommands.
}

/**
 * Invoke one admin Command in-process over `admin.sock` and print its result
 * the way the old standalone `server-ctl` CLI did: the raw JSON result on
 * success, or `error: [code] message` on a Command-level failure (an
 * {@link AdminClientError} — the server ran the Command and it refused the
 * request). A transport failure (no admin socket to answer at all) is not
 * caught here: it propagates to the `dreamux` CLI's own top-level error
 * handler like any other command failure, carrying whatever `admin/client.ts`
 * already reports for that case.
 */
export async function runAdminCommand(
  method: string,
  params: Record<string, JsonValue> = {},
): Promise<void> {
  let result: unknown;
  try {
    result = await adminJsonInvoker().invoke(method, params);
  } catch (err) {
    if (err instanceof AdminClientError) {
      console.error(`error: [${err.code}] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  console.log(JSON.stringify(result, null, 2));
}
