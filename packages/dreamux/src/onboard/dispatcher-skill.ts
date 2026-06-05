import { installBundledWorkspaceSkills } from '../runtime/bundled-skills.js';
import type { OnboardFileLedger } from './types.js';

export async function installDispatcherSkill(options: {
  dispatcherCwd: string;
  ledger: OnboardFileLedger;
  dryRun: boolean;
}): Promise<void> {
  const results = await installBundledWorkspaceSkills({
    dispatcherCwd: options.dispatcherCwd,
    dryRun: options.dryRun,
  });
  for (const result of results) {
    const status = result.status === 'linked'
      ? 'created'
      : result.status === 'replaced'
        ? 'modified'
        : 'unchanged';
    options.ledger.record(
      result.targetPath,
      status,
      `workspace-local bundled skill symlink: ${result.skillName}`,
    );
  }
}
