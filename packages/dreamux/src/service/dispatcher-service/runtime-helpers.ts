import type { ChannelInstance } from '@excitedjs/dreamux-types';

export async function closeAllBuilt(
  channels: Map<string, ChannelInstance>,
): Promise<void> {
  for (const instance of channels.values()) {
    try {
      await instance.session.close();
    } catch {
      /* best effort */
    }
  }
}
