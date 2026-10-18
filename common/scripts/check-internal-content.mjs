#!/usr/bin/env node
// One owner for the public-repository content rules used by commits, CI and packs.
import { spawn, execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FORBIDDEN_RE =
  /(ou_[A-Za-z0-9]{20}|oc_[A-Za-z0-9]{20}|cli_[A-Za-z0-9]{16}|\/data00\/|\/home\/[a-z][a-z0-9_-]+\/)/g;
const ALLOWED_RE =
  /^\/home\/(volta|linuxbrew|linuxbrew2|example|me|me-old|meredith|op|someoneelse)\/$/;
const ALLOWED_DIST_RE = /^\/home\/(volta|linuxbrew)\/$/;
const PATTERN_DEFINITIONS = new Set([
  '.gitleaks.toml',
  '.agents/domains/repository-operations-and-release.md',
  'common/scripts/check-internal-content.mjs',
]);

async function scan(command, args, allowed, cwd) {
  const child = spawn(command, args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const hits = new Set();
  await Promise.all([
    (async () => {
      for await (const line of createInterface({ input: child.stdout })) {
        for (const match of line.matchAll(FORBIDDEN_RE)) {
          if (!allowed.test(match[0])) hits.add(match[0]);
        }
      }
    })(),
    new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} failed with exit code ${code}`));
      });
    }),
  ]);
  return [...hits].sort();
}

function report(name, hits) {
  if (hits.length === 0) return false;
  console.error(`[internal-content] FORBIDDEN internal content in ${name}:`);
  for (const hit of hits) console.error(`  ${hit}`);
  return true;
}

async function main() {
  const mode = process.argv[2] ?? '--staged';
  let failed = false;
  if (mode === '--tarball') {
    const tarball = process.argv[3];
    if (!tarball || !(await stat(tarball)).isFile()) {
      throw new Error(
        'usage: node common/scripts/check-internal-content.mjs --tarball <file.tgz>',
      );
    }
    failed = report(
      tarball,
      await scan('tar', ['-xzOf', tarball], ALLOWED_DIST_RE),
    );
  } else {
    if (mode !== '--staged' && mode !== '--tree') {
      throw new Error(
        'usage: node common/scripts/check-internal-content.mjs [--staged|--tree|--tarball <file.tgz>]',
      );
    }
    const { stdout: root } = await execFileAsync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { windowsHide: true },
    );
    const cwd = root.trim();
    const args =
      mode === '--tree'
        ? ['ls-files', '-z']
        : ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'];
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
    });
    for (const file of stdout.split('\0').filter(Boolean)) {
      if (PATTERN_DEFINITIONS.has(file)) continue;
      // Read the index, including symlink blobs, rather than following working-tree paths.
      failed =
        report(
          file,
          await scan('git', ['show', `:${file}`], ALLOWED_RE, cwd),
        ) || failed;
    }
  }
  if (failed) {
    console.error('[internal-content] dreamux is a public repository.');
    console.error(
      '[internal-content] Remove the internal identifier or path, or use a',
    );
    console.error(
      '[internal-content] reviewed public placeholder, before committing.',
    );
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`[internal-content] ${error.message}`);
  process.exitCode = 2;
}
