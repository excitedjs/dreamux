import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomic } from '../../platform/atomic-write.js';
import type { TaskTargetRecord } from './types.js';
import type { TaskHostWalState } from './wal.js';
import { safeSegment } from './store-support.js';

export async function rebuildTaskHostProjections(input: {
  rootDir: string;
  channelId: string;
  hostStreamId: string;
  state: TaskHostWalState;
}): Promise<void> {
  const projectionDir = join(input.rootDir, 'projections');
  await mkdir(join(projectionDir, 'targets'), { recursive: true });
  await Promise.all([
    ...[...input.state.targets.values()].map((target) =>
      writeTargetProjection(projectionDir, input.channelId, input.state, target),
    ),
    writeContainerManifestProjection(projectionDir, input.channelId, input.state),
    writeStreamProjection(
      projectionDir,
      input.channelId,
      input.hostStreamId,
      input.state,
    ),
  ]);
}

export async function writeTaskHostProjections(input: {
  rootDir: string;
  channelId: string;
  hostStreamId: string;
  state: TaskHostWalState;
  deltas: readonly TaskTargetRecord[];
  manifestChanged: boolean;
}): Promise<void> {
  const projectionDir = join(input.rootDir, 'projections');
  await mkdir(join(projectionDir, 'targets'), { recursive: true });
  await Promise.all([
    ...input.deltas.map((target) =>
      writeTargetProjection(projectionDir, input.channelId, input.state, target),
    ),
    ...(input.manifestChanged
      ? [writeContainerManifestProjection(
          projectionDir,
          input.channelId,
          input.state,
        )]
      : []),
    writeStreamProjection(
      projectionDir,
      input.channelId,
      input.hostStreamId,
      input.state,
    ),
  ]);
}

function writeTargetProjection(
  projectionDir: string,
  channelId: string,
  state: TaskHostWalState,
  target: TaskTargetRecord,
): Promise<void> {
  return writeFileAtomic(
    join(projectionDir, 'targets', `${safeSegment(target.target_id)}.json`),
    `${JSON.stringify({
      schema: 'task_host_target_projection_v1',
      channel_id: channelId,
      tx_index: state.txIndex,
      tail_checksum: state.tailChecksum,
      target,
    }, null, 2)}\n`,
  );
}

function writeStreamProjection(
  projectionDir: string,
  channelId: string,
  hostStreamId: string,
  state: TaskHostWalState,
): Promise<void> {
  return writeFileAtomic(
    join(projectionDir, 'stream.json'),
    `${JSON.stringify({
      schema: 'task_host_stream_projection_v1',
      channel_id: channelId,
      tx_index: state.txIndex,
      tail_checksum: state.tailChecksum,
      host_stream_id: hostStreamId,
      stream_generation: state.streamGeneration,
      watermark: state.nextSequence - 1,
      acknowledged_through: state.acknowledgedThrough,
      replay_floor: state.replayFloor,
      applied_manifest_revision: state.containerManifest.revision,
      applied_manifest_digest: state.containerManifest.digest,
    }, null, 2)}\n`,
  );
}

function writeContainerManifestProjection(
  projectionDir: string,
  channelId: string,
  state: TaskHostWalState,
): Promise<void> {
  return writeFileAtomic(
    join(projectionDir, 'container-manifest.json'),
    `${JSON.stringify({
      schema: 'task_host_container_manifest_projection_v1',
      channel_id: channelId,
      tx_index: state.txIndex,
      tail_checksum: state.tailChecksum,
      container_manifest: state.containerManifest,
    }, null, 2)}\n`,
  );
}
