/**
 * The Agent-facing MCP lease registry: Core's admission edge for every tool a
 * spawned MCP shim can reach, and the place one generation's catalog is frozen.
 *
 * A shim has no identity of its own and is told nothing about the dispatcher,
 * Team, or caller it serves. All it carries is an opaque token, and that token
 * is the whole of its authority: while an entry for it exists here it names one
 * delegate, already bound to its caller, advertising one already-validated
 * catalog.
 *
 * ## Two edges, because two orderings are needed
 *
 * An entity's runtime ownership ends in two steps that cannot be fenced at the
 * same moment. The provider is entitled to publish its terminal status *while*
 * it stops, so the state sink's {@link AgentRuntimeGenerationLease} must stay
 * current until after the native runtime is down. The MCP surface is the
 * opposite: the shim is a separate live process that can start new work at any
 * instant, so it has to lose authority *before* teardown begins.
 *
 * So this registry owns its own edge. {@link McpLeaseRegistry.release} deletes
 * entries synchronously, and deletion is what stops a token resolving — the
 * owner calls it before it touches the native runtime. Calls already admitted
 * converge through the Command port's fence and their dispatcher's drain; a
 * call arriving after the delete is refused outright.
 *
 * ## The catalog is copied, not borrowed
 *
 * A delegate's `describe` returns objects it still owns — an external Channel
 * package builds its descriptors out of its own parsed config — so Core does
 * not keep them. Minting takes a canonical deep copy through the same JSON
 * boundary a Command result crosses, validates that copy, and deep-freezes it.
 * What the registry holds is therefore unreachable from the delegate: nothing a
 * provider does after mint can change an advertised catalog, and Core never
 * freezes an object a provider owns.
 *
 * ## Membership is proven here, once
 *
 * A token authorizes the tools its own frozen catalog names, and nothing else.
 * {@link McpLeaseRegistry.invoke} is therefore the only way a delegate is
 * reached: it proves the token is live and that the requested name is in that
 * token's catalog before it dispatches. The registry compares names and reads
 * no meaning into them — what a tool does stays the delegate's own business.
 *
 * That single edge is what makes the contract structural. It holds for the
 * official shim and for anything else that can reach `mcp.toolcall` on the
 * admin socket, and a new delegate inherits it without a check of its own.
 *
 * ## The generation lease
 *
 * It is kept as a second, independent condition rather than as the mechanism.
 * It costs nothing to check and it closes the one hole deletion cannot: an
 * owner that was replaced without ever releasing — a process that died
 * mid-teardown, a start that raced its own stop — still has every one of its
 * tokens fail, because the generation that minted them is no longer current.
 */
import { randomUUID } from 'node:crypto';

import {
  validateMcpToolCatalog,
  type ValidatedMcpTool,
} from '../../mcp/catalog.js';
import { DreamuxError } from '../../platform/errors.js';
import {
  canonicalJsonValue,
  JsonValueError,
  JSON_VALUE_UNBOUNDED,
} from '../../platform/json-value.js';
import type { AgentRuntimeGenerationLease } from '../agent-entity/runtime-state.js';
import { deepFreeze } from '../frozen-snapshot.js';
import { unknownToolResult } from './projection.js';
import type {
  McpDelegateCall,
  McpDelegateDescription,
  McpDelegateIdentity,
  McpDelegateResult,
  McpServerDelegate,
} from './types.js';

/**
 * The token named a server that is gone: never minted, released by its owner,
 * or minted by a runtime generation that has since been replaced.
 *
 * One code covers all three, on purpose. A shim cannot tell them apart and must
 * not be able to probe for the difference, and to an operator reading the log
 * they mean the same thing — a child outlived the runtime it was launched for.
 */
export class McpLeaseRevokedError extends DreamuxError {
  constructor() {
    super(
      'MCP_LEASE_REVOKED',
      'this MCP server is no longer authorized; its agent runtime generation ended',
    );
  }
}

