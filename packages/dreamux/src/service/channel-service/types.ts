/** Public Channel inventory fields, independent of provider configuration. */
export interface ChannelMetadata {
  channel_id: string;
  provider: string;
  identity: string;
  live: boolean;
}
