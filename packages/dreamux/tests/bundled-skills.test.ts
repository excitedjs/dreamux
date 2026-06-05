import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  installBundledWorkspaceSkills,
} from '../src/runtime/bundled-skills.js';
import {
  BUNDLED_SKILL_NAMES,
  bundledSkillDir,
  dispatcherWorkspaceSkillDir,
} from '../src/runtime/paths.js';

describe('bundled workspace skill installer', () => {
  let root: string;
  let dispatcherCwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-bundled-skills-'));
    dispatcherCwd = join(root, 'dispatcher');
    mkdirSync(dispatcherCwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('installs every bundled skill as a workspace-local symlink', async () => {
    const results = await installBundledWorkspaceSkills({ dispatcherCwd });

    expect(results.map((result) => [result.skillName, result.status])).toEqual(
      BUNDLED_SKILL_NAMES.map((skillName) => [skillName, 'linked']),
    );
    for (const skillName of BUNDLED_SKILL_NAMES) {
      const target = dispatcherWorkspaceSkillDir(dispatcherCwd, skillName);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(realpathSync(target)).toBe(realpathSync(bundledSkillDir(skillName)));
      expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
    }
  });

  it('leaves correct symlinks unchanged on repeated installs', async () => {
    await installBundledWorkspaceSkills({ dispatcherCwd });

    const second = await installBundledWorkspaceSkills({ dispatcherCwd });

    expect(second.map((result) => result.status)).toEqual(
      BUNDLED_SKILL_NAMES.map(() => 'unchanged'),
    );
  });

  it('replaces stale or broken skill symlinks', async () => {
    const wrongTarget = join(root, 'old-skill');
    const target = dispatcherWorkspaceSkillDir(dispatcherCwd, 'dispatcher');
    mkdirSync(wrongTarget, { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(wrongTarget, target, 'dir');

    const results = await installBundledWorkspaceSkills({ dispatcherCwd });
    const dispatcherResult = results.find((result) =>
      result.skillName === 'dispatcher'
    );

    expect(dispatcherResult?.status).toBe('replaced');
    expect(realpathSync(target)).toBe(realpathSync(bundledSkillDir('dispatcher')));
  });

  it('migrates the legacy copied dispatcher skill directory to a symlink', async () => {
    const target = dispatcherWorkspaceSkillDir(dispatcherCwd, 'dispatcher');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), LEGACY_COPIED_DISPATCHER_SKILL);

    const results = await installBundledWorkspaceSkills({ dispatcherCwd });
    const dispatcherResult = results.find((result) =>
      result.skillName === 'dispatcher'
    );

    expect(dispatcherResult?.status).toBe('replaced');
    expect(dispatcherResult?.reason).toContain('legacy Dreamux-copied');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(realpathSync(target)).toBe(realpathSync(bundledSkillDir('dispatcher')));
  });

  it('does not migrate a modified legacy dispatcher skill directory', async () => {
    const target = dispatcherWorkspaceSkillDir(dispatcherCwd, 'dispatcher');
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'SKILL.md'),
      `${LEGACY_COPIED_DISPATCHER_SKILL}\n# local edit\n`,
    );

    const results = await installBundledWorkspaceSkills({ dispatcherCwd });
    const dispatcherResult = results.find((result) =>
      result.skillName === 'dispatcher'
    );

    expect(dispatcherResult?.status).toBe('skipped');
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain(
      '# local edit',
    );
  });

  it('does not overwrite an existing real skill directory', async () => {
    const target = dispatcherWorkspaceSkillDir(dispatcherCwd, 'team-dev-workflow');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), '# user skill\n');

    const results = await installBundledWorkspaceSkills({ dispatcherCwd });
    const conflict = results.find((result) =>
      result.skillName === 'team-dev-workflow'
    );

    expect(conflict?.status).toBe('skipped');
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('# user skill\n');
  });

  it('does not overwrite an existing real skill file', async () => {
    const target = dispatcherWorkspaceSkillDir(dispatcherCwd, 'dreamux-maintenance');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '# user file skill\n');

    const results = await installBundledWorkspaceSkills({ dispatcherCwd });
    const conflict = results.find((result) =>
      result.skillName === 'dreamux-maintenance'
    );

    expect(conflict?.status).toBe('skipped');
    expect(lstatSync(target).isFile()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('# user file skill\n');
  });

  it('rejects a missing dispatcher cwd instead of creating it', async () => {
    await expect(
      installBundledWorkspaceSkills({ dispatcherCwd: join(root, 'missing') }),
    ).rejects.toThrow('dispatcher cwd does not exist');
  });

  it('allows missing dispatcher cwd during dry-run planning', async () => {
    const missing = join(root, 'dry-run-missing');

    const results = await installBundledWorkspaceSkills({
      dispatcherCwd: missing,
      dryRun: true,
    });

    expect(results.map((result) => result.status)).toEqual(
      BUNDLED_SKILL_NAMES.map(() => 'linked'),
    );
    expect(existsSync(missing)).toBe(false);
  });

  it('fails explicitly on Windows instead of copying skills', async () => {
    await expect(
      installBundledWorkspaceSkills({ dispatcherCwd, platform: 'win32' }),
    ).rejects.toThrow('directory symlinks');
  });
});

