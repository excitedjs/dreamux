import { installBundledWorkspaceSkills } from './bundled-skills.js';
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
        : result.status === 'skipped'
          ? 'skipped'
          : 'unchanged';
    const reason = result.status === 'skipped'
      ? `workspace-local bundled skill symlink skipped: ${result.skillName}; ${result.reason}`
      : `workspace-local bundled skill symlink: ${result.skillName}`;
    options.ledger.record(
      result.targetPath,
      status,
      reason,
    );
  }
}
