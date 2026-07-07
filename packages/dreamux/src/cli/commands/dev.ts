import type { Argv, CommandModule } from 'yargs';

import { runFeishuTopicContextSmoke } from '../../dev/feishu-topic-context-smoke.js';
import { noopHandler } from './types.js';

interface DevSmokeArgv {
  json?: boolean;
}

export function createDevCommand(): CommandModule {
  return {
    command: 'dev <command>',
    describe: 'Run Dreamux developer diagnostics',
    builder: (y) =>
      y
        .command(createFeishuTopicContextSmokeCommand())
        .demandCommand(1, 'Choose a dev command'),
    handler: noopHandler,
  };
}

function createFeishuTopicContextSmokeCommand(): CommandModule<{}, DevSmokeArgv> {
  return {
    command: 'feishu-topic-context-smoke',
    describe: 'Verify bindable channel targets use isolated dispatcher runtimes',
    builder: (y) =>
      y.option('json', {
        type: 'boolean',
        describe: 'Print machine-readable JSON',
      }) as Argv<DevSmokeArgv>,
    handler: async (argv) => {
      const result = await runFeishuTopicContextSmoke();
      if (argv.json === true) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log('Feishu topic context smoke passed.');
      console.log(`accepted: ${result.accepted.join(', ')}`);
      console.log(`global runtimes: ${result.globalRuntimeIds.join(', ')}`);
      console.log(`target runtimes: ${result.targetRuntimeIds.join(', ')}`);
      console.log(`resumed runtimes: ${result.resumedRuntimeIds.join(', ')}`);
      console.log(`runtime count: ${result.runtimeCount}`);
    },
  };
}
