/** Observe the inherited log before the synthetic native stream writes to it. */
import { writeFile } from 'node:fs/promises';
import { expectOwnerOnlyPermissions } from '../../../../../common/scripts/test-permissions.mjs';

const errors = [];
for (const [path, mode] of JSON.parse(process.env.DREAMUX_TEST_LOG_PATHS)) {
  try {
    await expectOwnerOnlyPermissions(path, mode);
  } catch (error) {
    errors.push(String(error));
  }
}
await writeFile(
  process.env.DREAMUX_TEST_LOG_OBSERVATION,
  JSON.stringify(errors),
);
process.stderr.write('fixture stderr\n');
process.argv[2] = 'echo';
await import('./fake-claude-stream.mjs');
