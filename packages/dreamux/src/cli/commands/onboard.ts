import type { Argv, CommandModule } from 'yargs';

import { runOnboard } from '../../onboard/run.js';
import type { OnboardRunResult } from '../../onboard/types.js';
import {
  collectOnboardAnswers,
  type OnboardCliOptions,
} from '../../onboard/wizard.js';
import { printServiceWarnings } from './service-output.js';

export function createOnboardCommand(): CommandModule<{}, OnboardCliOptions> {
  return {
    command: 'onboard',
    describe: 'Run first-time setup',
    builder: buildOnboardOptions,
    handler: async (argv) => {
      const answers = await collectOnboardAnswers(argv);
      const result = await runOnboard({ answers });
      printOnboardResult(result);
    },
  };
}

function buildOnboardOptions(y: Argv): Argv<OnboardCliOptions> {
  return y
    .option('yes', {
      type: 'boolean',
      describe: 'Accept defaults and require non-default values via options',
    })
    .option('dry-run', {
      type: 'boolean',
      describe: 'Print the planned file ledger without writing or registering',
    })
    .option('config-dir', {
      type: 'string',
      describe: 'dreamux global config directory',
    })
    .option('dispatcher-id', {
      type: 'string',
      describe: 'Dispatcher id to create or update',
    })
    .option('dispatcher-cwd', {
      type: 'string',
      describe: 'Working directory used when starting the dispatcher runtime',
    })
    .option('agent', {
      type: 'string',
      describe:
        'Agent runtime provider ref, optionally id=provider-ref (default: builtin:codex)',
    })
    .option('agent-config-json', {
      type: 'string',
      array: true,
      describe: 'Raw agent runtime config JSON, optionally id={...}',
    })
    .option('channel', {
      type: 'string',
      array: true,
      describe:
        'Channel provider ref, optionally id=provider-ref (default: builtin:feishu)',
    })
    .option('channel-config-json', {
      type: 'string',
      array: true,
      describe: 'Raw channel config JSON, optionally id={...}',
    })
    .option('register-service', {
      type: 'boolean',
      describe: 'Write and register the user-level service',
    })
    .option('start-service', {
      type: 'boolean',
      describe: 'Start the service after registration',
    })
    .option('dreamux-bin', {
      type: 'string',
      describe: 'Absolute dreamux bin path used by the service unit',
    }) as Argv<OnboardCliOptions>;
}

function printOnboardResult(result: OnboardRunResult): void {
  console.log('dreamux onboard file ledger:');
  for (const entry of result.files) {
    console.log(`${entry.status}\t${entry.path}\t${entry.reason}`);
  }
  console.log(
    result.doctor.ok
      ? 'dreamux onboard doctor: ok'
      : `dreamux onboard doctor: failed (${result.doctor.errors.length} error(s))`,
  );
  if (result.service !== null) {
    console.log(
      `dreamux onboard service: ${result.service.platform} ${result.service.unitPath}`,
    );
    printServiceWarnings(result.service.lingerEnabled, result.service.warnings);
  }
}