const LEGACY_COPIED_DISPATCHER_SKILL = `---
name: dispatcher
description: Use from a dreamux dispatcher thread when work should be delegated to a tm-managed Codex teammate in a specific repository. Applies to bounded engineering tasks, test runs, codebase inspections, or follow-up work where the dispatcher should spawn/send/wait through the tm CLI exposed by the dreamux package and report the result back to the source chat.
---

# Dispatcher

Use this skill only from the dispatcher agent. The dreamux server hosts the
dispatcher lifecycle; it does not own tm teammate daemons, teammate DB rows, or
\`teammate.*\` admin methods.

## Boundaries

- Use \`tm\` from the dispatcher environment PATH. dreamux injects its package
  \`bin/\` directory into the dispatcher Codex app-server PATH.
- Pass \`--engine codex\` on every \`tm spawn\`; \`tm spawn\` defaults to Claude.
- Do not use \`npx\`, \`npm exec --package @excitedjs/tm\`, or
  \`@excitedjs/tm@latest\`; the dreamux package owns the tm dependency version.
- Do not call dreamux admin APIs to create teammate state.
- Do not infer the tm repo path from the dispatcher cwd unless the user or
  operator explicitly made that cwd the requested repo.
- Do not ask a tm-managed teammate to spawn another tm teammate.

## Before Delegating

Delegate when the request is bounded and can be completed by one teammate:
running tests, inspecting a code path, drafting a narrow patch, or collecting a
specific result. Handle the work directly when the request is tiny, ambiguous,
security-sensitive, or missing a repository path.

Resolve the repo path in this order:

1. An absolute path in the user request.
2. \`TM_DISPATCHER_DIR\`, if set by the operator.
3. Ask the user for the repo path. Do not guess.

Use an absolute repo path for \`tm spawn\`. If the user gives a relative path,
make it absolute only when its base is explicit.

## Command Shape

Preflight once per dispatcher session:

\`\`\`bash
tm --help
\`\`\`

## First-Turn Delegation

1. Pick a flat teammate name: lowercase letters, digits, and hyphens; keep it
   short and tied to the task, such as \`tests-api\` or \`scan-auth\`.
2. Spawn with the repo path, intent, and the full task prompt:

\`\`\`bash
tm spawn /absolute/repo \\
  --name tests-api \\
  --engine codex \\
  --timeout 180 \\
  --intent "Run focused API tests and summarize failures" \\
  --prompt "Run the focused API tests. Report commands, failures, and the smallest next fix."
\`\`\`

3. If \`tm spawn\` exits \`0\`, use its printed reply as the teammate result. If it
   exits \`124\`, the Codex turn did not finish within the sync window; wait
   without \`--fresh\`:

\`\`\`bash
tm wait tests-api --timeout 180
\`\`\`

4. Reply to the source chat with the teammate result, including the command
   summary and any explicit failure.

## Follow-Up Delegation

If a teammate name already exists for the same task, send a follow-up instead
of spawning a duplicate:

\`\`\`bash
tm send tests-api \\
  --prompt "Use the previous context. Re-run the focused test after the latest fix and summarize only changed results."
tm wait tests-api --timeout 180
\`\`\`

## Failure Reporting

When a tm command fails, stop the delegation sequence and report:

- which \`tm\` verb failed
- the teammate name and repo path
- the exit status if available
- the first useful stderr/stdout lines
- whether retrying the same teammate is safe

Known early startup failure to report verbatim:

\`\`\`text
codex daemon (pid N) exited before binding /tmp/teammate-codex/<name>/socket
\`\`\`

That means the Codex app-server daemon did not become reachable. Do not retry
silently; report the environment failure and ask the operator to verify
\`codex app-server --listen unix:///tmp/dispatcher-check.sock\` in the dispatcher
environment.

Do not say the dreamux server lost or recovered teammate state. The server does
not own that state.
`;
