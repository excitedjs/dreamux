/**
 * The non-sensitive, read-only description of one configured Channel.
 *
 * It exists because a Channel's Commands are registered dynamically: a caller
 * that can invoke `channel.<id>.<name>` has no other way to learn the name, and
 * `dispatcher.list`/`dispatcher.status` are already the read model for "what is
 * this dispatcher". Everything here is either operator-declared identification
 * or a Core-owned lifecycle fact.
 *
 * What it deliberately never carries is the Channel's configuration. `identity`
 * is the opaque string the provider's own {@link ChannelIdentityCapability}
 * produced at config load — Core stores and repeats it without interpreting it,
 * so nothing here has to name a provider config field — and no other config
 * value, raw or parsed, is reachable from this shape.
 */

/**
 * How far one Channel has got, in the four states a caller can act on.
 *
 * `starting` means the instance exists but its external I/O is not open, so its
 * Commands answer `CHANNEL_COMMAND_UNAVAILABLE`; `ready` means it is serving;
 * `closing` means admission is fenced and what was accepted is draining, with
 * the Commands still resolvable; `closed` means nothing of this Channel is
 * registered any more and its names no longer resolve at all. The distinction
 * between `starting` and `closing` is exactly the one a retrying caller needs:
 * the first will become `ready`, the second will not.
 */
export type ChannelDescriptorStatus =
  | 'starting'
  | 'ready'
  | 'closing'
  | 'closed';

export interface ChannelDescriptor {
  readonly channel_id: string;
  readonly provider: string;
  /** The provider-neutral opaque identity, or `null` when it declared none. */
  readonly identity: string | null;
  /** Every Command name Core registered for this Channel, fully qualified. */
  readonly commands: readonly string[];
  readonly status: ChannelDescriptorStatus;
}

/**
 * One configured Channel, as the config loader recorded it. Narrower than
 * `DispatcherChannelConfig` on purpose: the two config members this shape does
 * not name are `config` and `rawConfig`, so nothing here can reach them.
 */
export interface ConfiguredChannelFacts {
  readonly id: string;
  readonly provider: string;
  readonly identity?: string;
}

/**
 * Project one dispatcher's configured Channels.
 *
 * The registration, not the session map, is what decides whether a Channel is
 * `closed`. The two do not fall away together: `ChannelService.closeAll()`
 * detaches its session maps before it awaits a single `session.close()`, so
 * between the fence and the batch's revocation the sessions read as stopped
 * while every name still resolves — and answers the retryable unavailable
 * failure rather than `UNKNOWN_METHOD`. Reading liveness first would publish
 * `closed` alongside a non-empty `commands` list for that whole window, which
 * is precisely the pair a caller uses to decide the Channel is gone.
 *
 * So the two facts a caller acts on are derived from one source: while this
 * dispatcher's batch still holds a registration for the Channel, its names are
 * reported and its state is `closing` from the instant admission is fenced;
 * once the batch is revoked — after the sessions closed, or after a close that
 * failed — it is `closed` with no names at all.
 */
export function channelDescriptors(input: {
  configured: readonly ConfiguredChannelFacts[];
  /** Whether this dispatcher's live batch still holds this Channel. */
  registered: (channelId: string) => boolean;
  liveStatus: (channelId: string) => 'running' | 'built' | 'stopped';
  admissionFenced: boolean;
  commandNames: (channelId: string) => readonly string[];
}): ChannelDescriptor[] {
  return input.configured.map((channel) => {
    const registered = input.registered(channel.id);
    return {
      channel_id: channel.id,
      provider: channel.provider,
      // An empty identity is the loader's "this provider declared none", not a
      // real value, so it is reported as absent rather than as an empty string.
      identity:
        channel.identity === undefined || channel.identity === ''
          ? null
          : channel.identity,
      commands: registered ? [...input.commandNames(channel.id)] : [],
      status: registered
        ? servingStatus(input.liveStatus(channel.id), input.admissionFenced)
        : 'closed',
    };
  });
}

/** The state of a Channel whose registration is still live. */
function servingStatus(
  live: 'running' | 'built' | 'stopped',
  admissionFenced: boolean,
): ChannelDescriptorStatus {
  // The fence is published synchronously, before any awaited teardown, so a
  // registered Channel that is no longer admitting is stated as closing from
  // the same instant a caller starts being refused.
  if (admissionFenced) return 'closing';
  return live === 'running' ? 'ready' : 'starting';
}
