/**
 * How a Command reaches the process objects that own its domain.
 *
 * Commands are resolved once per process and invoked with a caller context, so
 * they cannot close over one dispatcher at construction: they look their target
 * up per invocation. This narrow port is everything they may look up. It exists
 * so a domain-owned Command module never imports the process `Server`.
 */
import type { DispatcherRow } from '../state/dispatcher-store.js';
import type { DispatcherService } from '../service/dispatcher-service/index.js';
import type {
  DispatcherRuntimeStatus,
  DispatcherSummary,
} from '../service/dispatcher-service/types.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import type { CoreCommandContext } from '@excitedjs/dreamux-types';
import { DispatcherNotFoundError } from '../service/dispatchers/errors.js';
import type { McpLeaseRegistry } from '../service/mcp/leases.js';
import { ValidationError, throwCallerMistake } from './errors.js';

export interface CoreCommandHost {
  /** Configured dispatchers plus their current runtime projection. */
  summarize(): Promise<DispatcherSummary[]>;
  /** The configured row, or `null` when no dispatcher carries that id. */
  dispatcherRow(dispatcherId: string): DispatcherRow | null;
  /** The current runtime projection of one dispatcher, live or persisted. */
  dispatcherRuntimeStatus(dispatcherId: string): Promise<DispatcherRuntimeStatus>;
  /** Get-or-build the per-dispatcher aggregate. */
  dispatcher(dispatcherId: string): DispatcherService;
  /**
   * The process-wide Agent-facing MCP lease registry.
   *
   * The MCP transport Commands are addressed by lease token rather than by
   * dispatcher id, so they resolve their target here instead of through
   * {@link mustDispatcher}. It is on the host, not on a dispatcher, because a
   * shim connects with a token and nothing else — it cannot name the dispatcher
   * whose registry to look in.
   */
  readonly mcpLeases: McpLeaseRegistry;
}

/**
 * The dispatcher a Command is addressed to.
 *
 * Addressing is caller context, not payload: the admin socket lifts the
 * caller-supplied `dispatcher_id` out of its request envelope, and a Channel
 * invoker binds the dispatcher that owns its session. A Command therefore never
 * re-reads `dispatcher_id` from its own input, and its input schema stays
 * closed around domain fields only.
 */
export function mustDispatcherId(context: CoreCommandContext): string {
  const id = context.dispatcher_id;
  if (id === undefined) {
    throw new ValidationError(
      'this command is dispatcher-scoped and the caller supplied no dispatcher_id',
    );
  }
  try {
    return validateDispatcherId(id);
  } catch (err) {
    // The id rule speaks in its own words; only its type becomes the caller's,
    // and anything else raised here is not the caller's fault to begin with.
    throwCallerMistake(err);
  }
}

/** Resolve the addressed dispatcher, failing loud when it is not configured. */
export function mustDispatcher(
  host: CoreCommandHost,
  context: CoreCommandContext,
): DispatcherService {
  const id = mustDispatcherId(context);
  mustDispatcherRow(host, id);
  return host.dispatcher(id);
}

export function mustDispatcherRow(
  host: CoreCommandHost,
  dispatcherId: string,
): DispatcherRow {
  const row = host.dispatcherRow(dispatcherId);
  if (row === null) {
    throw new DispatcherNotFoundError(dispatcherId);
  }
  return row;
}
