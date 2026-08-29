/**
 * The Command layer's failure vocabulary.
 *
 * There is no Command-specific error type: a Command fails with the same
 * {@link DreamuxError} tree every other layer uses, and every adapter reports
 * the same `{code, message}` pair — the admin socket writes it into its NDJSON
 * error envelope, the in-process Channel invoker rejects with it so a Channel
 * can read `error.code` directly (it is structurally the published
 * `ChannelCommandError`), and an MCP adapter projects it into one concise
 * public failure. Re-exported here so a domain Command module has one import
 * for the base, the generic failures, and the one failure the registry owns.
 */
import { DreamuxError } from '../platform/errors.js';

export {
  DreamuxError,
  InternalError,
  ServerShuttingDownError,
  TransportError,
  ValidationError,
  errorMessage,
  toDreamuxError,
} from '../platform/errors.js';

/** No Command is registered under the requested name. */
export class UnknownCommandError extends DreamuxError {
  constructor(name: string) {
    super('UNKNOWN_METHOD', `unknown method '${name}'`);
  }
}
