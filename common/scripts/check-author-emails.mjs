#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function authorEmailError(
  email,
  denylist = process.env.AUTHOR_EMAIL_DENYLIST_REGEX,
) {
  if (!email) return 'author email is not set';
  if (/@(?:localhost|[^@]*\.local|local)$/.test(email))
    return 'machine-local author email';
  if (!email.includes('@')) return 'invalid author email (no @-domain)';
  if (denylist && new RegExp(denylist, 'i').test(email))
    return 'author email matches AUTHOR_EMAIL_DENYLIST_REGEX';
  return null;
}

async function main() {
  const event = JSON.parse(
    await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'),
  );
  let args;
  if (process.env.GITHUB_EVENT_NAME === 'pull_request')
    args = [`${event.pull_request.base.sha}..${event.pull_request.head.sha}`];
  else if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch')
    args = ['-1', 'HEAD'];
  else if (event.before === '0'.repeat(40)) args = ['-1', event.after];
  else args = [`${event.before}..${event.after}`];
  const { stdout } = await execFileAsync(
    'git',
    ['log', '--format=%H%x00%ae', ...args],
    { windowsHide: true },
  );
  for (const entry of stdout.trim().split('\n').filter(Boolean)) {
    const [commit, email] = entry.split('\0');
    const error = authorEmailError(email);
    if (error !== null) {
      console.error(`::error::commit ${commit}: ${error}: ${email}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