/**
 * One runtime generation's catalog, as Core proved and fixed it.
 *
 * Fixed at mint, before the runtime that will advertise it is constructed, and
 * never recomputed: `mcp.describe` serves this object and nothing asks the
 * delegate again. That is what makes a catalog immutable for a generation in
 * fact rather than by convention — a delegate whose answer would drift, or
 * whose availability changed after the freeze, cannot change what was admitted.
 *
 * The immutability is structural, not a typing convention. Every value in here
 * is a Core-owned deep copy, deep-frozen down to the last nested schema, icon,
 * and annotation; the `readonly` markers describe that fact rather than
 * creating it.
 */
export interface McpFrozenCatalog {
  readonly identity: McpDelegateIdentity;
  readonly tools: readonly ValidatedMcpTool[];
}

interface McpLeaseEntry {
  readonly lease: AgentRuntimeGenerationLease;
  readonly delegate: McpServerDelegate;
  /**
   * The delegate's name, read once at mint.
   *
   * One generation's native registration key is a single fact, decided when its
   * catalog is frozen. Keeping the value here rather than re-reading
   * `delegate.name` is what makes it one: the name the composition boundary
   * proves unique, the name a native config registers, and the name a failure
   * message shows are the same string by construction.
   */
  readonly name: string;
  readonly catalog: McpFrozenCatalog;
}

/** A minted token together with the server name it was frozen for. */
export interface McpMintedServer {
  readonly token: string;
  readonly name: string;
}

/**
 * The process-wide token → server map.
 *
 * One registry per server process, created before anything that mints into it,
 * and reachable from a Command only through `CoreCommandHost`.
 */
export class McpLeaseRegistry {
  private readonly entries = new Map<string, McpLeaseEntry>();

  /**
   * Validate and freeze one delegate's catalog, bind it to one runtime
   * generation, and return its token.
   *
   * This is where Core proves a catalog, and it runs before the runtime that
   * would advertise it exists. A malformed identity, a malformed descriptor, a
   * duplicated tool name, or a schema the official SDK rejects therefore fails
   * the launch, loudly, in the process that can say which delegate produced it
   * — instead of surfacing later as a child that will not come up.
   *
   * `null` means the delegate advertises nothing, and its caller must give the
   * runtime no server for it: an Agent is never shown an MCP server with an
   * empty tool list. This is decided here, once, for every delegate, rather
   * than by each composition site guessing ahead of the freeze.
   *
   * The token is a random opaque value with no structure to read: it names no
   * dispatcher, Team, caller, or delegate.
   */
  mint(
    lease: AgentRuntimeGenerationLease,
    delegate: McpServerDelegate,
  ): McpMintedServer | null {
    this.pruneRevoked();
    const name = delegate.name;
    const catalog = freezeDelegateCatalog(delegate, name);
    if (catalog === null) return null;
    const token = randomUUID();
    this.entries.set(token, { lease, delegate, name, catalog });
    return { token, name };
  }

  /** The frozen catalog this token was minted with, or fail loud. */
  catalog(token: string): McpFrozenCatalog {
    return this.entry(token).catalog;
  }

  /**
   * Admit one tool call: prove the token, prove the tool, then dispatch.
   *
   * The membership check is the reason this method exists instead of a
   * `resolve` that hands the delegate out. `mcp.describe` published exactly
   * this catalog, so a name outside it was never offered — and refusing it here
   * covers every caller that holds a token, not only the official shim. A
   * delegate is entered having already been told the name is one of its own.
   *
   * Purely a name comparison. The registry does not know what any of these
   * tools do, and the frozen catalog it compares against is the same object
   * `mcp.describe` serves, so the advertised set and the admitted set cannot
   * drift apart.
   */
  async invoke(
    token: string,
    call: McpDelegateCall,
  ): Promise<McpDelegateResult> {
    const entry = this.entry(token);
    const names = entry.catalog.tools.map((tool) => tool.name);
    if (!names.includes(call.name)) {
      return unknownToolResult(entry.name, call.name, names);
    }
    return entry.delegate.call(call);
  }

  /**
   * Close the admission edge for these tokens, synchronously.
   *
   * This is the revocation, not a cleanup pass: after it returns, every one of
   * these tokens fails to admit anything, so no MCP child can start new work
   * against the entity that released them. Owners call it before tearing down a native
   * runtime and on every failure path that abandons a mint, which is also what
   * keeps the map bounded by the runtimes that are actually live. Deleting an
   * absent token is a no-op, so releasing twice is safe.
   */
  release(tokens: readonly string[]): void {
    for (const token of tokens) this.entries.delete(token);
  }

