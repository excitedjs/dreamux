import type { Argv, CommandModule } from 'yargs';

import { printDoctorResult, runDreamuxDoctor } from '../doctor.js';

interface DoctorArgv {
  json?: boolean;
}

export function createDoctorCommand(): CommandModule<{}, DoctorArgv> {
  return {
    command: 'doctor',
    describe: 'Run setup diagnostics',
    builder: (y) =>
      y.option('json', {
        type: 'boolean',
        describe: 'Print machine-readable JSON',
      }) as Argv<DoctorArgv>,
    handler: async (argv) => {
      const result = await runDreamuxDoctor();
      if (argv.json === true) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printDoctorResult(result);
      }
      if (!result.ok) process.exitCode = 1;
    },
  };
}
