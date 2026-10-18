#!/usr/bin/env node
// Release CI owns this key and fetches GitHub's published host keys before push.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const key = process.env.RELEASE_DEPLOY_KEY;
if (!key)
  throw new Error(
    'RELEASE_DEPLOY_KEY secret is missing; the protected branches cannot be pushed without the release deploy key.',
  );
const directory = join(homedir(), '.ssh');
await mkdir(directory, { recursive: true });
const keyPath = join(directory, 'release_deploy_key');
await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
await chmod(keyPath, 0o600);
const response = await fetch('https://api.github.com/meta');
if (!response.ok)
  throw new Error(`GitHub host-key lookup failed: HTTP ${response.status}`);
const metadata = await response.json();
await writeFile(
  join(directory, 'release_known_hosts'),
  metadata.ssh_keys.map((value) => `github.com ${value}\n`).join(''),
);
