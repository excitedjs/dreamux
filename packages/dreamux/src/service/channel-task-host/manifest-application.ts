import type {
  ChannelTaskContainerManifestApplyInput,
  ChannelTaskContainerManifestApplyResult,
} from '@excitedjs/dreamux-types';

import type { ChannelService } from '../channel-service/index.js';
import {
  normalizeContainerManifestApplyInput,
  publicContainerManifestState,
  resolveContainerManifest,
} from './container-manifest.js';
import type { TaskHostStore } from './store.js';
import { TaskManifestApplyError } from './types.js';

export async function applyTaskContainerManifest(
  context: {
    channelId: string;
    channels: ChannelService;
    store: TaskHostStore;
    assertSessionActive: () => void;
    invalidateSnapshot: () => void;
  },
  input: ChannelTaskContainerManifestApplyInput,
): Promise<ChannelTaskContainerManifestApplyResult> {
  let candidate;
  try {
    candidate = await resolveContainerManifest({
      manifest: normalizeContainerManifestApplyInput(input),
      channels: context.channels,
      channelId: context.channelId,
    });
  } catch {
    return {
      status: 'rejected',
      code: 'TASK_MANIFEST_INVALID',
      message: 'container manifest is invalid',
      current_revision: context.store.appliedManifestRevision,
    };
  }
  context.assertSessionActive();
  try {
    const applied = await context.store.applyContainerManifest(
      candidate,
      context.assertSessionActive,
    );
    context.invalidateSnapshot();
    return {
      status: applied.changed ? 'applied' : 'unchanged',
      state: publicContainerManifestState(applied.record),
      host_watermark: context.store.watermark,
    };
  } catch (error) {
    if (error instanceof TaskManifestApplyError) {
      return {
        status: 'rejected',
        code: error.code,
        message: error.message,
        current_revision: context.store.appliedManifestRevision,
      };
    }
    throw error;
  }
}
