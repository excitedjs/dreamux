/**
 * Everything one Channel session may reach Core through.
 *
 * The Command half is a context binder and nothing else: it names the Command,
 * forwards the payload untouched, and attaches the dispatcher and channel this
 * session belongs to. It invokes the same admitted Command port the admin
 * socket does, so a Channel gets no smaller catalog, no separate schema, no
 * unvalidated or unbounded payload path, and no way past the process fence.
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
  JsonInvoker,
  JsonValue,
} from '@excitedjs/dreamux-types';

import { ServerShuttingDownError } from '../platform/errors.js';

export interface ChannelCorePortOptions {
  /** The Server-owned admitted port, never a raw registry. */
  registry: CoreCommandRegistry;
  dispatcherId: string;
  /** The configured channel this session serves; the Command's dedupe scope. */
  channelId: string;
  /** This session's already-scoped live event source. */
  events: ChannelEventSource;
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
      return options.registry.invoke(
        {
          source: 'channel',
          dispatcher_id: options.dispatcherId,
          channel_id: options.channelId,
        },
        command,
        payload,
      );
    },
  };
  return {
    port: Object.freeze({ invoke, events: options.events }),
    closeAdmission(): void {
      accepting = false;
    },
  };
}
