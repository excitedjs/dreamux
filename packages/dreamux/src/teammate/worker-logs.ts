/**
 * TeamMate worker log retrieval (issue #126 PR5).
 *
 * Each built-in worker writes per-task diagnostic logs to deterministic,
 * server-built paths under `~/.dreamux/logs` (never the workspace cwd). This
 * module is the read side for the `get_task_logs` MCP tool: it maps a task's
 * `provider_ref` to its log file(s) and returns a BOUNDED tail of each, so a
 * dispatcher can inspect a slow or failed worker over MCP without tailing a file
 * in a shell or polling a process.
 *
 * These are DIAGNOSTIC streams, not the clean result text:
 *   - `builtin:codex`       → app-server stdout (protocol frames) + stderr.
 *   - `builtin:claude-code` → resident-child stderr only; the Claude stdout
 *     NDJSON data plane is consumed in-process and never lands on disk.
 * The final result is retrieved with get_task / pull_result / await_completion.
 *
 * Paths are built from the ledger-validated task id and the dispatcher id via
 * runtime/paths.ts, never from caller-controlled input, so there is no path
 * traversal surface here. Only `node:fs/promises` is used (the #85 no-sync-IO
 * gate covers this file).
 */

import { open } from 'node:fs/promises';

import {
  BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  BUILTIN_CODEX_PROVIDER_REF,
} from '../runtime/config.js';
import {
  dispatcherTeamMateWorkerClaudeStreamLogPath,
  dispatcherTeamMateWorkerErrorLogPath,
  dispatcherTeamMateWorkerLogPath,
} from '../runtime/paths.js';

/** Default bytes returned per stream when the caller does not specify. */
export const TEAMMATE_WORKER_LOG_DEFAULT_MAX_BYTES = 16_384;
/** Hard cap on bytes returned per stream, so a tool call can never dump a huge file. */
export const TEAMMATE_WORKER_LOG_MAX_BYTES_CAP = 131_072;

export type TeamMateWorkerLogStreamKind = 'stdout' | 'stderr';

/** One worker log stream's bounded tail. The local file path is never exposed. */
export interface TeamMateWorkerLogStream {
  stream: TeamMateWorkerLogStreamKind;
  /** Whether the underlying log file exists yet (false before the worker runs). */
  available: boolean;
  /** Bytes of `text` actually returned (the tail length, not the file size). */
  bytes: number;
  /** True when the file was larger than the cap and the head was dropped. */
  truncated: boolean;
  text: string;
}

export interface ReadTeamMateWorkerLogsInput {
  dispatcherId: string;
  taskId: string;
  /** The task's pinned worker; `null` before any worker ran. */
  providerRef: string | null;
  /** Bytes to return per stream; clamped to [1, cap]. */
  maxBytes?: number;
  /** Restrict to a single stream; default returns every stream the worker has. */
  stream?: TeamMateWorkerLogStreamKind;
}

export interface TeamMateWorkerLogs {
  provider_ref: string | null;
  /** Whether this provider has a known on-disk log layout at all. */
  logs_supported: boolean;
  streams: TeamMateWorkerLogStream[];
}

/**
 * Read bounded tails of a TeamMate worker's diagnostic logs. A provider with no
 * known log layout (or a task that never ran) yields `logs_supported: false`
 * and no streams; an unstarted-but-supported worker yields its streams with
 * `available: false`.
 */
export async function readTeamMateWorkerLogs(
  input: ReadTeamMateWorkerLogsInput,
): Promise<TeamMateWorkerLogs> {
  const maxBytes = clampMaxBytes(input.maxBytes);
  const all = streamPathsFor(
    input.providerRef,
    input.dispatcherId,
    input.taskId,
  );
  const selected =
    input.stream !== undefined
      ? all.filter((pair) => pair.stream === input.stream)
      : all;
  const streams = await Promise.all(
    selected.map((pair) => readTail(pair.stream, pair.path, maxBytes)),
  );
  return {
    provider_ref: input.providerRef,
    logs_supported: all.length > 0,
    streams,
  };
}

function streamPathsFor(
  providerRef: string | null,
  dispatcherId: string,
  taskId: string,
): Array<{ stream: TeamMateWorkerLogStreamKind; path: string }> {
  if (providerRef === BUILTIN_CODEX_PROVIDER_REF) {
    return [
      { stream: 'stdout', path: dispatcherTeamMateWorkerLogPath(dispatcherId, taskId) },
      { stream: 'stderr', path: dispatcherTeamMateWorkerErrorLogPath(dispatcherId, taskId) },
    ];
  }
  if (providerRef === BUILTIN_CLAUDE_CODE_PROVIDER_REF) {
    return [
      {
        stream: 'stderr',
        path: dispatcherTeamMateWorkerClaudeStreamLogPath(dispatcherId, taskId),
      },
    ];
  }
  return [];
}

async function readTail(
  stream: TeamMateWorkerLogStreamKind,
  path: string,
  maxBytes: number,
): Promise<TeamMateWorkerLogStream> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { stream, available: false, bytes: 0, truncated: false, text: '' };
    }
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    if (length <= 0) {
      return { stream, available: true, bytes: 0, truncated: false, text: '' };
    }
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return {
      stream,
      available: true,
      bytes: length,
      truncated: start > 0,
      text: buffer.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}

function clampMaxBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return TEAMMATE_WORKER_LOG_DEFAULT_MAX_BYTES;
  }
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  if (floored > TEAMMATE_WORKER_LOG_MAX_BYTES_CAP) {
    return TEAMMATE_WORKER_LOG_MAX_BYTES_CAP;
  }
  return floored;
}
