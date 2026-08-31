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
import type { CliDeps, DreamuxCommand, ExecEntry } from './types.js';

export type { CliDeps, ExecEntry };

export function createDreamuxCommands(deps: CliDeps): DreamuxCommand[] {
  return [
    createOnboardCommand(),
    createUninstallCommand(),
    createServeCommand(deps),
    createStatusCommand(deps),
    createDoctorCommand(),
    createDaemonCommand(),
    createDispatcherCommand(deps),
    // One MCP subcommand for every Agent-facing server. Which server it is, and
    // for whom, lives entirely in the lease token it is launched with.
    createMcpCommand(),
    createConfigCommand(),
    createChangelogCommand(),
  ];
}
