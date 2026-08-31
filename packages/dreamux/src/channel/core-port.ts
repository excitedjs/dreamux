/**
 * Everything one Channel session may reach Core through.
 *
 * The Command half is a context binder and nothing else: it names the Command,
 * forwards the payload untouched, and attaches the dispatcher and channel this
 * session belongs to. It invokes the same admitted Command port the admin
 * socket does, so a Channel gets no smaller catalog, no separate schema, no
 * unvalidated or unbounded payload path, and no way past the process fence.
 *
 * A rejected Command answers with the same facts the admin socket writes: the
 * failure's own code and message, plus the next step when its domain stated
 * one. A failure Core never classified is reported as `INTERNAL` under the
 * message it already had, and logged whole here, because this is the boundary
 * that observed it.
 *
 * The event half is the dispatcher's live source, already scoped to this
 * session. Core composes both here and keeps the lease: `closeAdmission` is the
 * dispatcher-level fence, revoked synchronously at shutdown so no Channel can
 * enter Core after the boundary closed, whatever its own external transport is
 * still doing.
 */
import type {
  ChannelCorePort,
  ChannelEventSource,
  CoreCommandRegistry,
  DreamuxLogger,
  JsonInvoker,
  JsonValue,
} from '@excitedjs/dreamux-types';

import { commandFailure } from '../command/errors.js';
import { errorInfo } from '../platform/error-info.js';
import { DreamuxError, ServerShuttingDownError } from '../platform/errors.js';

export interface ChannelCorePortOptions {
  /** The Server-owned admitted port, never a raw registry. */
  registry: CoreCommandRegistry;
  dispatcherId: string;
  /** The configured channel this session serves; the Command's dedupe scope. */
  channelId: string;
  /** This session's already-scoped live event source. */
  events: ChannelEventSource;
  /** The dispatcher's ordinary logger, for a failure nobody classified. */
  log: DreamuxLogger;
}

export interface ChannelCorePortLease {
  readonly port: ChannelCorePort;
  /**
   * Refuse every further Command from this session. Synchronous and idempotent:
   * the fence has to be published before any awaited teardown begins, and both
   * ordinary stop and process shutdown may publish it.
   */
  closeAdmission(): void;
}

export function createChannelCorePort(
  options: ChannelCorePortOptions,
): ChannelCorePortLease {
  let accepting = true;
  const invoke: JsonInvoker = {
    invoke(command: string, payload: JsonValue): Promise<JsonValue> {
      if (!accepting) return Promise.reject(new ServerShuttingDownError());
      return options.registry
        .invoke(
          {
            source: 'channel',
            dispatcher_id: options.dispatcherId,
            channel_id: options.channelId,
          },
          command,
          payload,
        )
        .catch((error: unknown) => {
          throw channelCommandError(options.log, command, error);
        });
    },
  };
  return {
    port: Object.freeze({ invoke, events: options.events }),
    closeAdmission(): void {
      accepting = false;
    },
  };
}

/**
 * One rejected Command, as a Channel reads it.
 *
 * A Dreamux failure already *is* the published `ChannelCommandError` shape, so
 * it is rethrown untouched and keeps its own type for a Channel that narrows on
 * it. Anything else is a value Core never classified: it is logged whole here
 * and rethrown as an `Error` carrying `INTERNAL` and the message it already
 * had, so a Channel reads the same three facts the admin socket writes.
 */
function channelCommandError(
  log: DreamuxLogger,
  command: string,
  error: unknown,
): unknown {
  if (error instanceof DreamuxError) return error;
  log.error({ command, err: errorInfo(error) }, 'channel command failed');
  const failure = commandFailure(error);
  return Object.assign(new Error(failure.message), { code: failure.code });
}
