/**
 * A minimal fake `claude --print --input-format stream-json` child for tests.
 *
 * It speaks just enough of the stream-json wire protocol to exercise the
 * resident-session supervisor (`claude-code/supervisor.ts`) over real
 * OS pipes, with no real `claude` binary:
 *
 *  - reads NDJSON `user` messages on stdin and keeps stdin open (resident);
 *  - for each turn, emits a `system/init` (once) and an `assistant` snapshot;
 *  - answers a Remote Control `control_request` with a synthetic URL;
 *  - mode `echo`   → also emits a terminal `result` (a normal, completed turn);
 *  - mode `stall`  → never emits a `result` (the stuck-turn path the per-turn
 *    deadline must cover) while the child stays alive.
 */

import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'echo';
let sentInit = false;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg?.type === 'control_request' && msg?.request?.subtype === 'remote_control') {
    process.stderr.write('remote-control-requested\n');
    emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: { session_url: 'https://example.invalid/session/fake' },
      },
    });
    return;
  }
  // Ignore the session's defensive control acks; only act on user turns.
  if (msg?.type !== 'user') return;
  const text = msg?.message?.content?.[0]?.text ?? '';

  if (!sentInit) {
    emit({ type: 'system', subtype: 'init', session_id: 'fake-sess-1', model: 'fake-model' });
    sentInit = true;
  }
  emit({
    type: 'assistant',
    session_id: 'fake-sess-1',
    message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] },
  });
  if (mode === 'echo') {
    emit({ type: 'result', subtype: 'success', result: `echo:${text}`, session_id: 'fake-sess-1' });
  }
  // mode 'stall': deliberately no `result` — the turn never terminates.
});
