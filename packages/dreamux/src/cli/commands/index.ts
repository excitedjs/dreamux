import { createChangelogCommand } from './changelog.js';
import { createConfigCommand } from './config.js';
import { createDaemonCommand } from './daemon.js';
import { createDispatcherCommand } from './dispatcher.js';
import { createDoctorCommand } from './doctor.js';
import { createMcpCommand } from './mcp.js';
import { createOnboardCommand } from './onboard.js';
import { createServeCommand } from './serve.js';
import { createStatusCommand } from './status.js';
import { createUninstallCommand } from './uninstall.js';
import type { DreamuxCommand } from './types.js';

export function createDreamuxCommands(): DreamuxCommand[] {
  return [
    createOnboardCommand(),
    createUninstallCommand(),
    createServeCommand(),
    createStatusCommand(),
    createDoctorCommand(),
    createDaemonCommand(),
    createDispatcherCommand(),
    // One MCP subcommand for every Agent-facing server. Which server it is, and
    // for whom, lives entirely in the lease token it is launched with.
    createMcpCommand(),
    createConfigCommand(),
    createChangelogCommand(),
  ];
}