  private entry(token: string): McpLeaseEntry {
    const entry = this.entries.get(token);
    if (entry === undefined || !entry.lease.isCurrent()) {
      throw new McpLeaseRevokedError();
    }
    return entry;
  }

  /**
   * Forget every entry whose generation is over.
   *
   * A backstop for owners that never released, not the primary bound. Runs on
   * mint rather than on a timer: the only thing that grows this map is starting
   * runtimes, so the work is bounded by the same rate that creates it.
   */
  private pruneRevoked(): void {
    for (const [token, entry] of this.entries) {
      if (!entry.lease.isCurrent()) this.entries.delete(token);
    }
  }
}

/**
 * Take one generation's catalog: read the delegate once, copy canonically,
 * validate the copy, freeze it.
 *
 * The copy comes first, and it is what everything downstream sees. Validating
 * the delegate's own objects would prove a state that can change the instant
 * mint returns, and an accessor could answer a second read differently — so
 * Core reads each property exactly once, through the same JSON boundary a
 * Command result crosses, and keeps the parsed result. Nothing the delegate
 * still holds is reachable from what is stored, and nothing the delegate owns
 * is frozen.
 *
 * `null` means the delegate advertises nothing, so it gets no token and its
 * runtime gets no server.
 */
function freezeDelegateCatalog(
  delegate: McpServerDelegate,
  name: string,
): McpFrozenCatalog | null {
  // Asked exactly once. Everything downstream reads the snapshot, so a delegate
  // cannot answer `describe` and `call` from different sets.
  const server = `MCP server '${name}'`;
  const snapshot = canonicalDescription(
    delegate.describe(),
    `${server} description`,
  );
  const tools = snapshot['tools'];
  if (!Array.isArray(tools)) {
    throw new Error(`${server} description must carry a 'tools' array`);
  }
  if (tools.length === 0) return null;
  return Object.freeze({
    identity: frozenIdentity(snapshot['identity'], server),
    // Validation rebuilds each descriptor to apply its documented defaults, so
    // those wrappers are new and still mutable; freezing them closes the last
    // gap. Everything nested inside already came frozen out of the snapshot.
    tools: deepFreeze(validateMcpToolCatalog(tools, `${server} tool catalog`)),
  });
}

/**
 * The delegate's description as the canonical, frozen JSON value Core keeps.
 *
 * `JSON_VALUE_UNBOUNDED` on purpose: this is the same value `mcp.describe` will
 * publish, and the Command result boundary already canonicalizes Core-composed
 * results without a size ceiling. Imposing one only here would be a second,
 * arbitrary policy for one value — while every structural rule (cycles, foreign
 * prototypes, non-JSON types, hidden keys, array holes) still applies, which is
 * what this call is for.
 */
function canonicalDescription(
  described: McpDelegateDescription,
  label: string,
): Record<string, unknown> {
  let snapshot: unknown;
  try {
    snapshot = canonicalJsonValue(described, JSON_VALUE_UNBOUNDED);
  } catch (error) {
    if (error instanceof JsonValueError) {
      throw new Error(`${label} is not JSON-representable — ${error.message}`);
    }
    throw error;
  }
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot)
  ) {
    throw new Error(`${label} must be an object`);
  }
  return snapshot as Record<string, unknown>;
}

/**
 * Prove the server identity Core is about to publish, and keep only its two
 * fields.
 *
 * The shim checks this as well, but it is the second reader: an identity that
 * is missing or malformed must fail the launch that composed it rather than the
 * child that was already spawned to advertise it.
 */
function frozenIdentity(value: unknown, server: string): McpDelegateIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${server} identity must be an object`);
  }
  const identity = value as Record<string, unknown>;
  const name = identity['name'];
  const version = identity['version'];
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`${server} identity.name must be a non-empty string`);
  }
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(`${server} identity.version must be a non-empty string`);
  }
  return Object.freeze({ name, version });
}
