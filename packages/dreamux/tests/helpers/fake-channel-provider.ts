/**
 * The "minimal Channel fixture" required by technical-design/final.md section 7
 * ("A minimal Channel fixture constructs, initializes, subscribes, starts,
 * invokes `team.submit` and `team.create`, receives each event kind, and
 * closes without any provider-specific or MCP stub").
 *
 * This is a hand-built `ChannelProvider<TConfig>` — no shared base class, no
 * fake "every capability present" shape. A test that needs no events builds a
 * provider with `subscribe: false` and never attaches a listener; a test that
 * needs no MCP tools omits `mcp` entirely, so no `ChannelSessionMcpCapability`
 * or `ChannelMcpCapability` object exists for that provider at all. This
 * mirrors the contract in `@excitedjs/dreamux-types`'s `channel.ts`: a
 * `ChannelInstance` with `mcp` absent, not a stub that always returns "no
 * tools".
 */
import type {
  ChannelCoreEvent,
  ChannelCorePort,
  ChannelEventSubscription,
  ChannelInstance,
  ChannelMcpCall,
  ChannelMcpCallContext,
  ChannelMcpCaller,
  ChannelMcpCapability,
  ChannelMcpToolOutcome,
  ChannelMcpToolRegistration,
  ChannelProvider,
  ChannelSessionCreateContext,
  ChannelSessionMcpCapability,
} from '@excitedjs/dreamux-types';

export type FakeChannelConfig = Record<string, unknown>;

/**
 * One created session's observable state, kept for tests to assert against
 * after `build`/`initialize`/`start`/`close` have run. This is test-visible
 * state only — nothing here is read by the fake session itself, which is why
 * a test may freely mutate `receivedEvents` or read `port` without racing the
 * fake's own logic.
 */
export interface FakeChannelSessionHandle {
  readonly channelId: string;
  readonly createContext: ChannelSessionCreateContext<FakeChannelConfig>;
  initializeCalled: boolean;
  startCalled: boolean;
  closeCalled: boolean;
  /** Set once `initialize` runs; `null` before that and never reset after. */
  port: ChannelCorePort | null;
  subscription: ChannelEventSubscription | null;
  /** Every event this session's subscription observed, in delivery order. */
  receivedEvents: ChannelCoreEvent[];
}

export interface FakeChannelProviderOptions {
  /**
   * Sequence recorder shared with whatever else a test is ordering (fake
   * schedulers, workflows, teams, ...). Each lifecycle step this fixture
   * performs pushes one label so a single `toEqual` on the shared array proves
   * cross-collaborator ordering, not just this provider's own steps.
   */
  record?: (label: string) => void;
  /**
   * Whether a created session subscribes to Core events during `initialize`.
   * Defaults to true. A Channel that needs no events sets this to false and
   * genuinely never subscribes, rather than subscribing and ignoring events.
   */
  subscribe?: boolean;
  /**
   * Commands this session invokes once `start()` opens external input, in
   * order. Exercises the "invokes `team.submit` and `team.create`" fixture
   * requirement. Invoked strictly after `initialize` returned, proving a
   * session never reaches Core before its own start.
   */
  invokeOnStart?: ReadonlyArray<{ command: string; payload: unknown }>;
  /** When set, `initialize` rejects with this error instead of succeeding. */
  failInitialize?: () => Error;
  /** When set, `start` rejects with this error instead of succeeding. */
  failStart?: () => Error;
  /** When set, `close` rejects with this error instead of succeeding. */
  failClose?: () => Error;
  /**
   * An awaited "Channel-owned mutation tail" `close()` must wait for before it
   * returns — proves a pending async write finishes before resources release.
   */
  mutationTail?: () => Promise<void>;
  /**
   * Optional Channel MCP composition. Omitted entirely (not present-but-empty)
   * when a test's Channel has no tools, matching `ChannelProvider.mcp?`.
   */
  mcp?: {
    describe(
      config: FakeChannelConfig,
      context: { readonly caller: ChannelMcpCaller },
    ): readonly ChannelMcpToolRegistration[];
    sessionInvoke?: (
      call: ChannelMcpCall,
      context: ChannelMcpCallContext,
    ) => Promise<ChannelMcpToolOutcome>;
    providerInvoke?: (
      call: ChannelMcpCall,
      context: ChannelMcpCallContext,
    ) => Promise<ChannelMcpToolOutcome>;
  };
}

