/**
 * The one seam between the generic MCP infrastructure and the objects that
 * actually own Agent-facing tools.
 *
 * A delegate is created already bound to its caller — a Dispatcher Agent, one
 * Team's leader, a live Channel — and it owns everything that used to be
 * scattered across a shim, a CLI subcommand, a descriptor builder, and a set of
 * caller-scope parameters smuggled through Command payloads: its catalog, its
 * server identity, which owning-object method each tool reaches, what a tool
 * says back to the model, and which failures a model may see.
 *
 * The infrastructure on the other side of this seam knows none of that. It
 * mints a lease — validating and freezing the catalog as it does — spawns one
 * generic shim, routes `describe`/`call` by token, and never branches on a tool
 * name. The one thing it does read out of a catalog is the set of names in it,
 * so that a call can be admitted against the catalog its token was minted with
 * before any delegate is entered; what those names mean stays over here.
 *
 * Nothing in this directory names a Team, a TeamMate, a cron job, or a Channel.
 * The delegates that do live with their own domains and are wired in at the
 * composition roots that already own those objects.
 */
/**
 * The MCP server identity a delegate advertises for itself.
 *
 * Distinct from {@link McpServerDelegate.name}: this is what the server calls
 * itself in its own initialize response, while the name is the key the runtime
 * registers it under. Core proves both, in different places and against
 * different rules.
 */
export interface McpDelegateIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * What a delegate advertises. `tools` is an opaque list of MCP tool descriptors:
 * the infrastructure validates it structurally against the official SDK (see
 * `mcp/catalog.ts`) and never reads a name, description, or schema out of it.
 *
 * `unknown` rather than a mirrored descriptor type, because these come from two
 * unrelated worlds — Core-owned builders and whatever an external Channel
 * package publishes — and Core's JSON boundary plus that structural validation
 * are what actually enforce the contract.
 */
export interface McpDelegateDescription {
  readonly identity: McpDelegateIdentity;
  readonly tools: readonly unknown[];
}

/**
 * One tool invocation, exactly as the model's client sent it. The arguments
 * already passed this tool's own advertised input schema, in the official SDK,
 * before they crossed the wire.
 */
export interface McpDelegateCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * One settled tool call.
 *
 * `ok: false` is the delegate's own decision that this failure is safe and
 * useful for the model to read. Everything the delegate does not allowlist is
 * thrown instead, which fails the Command, is logged in full by Core, and
 * reaches the model as the fixed sanitized tool error. There is no third state:
 * a delegate never returns a private message.
 */
export type McpDelegateResult =
  | {
      readonly ok: true;
      /**
       * The tool's canonical public value. It is a domain projection, not a raw
       * DTO handed out whole, and Core's Command JSON boundary is what proves it
       * is representable before any of it leaves the process.
       */
      readonly structured: unknown;
      /** Model-facing text this operation chose to say alongside its result. */
      readonly text?: string;
    }
  | { readonly ok: false; readonly message: string };

/**
 * One Agent-facing MCP server, implemented by the layer that owns its tools.
 *
 * Implementations live with their domain — `service/team-collection`,
 * `service/teammate-collection`, `service/scheduler`, `service/channel-service`
 * — never here, and never in a transport module.
 */
export interface McpServerDelegate {
  /**
   * The MCP server name the runtime registers this delegate under. It is the
   * key the model's client shows next to every tool, so it is a product-facing
   * name owned by the delegate, not a generated id.
   *
   * Owned, but not unconstrained: the composition boundary proves a runtime's
   * whole set of names is unique and safe to write into every provider's native
   * configuration, before that runtime is constructed. A delegate that derives
   * its name from operator-supplied data is responsible for namespacing it and
   * for encoding it — `nativeSafeMcpNameSegment` exists for exactly that — so
   * that arbitrary data yields a usable name instead of constraining the data.
   *
   * A plain value, read once. Core takes it when the generation's catalog is
   * frozen and uses that string everywhere after, so an implementation must not
   * expect a second read: one generation's registration key is one fact.
   */
  readonly name: string;

  /**
   * The catalog for this runtime generation.
   *
   * Asked exactly once, by Core, when the generation's lease is minted and
   * before the runtime that will advertise it is constructed. Core copies the
   * answer canonically, validates the copy, freezes it, and serves that
   * snapshot from then on. A delegate therefore never has to keep itself
   * consistent across repeated calls, and stays free to mutate whatever it
   * returned — but it does have to advertise only what it can actually serve at
   * that moment, because the frozen list is also what routes every later call.
   *
   * Synchronous on purpose: a catalog is a pure function of already-resolved
   * configuration, caller scope, and the handlers the delegate holds. A
   * delegate that would need to await something to answer is a delegate whose
   * catalog is not actually stable.
   */
  describe(): McpDelegateDescription;

  /**
   * Serve one call by reaching the owning object directly.
   *
   * `call.name` is guaranteed to be one of the names in the catalog this
   * generation was frozen with: Core proves membership at its own admission
   * edge, so a delegate neither has to re-check it nor has a way to be reached
   * with a tool it never advertised.
   */
  call(call: McpDelegateCall): Promise<McpDelegateResult>;
}
