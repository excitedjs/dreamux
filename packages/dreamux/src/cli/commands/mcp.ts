import type { Argv, CommandModule } from 'yargs';

import { runDreamuxMcp } from '../../mcp/shim.js';
import { DREAMUX_MCP_LEASE_ENV } from '../../service/mcp/descriptor.js';

interface McpArgv {
  adminSocket?: string;
}

/**
 * The one subcommand every Agent-facing MCP server is launched as.
 *
 * The lease token is read from the environment rather than declared as an
 * option: it is a capability, and argv is readable by every process on the box.
 * There is deliberately no `--dispatcher`, `--caller`, `--team-id`, or
 * `--channel-tools-b64` — the lease already names everything this process is
 * allowed to be.
 */
export function createMcpCommand(): CommandModule<{}, McpArgv> {
  return {
    command: 'mcp',
    describe:
      'Run the Dreamux MCP stdio server for an agent runtime (launched by dreamux serve)',
    builder: (y) =>
      y.option('admin-socket', {
        type: 'string',
        describe: 'dreamux serve admin socket path',
      }) as Argv<McpArgv>,
    handler: async (argv) => {
      const lease = process.env[DREAMUX_MCP_LEASE_ENV];
      if (lease === undefined || lease === '') {
        throw new Error(
          `${DREAMUX_MCP_LEASE_ENV} is required; this command is launched by ` +
            'dreamux serve, not run by hand',
        );
      }
      await runDreamuxMcp({
        lease,
        ...(argv.adminSocket !== undefined
          ? { adminSocketPath: argv.adminSocket }
          : {}),
      });
    },
  };
}
