/** Synthetic protocol replays; native ordering evidence is recorded in the task. */
import type { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeStreamRpc } from '../src/rpc.js';
import type { ClaudeCodeStreamRpcOptions } from '../src/rpc.js';
import type { ClaudeProtocolEvent } from '../src/types.js';

interface Input {
  uuid: string;
  message: { content: Array<{ text: string }> };
}
interface ControlFrame {
  type: string;
  request_id: string;
  request: Record<string, unknown>;
}
type WriteCallback = (error?: Error | null) => void;

function harness(options: Partial<ClaudeCodeStreamRpcOptions> = {}) {
  const writes: Input[] = [];
  const controls: ControlFrame[] = [];
  const events: ClaudeProtocolEvent[] = [];
  const reap = vi.fn();
  const stdin = {
    writable: true,
    onWrite: (_input: Input, callback: WriteCallback) => callback(),
    write(chunk: string, callback: WriteCallback = () => undefined) {
      const frame = JSON.parse(chunk) as Record<string, unknown>;
      // `writes` is the user-input ledger; control traffic has its own.
      if (String(frame['type']).startsWith('control_')) {
        controls.push(frame as unknown as ControlFrame);
        callback();
        return true;
      }
      const input = frame as unknown as Input;
      writes.push(input);
      this.onWrite(input, callback);
      return true;
    },
  };
  const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
    sessionId: 'session',
    turnTimeoutMs: 1_000,
    reapOnTimeout: reap,
    onProtocolEvent: (event) => events.push(event),
    ...options,
  });
  rpcs.push(rpc);
  const emit = (...lines: Record<string, unknown>[]) => {
    rpc.onStdoutChunk(
      lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
    );
  };
  const init = (supported = true) =>
    emit({
      type: 'system',
      subtype: 'init',
      session_id: 'session',
      capabilities: supported ? ['msg_lifecycle_v1'] : [],
    });
  const results = () => events.filter((event) => event.kind === 'result');
  const controlOk = (requestId: string) => {
    emit({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: {} },
    });
  };
  return {
    rpc,
    stdin,
    writes,
    controls,
    reap,
    emit,
    init,
    results,
    controlOk,
  };
}

const rpcs: ClaudeCodeStreamRpc[] = [];
afterEach(() => {
  for (const rpc of rpcs.splice(0)) rpc.stop();
  vi.useRealTimers();
});

describe('interrupting outstanding work', () => {
  it('asks claude even with no request outstanding, and stops asking once closed', async () => {
    const h = harness();
    h.init();

    // A resident session runs turns this host never submitted. `/stop` reaches
    // those too, so the ask goes out on the strength of the session alone.
    const asked = h.rpc.interrupt('Stopped from Feishu.');
    expect(h.controls).toHaveLength(1);
    h.controlOk(h.controls[0]!.request_id);
    await expect(asked).resolves.toBe(true);

    h.rpc.stop();
    await expect(h.rpc.interrupt('Stopped from Feishu.')).resolves.toBe(false);
    expect(h.controls).toHaveLength(1);
  });
});

describe('native failure and transport lifetime', () => {
  it.each(['throw', 'callback'])(
    'reports an ambiguous native write failure through %s',
    async (mode) => {
      const h = harness();
      h.stdin.onWrite = (_input, callback) => {
        const error = new Error('write failed');
        if (mode === 'throw') throw error;
        else callback(error);
      };
      await expect(h.rpc.submit('A')).resolves.toMatchObject({
        status: 'ambiguous',
      });
      expect(h.reap).not.toHaveBeenCalled();
    },
  );

  it('reports a proven failure before writing to an unavailable child', async () => {
    const h = harness();
    h.stdin.writable = false;
    await expect(h.rpc.submit('A')).resolves.toMatchObject({
      status: 'failed',
    });
    expect(h.writes).toHaveLength(0);
  });
});

describe('idle policy and result contract', () => {
  it('keeps Remote Control and tool permission replies independent of requests', () => {
    const urls: string[] = [];
    const h = harness({ onRemoteControlUrl: (url) => urls.push(url) });
    h.rpc.enableRemoteControl();
    h.emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: h.controls[0]!.request_id,
        response: { session_url: 'https://example.invalid/session' },
      },
    });
    h.emit({
      type: 'control_request',
      request_id: 'permission',
      request: { subtype: 'can_use_tool', input: { command: 'pwd' } },
    });
    expect(urls).toEqual(['https://example.invalid/session']);
    expect(h.controls[1]).toMatchObject({
      type: 'control_response',
      response: {
        request_id: 'permission',
        response: { behavior: 'allow', updatedInput: { command: 'pwd' } },
      },
    });
    expect(h.writes).toEqual([]);
    expect(h.results()).toEqual([]);
  });
});
