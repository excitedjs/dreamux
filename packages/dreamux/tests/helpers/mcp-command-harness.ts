import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdminSocketServer } from '../../src/admin/socket.js';
import { CoreCommands } from '../../src/command/registry.js';
import { CoreCommandPort } from '../../src/command/port.js';
import { createLogger } from '../../src/platform/logger.js';
import { mcpCommands } from '../../src/service/mcp/commands.js';
import { McpLeaseRegistry } from '../../src/service/mcp/leases.js';
export function createCommandHarness() {
  const log = createLogger({ destination: { write() {} } });
  const mcpLeases = new McpLeaseRegistry(log);
  const registry = new CoreCommands(mcpCommands(mcpLeases));
  return { mcpLeases, registry, port: new CoreCommandPort(registry), log };
}
export async function startHarnessAdminSocket(
  harness: ReturnType<typeof createCommandHarness>,
) {
  const root = await mkdtemp(join(tmpdir(), 'dreamux-mcp-'));
  const socketPath = join(root, 'admin.sock');
  const server = createAdminSocketServer(
    { commands: harness.port, logger: harness.log },
    socketPath,
  );
  await server.start();
  return {
    socketPath,
    server,
    async close() {
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
