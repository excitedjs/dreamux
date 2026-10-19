#!/usr/bin/env node
// One owner for the public-repository content rules used by commits, CI and packs.
import { spawn, execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const diagnosticStart = performance.now();
function diagnostic(event, fields = {}) {
  console.error(
    'PR476_CONTENT_SCAN_DIAG ' +
      JSON.stringify({
        source: 'scanner',
        pid: process.pid,
        ppid: process.ppid,
        event,
        monotonicMs: performance.now(),
        elapsedMs: performance.now() - diagnosticStart,
        ...fields,
      }),
  );
}
function diagnosticError(error) {
  return error instanceof Error
    ? {
        ...error,
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: diagnosticError(error.cause),
      }
    : error;
}
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
  const diagnosticCommand = command === 'tar' ? { command, args } : { command };
  diagnostic('child.request', diagnosticCommand);
  const child = spawn(command, args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  diagnostic('child.created', {
    ...diagnosticCommand,
    childPid: child.pid,
    spawnfile: child.spawnfile,
  });
  child.once('spawn', () =>
    diagnostic('child.spawn', { ...diagnosticCommand, childPid: child.pid }),
  );
  child.once('exit', (code, signal) =>
    diagnostic('child.exit', {
      ...diagnosticCommand,
      childPid: child.pid,
      code,
      signal,
    }),
  );
  const hits = new Set();
  await Promise.all([
    (async () => {
      let firstLine = true;
      for await (const line of createInterface({ input: child.stdout })) {
        if (firstLine) {
          firstLine = false;
          diagnostic('readline.first', {
            ...diagnosticCommand,
            childPid: child.pid,
          });
        }
        for (const match of line.matchAll(FORBIDDEN_RE)) {
          if (!allowed.test(match[0])) hits.add(match[0]);
        }
      }
      diagnostic('readline.eof', {
        ...diagnosticCommand,
        childPid: child.pid,
        sawLine: !firstLine,
      });
    })(),
    new Promise((resolve, reject) => {
      child.once('error', (error) => {
        diagnostic('child.error', {
          ...diagnosticCommand,
          childPid: child.pid,
          error: diagnosticError(error),
        });
        reject(error);
      });
      child.once('close', (code) => {
        diagnostic('child.close', {
          ...diagnosticCommand,
          childPid: child.pid,
          code,
        });
        if (code === 0) resolve();
        else reject(new Error(`${command} failed with exit code ${code}`));
      });
    }),
  ]);
  diagnostic('scan.complete', { ...diagnosticCommand, childPid: child.pid });
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
    diagnostic('stat.begin', { tarball });
    if (!tarball || !(await stat(tarball)).isFile()) {
      throw new Error(
        'usage: node common/scripts/check-internal-content.mjs --tarball <file.tgz>',
      );
    }
    diagnostic('stat.end', { tarball });
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
  diagnostic('scanner.error', { error: diagnosticError(error) });
  console.error(`[internal-content] ${error.message}`);
  process.exitCode = 2;
}
