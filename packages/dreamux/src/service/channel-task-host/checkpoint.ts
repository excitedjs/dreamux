import { randomUUID } from 'node:crypto';

import {
  applyTransaction,
  emptyWalState,
  encodeFrame,
  newTransaction,
  validateTransaction,
  type TaskHostCheckpoint,
  type TaskHostTransaction,
  type TaskHostWalState,
} from './wal.js';

export function buildTaskHostCheckpoint(input: {
  channelId: string;
  hostStreamId: string;
  state: TaskHostWalState;
  committedAt: number;
}): { bytes: Buffer; state: TaskHostWalState } {
  const checkpointId = randomUUID();
  const next = emptyWalState();
  next.hostStreamId = input.hostStreamId;
  const frames: Buffer[] = [];

  const append = (
    targets: TaskHostTransaction['target_deltas'],
    events: TaskHostTransaction['host_events'],
    checkpoint: TaskHostCheckpoint,
  ) => {
    const tx = newTransaction({
      channel_id: input.channelId,
      tx_index: next.txIndex + 1,
      previous_checksum: next.tailChecksum,
      committed_at: input.committedAt,
      host_stream_id: input.hostStreamId,
      stream_generation: input.state.streamGeneration,
      target_deltas: structuredClone(targets),
      host_events: structuredClone(events),
      sequence_allocation: null,
      acknowledged_through: null,
      checkpoint,
    });
    const encoded = encodeFrame(tx);
    validateTransaction(
      encoded.transaction,
      next,
      input.channelId,
      input.hostStreamId,
    );
    applyTransaction(next, encoded.transaction, encoded.checksum);
    frames.push(encoded.frame);
  };

  for (const target of input.state.targets.values()) {
    append([target], [], { checkpoint_id: checkpointId, final: false });
  }
  for (const event of input.state.events) {
    if (event.sequence <= input.state.acknowledgedThrough) continue;
    append([], [event], { checkpoint_id: checkpointId, final: false });
  }
  append([], [], {
    checkpoint_id: checkpointId,
    final: true,
    next_sequence: input.state.nextSequence,
    acknowledged_through: input.state.acknowledgedThrough,
    replay_floor: input.state.acknowledgedThrough,
    host_status: input.state.hostStatus,
    host_status_code: input.state.hostStatusCode,
  });
  return { bytes: Buffer.concat(frames), state: next };
}
