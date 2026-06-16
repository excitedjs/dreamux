import type { Argv, CommandModule } from 'yargs';

import { readPackagedChangelog } from '../changelog.js';

interface ChangelogArgv {
  json?: boolean;
}

export function createChangelogCommand(): CommandModule<{}, ChangelogArgv> {
  return {
    command: 'changelog',
    describe:
      "Print the installed package's changelog (run after install, before restart/onboard)",
    builder: (y) =>
      y.option('json', {
        type: 'boolean',
        describe: 'Print the raw CHANGELOG.json instead of CHANGELOG.md',
      }) as Argv<ChangelogArgv>,
    handler: async (argv) => {
      const text = await readPackagedChangelog({ json: argv.json === true });
      process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    },
  };
}
