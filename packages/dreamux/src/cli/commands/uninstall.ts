import type { Argv, CommandModule } from 'yargs';
import {
  runUninstall,
  type UninstallRunResult,
} from '../../onboard/uninstall.js';
interface UninstallArgv {
  dryRun?: boolean;
  configDir?: string;
}
export function createUninstallCommand(): CommandModule<{}, UninstallArgv> {
  return {
    command: 'uninstall',
    describe: 'Remove files and user service created by onboard',
    builder: (y) =>
      y
        .option('dry-run', {
          type: 'boolean',
          describe:
            'Print the planned removals without deleting or unregistering',
        })
        .option('config-dir', {
          type: 'string',
          describe: 'dreamux global config directory',
        }) as Argv<UninstallArgv>,
    handler: async (argv) => {
      const result = await runUninstall({
        dryRun: argv.dryRun,
        configDir: argv.configDir,
      });
      printUninstallResult(result);
      if (result.failures.length > 0) {
        throw new Error(
          `dreamux uninstall failed after ${result.failures.length} operation(s); see file ledger above`,
        );
      }
    },
  };
}
function printUninstallResult(result: UninstallRunResult): void {
  for (const warning of result.warnings) {
    console.error(`warning: ${warning}`);
  }
  console.log('dreamux uninstall file ledger:');
  for (const entry of result.entries) {
    const target =
      entry.targetPath === undefined ? '' : `\ttarget=${entry.targetPath}`;
    const detail = entry.detail === undefined ? '' : `\tdetail=${entry.detail}`;
    console.log(`${entry.status}\t${entry.path}\t${entry.reason}${target}${detail}`);
  }
  console.log(
    `dreamux uninstall service: ${result.service.platform} ${result.service.unitPath}`,
  );
  for (const failure of result.failures) {
    console.error(`failure: ${failure.path}: ${failure.reason}: ${failure.error}`);
  }
}
