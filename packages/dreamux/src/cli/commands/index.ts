import { createChangelogCommand } from './changelog.js';
import { createChannelMcpCommand } from './channel-mcp.js';
import { createConfigCommand } from './config.js';
import { createCronMcpCommand } from './cron-mcp.js';
import { createDaemonCommand } from './daemon.js';
import { createDispatcherCommand } from './dispatcher.js';
import { createDoctorCommand } from './doctor.js';
import { createOnboardCommand } from './onboard.js';
import { createServeCommand } from './serve.js';
import { createStatusCommand } from './status.js';
import { createSubscribeChannelMcpCommand } from './subscribe-channel-mcp.js';
import { createTeamMateMcpCommand } from './teammate-mcp.js';
import { createTeamMcpCommand } from './team-mcp.js';
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
    createChannelMcpCommand(),
    createSubscribeChannelMcpCommand(),
    createTeamMateMcpCommand(),
    createTeamMcpCommand(),
    createCronMcpCommand(),
    createConfigCommand(),
    createChangelogCommand(),
  ];
}
