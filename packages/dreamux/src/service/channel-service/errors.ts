/**
 * A channel-tool authorization failure raised by the ChannelService
 * TeamLeader egress gate. It carries the admin error CODE so the admin layer
 * can map the denial to the wire code (`BAD_REQUEST` /
 * `CHANNEL_SCOPE_DENIED`) without the service layer depending on the admin
 * protocol module.
 */
export class ChannelToolAuthorizationError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'CHANNEL_SCOPE_DENIED',
    message: string,
  ) {
    super(message);
    this.name = 'ChannelToolAuthorizationError';
  }
}
