import {
  Client,
  InMemoryTransport,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/client';
import type { Transport as ServerTransport } from '@modelcontextprotocol/server';

export type McpProtocolVersion =
  | '2026-07-28'
  | '2025-11-25'
  | '2025-06-18';

export interface ConnectedMcpClient {
  client: Client;
  close(): Promise<void>;
}

export async function connectMcpClient(
  runServer: (transport: ServerTransport) => Promise<void>,
  protocolVersion: McpProtocolVersion = '2025-11-25',
): Promise<ConnectedMcpClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const run = runServer(serverTransport);
  const client = new Client(
    { name: 'dreamux-test-client', version: '1.0.0' },
    {
      supportedProtocolVersions: [protocolVersion],
      versionNegotiation: {
        mode:
          protocolVersion === '2026-07-28'
            ? { pin: protocolVersion }
            : 'legacy',
      },
    },
  );
  try {
    await client.connect(clientTransport);
  } catch (err) {
    await clientTransport.close();
    await run;
    throw err;
  }
  return {
    client,
    async close(): Promise<void> {
      await client.close();
      await run;
    },
  };
}

export async function listedTools(client: Client): Promise<Tool[]> {
  return (await client.listTools()).tools;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  return client.callTool(
    { name, arguments: args },
    signal === undefined ? undefined : { signal },
  );
}