export interface FakeChannelProviderResult {
  provider: ChannelProvider<FakeChannelConfig>;
  /** One handle per session `createSession` produced, keyed by channel id. */
  sessions: Map<string, FakeChannelSessionHandle>;
}

/**
 * Build one hand-authored fake `ChannelProvider`. No base class, no
 * "implements every optional capability" default: this function decides
 * per-call, from `options`, exactly which of the optional `ChannelProvider`
 * members exist on the returned object.
 */
export function createFakeChannelProvider(
  options: FakeChannelProviderOptions = {},
): FakeChannelProviderResult {
  const sessions = new Map<string, FakeChannelSessionHandle>();
  const record = options.record ?? (() => {});
  const shouldSubscribe = options.subscribe ?? true;

  const provider: ChannelProvider<FakeChannelConfig> = {
    async createSession(
      context: ChannelSessionCreateContext<FakeChannelConfig>,
    ): Promise<ChannelInstance> {
      const handle: FakeChannelSessionHandle = {
        channelId: context.channel_id,
        createContext: context,
        initializeCalled: false,
        startCalled: false,
        closeCalled: false,
        port: null,
        subscription: null,
        receivedEvents: [],
      };
      sessions.set(context.channel_id, handle);
      record(`channel:${context.channel_id}:create`);

      const session = {
        async initialize(port: ChannelCorePort): Promise<void> {
          if (options.failInitialize) {
            record(`channel:${context.channel_id}:initialize:fail`);
            throw options.failInitialize();
          }
          handle.port = port;
          if (shouldSubscribe) {
            handle.subscription = port.events.subscribe((event) => {
              handle.receivedEvents.push(event);
            });
          }
          handle.initializeCalled = true;
          record(`channel:${context.channel_id}:initialize`);
        },
        async start(): Promise<void> {
          if (options.failStart) {
            record(`channel:${context.channel_id}:start:fail`);
            throw options.failStart();
          }
          handle.startCalled = true;
          record(`channel:${context.channel_id}:start`);
          if (options.invokeOnStart && handle.port !== null) {
            for (const call of options.invokeOnStart) {
              await handle.port.invoke.invoke(call.command, call.payload as never);
            }
          }
        },
        async close(): Promise<void> {
          record(`channel:${context.channel_id}:close:begin`);
          if (options.mutationTail) {
            await options.mutationTail();
          }
          handle.closeCalled = true;
          if (options.failClose) {
            record(`channel:${context.channel_id}:close:fail`);
            throw options.failClose();
          }
          record(`channel:${context.channel_id}:close`);
        },
      };

      const instance: ChannelInstance = options.mcp
        ? {
            session,
            mcp: buildSessionMcp(options.mcp),
          }
        : { session };
      return instance;
    },
    ...(options.mcp
      ? {
          mcp: buildProviderMcp(options.mcp) as ChannelMcpCapability<FakeChannelConfig>,
        }
      : {}),
  };

  return { provider, sessions };
}

function buildSessionMcp(
  mcp: NonNullable<FakeChannelProviderOptions['mcp']>,
): ChannelSessionMcpCapability | undefined {
  if (mcp.sessionInvoke === undefined) return undefined;
  const sessionInvoke = mcp.sessionInvoke;
  return {
    invoke: (call, context) => sessionInvoke(call, context),
  };
}

function buildProviderMcp(
  mcp: NonNullable<FakeChannelProviderOptions['mcp']>,
): ChannelMcpCapability<FakeChannelConfig> {
  const capability: {
    describe: ChannelMcpCapability<FakeChannelConfig>['describe'];
    invoke?: ChannelMcpCapability<FakeChannelConfig>['invoke'];
  } = {
    describe: (config, context) => mcp.describe(config, context),
  };
  if (mcp.providerInvoke !== undefined) {
    const providerInvoke = mcp.providerInvoke;
    capability.invoke = (call, context) => providerInvoke(call, context);
  }
  return capability as ChannelMcpCapability<FakeChannelConfig>;
}

/** A minimal, valid `ChannelMcpToolRegistration` for tests that need one tool. */
export function fakeChannelToolRegistration(input: {
  name: string;
  target: 'session' | 'provider';
}): ChannelMcpToolRegistration {
  return {
    target: input.target,
    tool: {
      name: input.name,
      description: `fake tool ${input.name}`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  };
}
