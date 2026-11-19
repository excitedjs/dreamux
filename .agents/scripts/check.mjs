#!/usr/bin/env node
// Knowledge links, reachability, source citations and task-record consistency.
import { execFile, spawn } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const kbRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(kbRoot, '..');
let errors = 0;
const display = (path) => relative(repoRoot, path).split(sep).join('/');
function fail(message) {
  console.error(message);
  errors++;
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}
async function filesUnder(directory, excluded = new Set()) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path, excluded)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
const links = (text) =>
  [...text.matchAll(/\]\(([^)]+)\)/g)].map((match) =>
    match[1].replace(/#.*$/, ''),
  );
function linkPath(file, target) {
  return target.startsWith('/')
    ? resolve(repoRoot, `.${target}`)
    : resolve(dirname(file), target);
}
async function gitFiles(args = []) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repoRoot, 'ls-files', '-z', ...args],
    { windowsHide: true },
  );
  return stdout.split('\0').filter(Boolean);
}

const markdown = (await filesUnder(kbRoot, new Set(['skills']))).filter(
  (file) => file.endsWith('.md'),
);
const contents = new Map();
for (const file of markdown) {
  const text = await readFile(file, 'utf8');
  contents.set(file, text);
  for (const target of links(text)) {
    if (!target || /^(?:https?:\/\/|mailto:)/.test(target)) continue;
    const full = linkPath(file, target);
    if (!(await exists(full)))
      fail(
        `broken markdown link in ${display(file)} -> ${target} (resolved to ${full})`,
      );
  }
}
const seen = new Set([join(kbRoot, 'root.md')]);
const queue = [...seen];
for (const file of queue) {
  for (const target of links(contents.get(file) ?? '')) {
    if (!target || /^(?:http|mailto:)/.test(target)) continue;
    const full = linkPath(file, target);
    const rel = relative(kbRoot, full);
    if (
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      !full.endsWith('.md') ||
      seen.has(full)
    )
      continue;
    seen.add(full);
    queue.push(full);
  }
}
for (const file of markdown) {
  if (!seen.has(file))
    fail(`orphan KB doc: ${display(file)} is not reachable from root.md`);
}

const domains = join(kbRoot, 'domains');
if (!(await exists(domains)))
  fail(`domains tree missing: ${domains} (path-liveness check has no target)`);
else {
  for (const entry of await readdir(domains)) {
    if (!entry.endsWith('.md')) continue;
    const text = await readFile(join(domains, entry), 'utf8');
    for (const match of text.matchAll(/\/packages\/[^`)\s#]+/g)) {
      const path = match[0].replace(/:\d+.*$/, '');
      if (!(await exists(resolve(repoRoot, `.${path}`))))
        fail(`missing source path: domains/${entry} -> ${path}`);
    }
  }
}
for (const file of await gitFiles()) {
  if (file.startsWith('.agents/') || /CHANGELOG\.(json|md)$/.test(file))
    continue;
  const path = join(repoRoot, file);
  if (!(await exists(path)) || !(await stat(path)).isFile()) continue;
  const text = await readFile(path, 'utf8');
  const citations = new Set(
    [...text.matchAll(/\.agents\/[A-Za-z0-9._/-]*[A-Za-z0-9_-]/g)].map(
      (match) => match[0],
    ),
  );
  for (const citation of citations) {
    if (
      !citation.startsWith('.agents/wip') &&
      !(await exists(join(repoRoot, citation)))
    )
      fail(`stale .agents reference: ${file} -> ${citation}`);
  }
}

const taskChecker = join(
  kbRoot,
  'skills',
  'dev-workflow',
  'scripts',
  'init_task.py',
);
if (!(await exists(taskChecker)))
  fail(`task record checker missing: ${taskChecker}`);
else {
  const child = spawn(
    process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    [taskChecker, 'check-all', '--repo-root', repoRoot],
    { stdio: 'inherit', windowsHide: true },
  );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) fail(`task record checker failed (exit ${code})`);
}

const packageFiles = (
  await filesUnder(
    join(repoRoot, 'packages'),
    new Set(['node_modules', 'dist']),
  )
).map((path) => path.split(sep).join('/'));
for (const file of await gitFiles([
  'packages/*/CLAUDE.md',
  'packages/*/*/CLAUDE.md',
  'packages/*/*/*/CLAUDE.md',
])) {
  const text = await readFile(join(repoRoot, file), 'utf8');
  for (const match of text.matchAll(/`([A-Za-z0-9_./-]+\.ts)`/g)) {
    if (!packageFiles.some((path) => path.endsWith(`/${match[1]}`)))
      fail(
        `stale .ts reference in ${file} -> ${match[1]} (no match under packages/)`,
      );
  }
}
if (errors > 0) {
  console.error(`\n${errors} KB issue(s) found`);
  process.exitCode = 1;
} else
  console.log(
    `KB OK (${markdown.filter((file) => file !== join(kbRoot, 'root.md')).length} files reachable from root.md)`,
  );
