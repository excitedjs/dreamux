/** Synthetic startup protocol; observe permissions before writing inherited logs. */
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { WebSocketServer } from 'ws';
import { expectOwnerOnlyPermissions } from '../../../../../common/scripts/test-permissions.mjs';

const paths = JSON.parse(process.env.DREAMUX_TEST_LOG_PATHS);
const errors = [];
for (const [path, mode] of paths) {
  try {
    await expectOwnerOnlyPermissions(path, mode);
  } catch (error) {
    errors.push(String(error));
  }
}
await writeFile(
  process.env.DREAMUX_TEST_LOG_OBSERVATION,
  JSON.stringify(errors),
);
process.stderr.write('fixture stderr\n');

function receive(line, send) {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result =
    request.method === 'initialize'
      ? { userAgent: 'fixture', codexHome: '', platformOs: process.platform }
      : {
          thread: { id: 'fixture-thread' },
          model: 'fixture',
          reasoningEffort: null,
        };
  send(JSON.stringify({ id: request.id, result }));
}

const transport = process.argv[process.argv.indexOf('--listen') + 1];
if (transport === 'stdio://') {
  createInterface({ input: process.stdin }).on('line', (line) =>
    receive(line, (frame) => process.stdout.write(`${frame}\n`)),
  );
} else {
  process.stdout.write('fixture stdout\n');
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) =>
    socket.on('message', (data) =>
      receive(data.toString(), (frame) => socket.send(frame)),
    ),
  );
  server.listen(transport.slice('unix://'.length));
}
