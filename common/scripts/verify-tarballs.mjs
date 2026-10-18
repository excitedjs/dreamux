#!/usr/bin/env node
// Release artifacts must contain their manifest and pass the shared content gate.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

async function main() {
  const directory = resolve(
    process.argv[2] ?? 'common/temp/prerelease-tarballs',
  );
  const archives = (await readdir(directory))
    .filter((name) => name.endsWith('.tgz'))
    .sort();
  if (archives.length === 0)
    throw new Error(
      `Expected packed tarballs under ${directory} but found none; aborting before publish.`,
    );
  for (const name of archives) {
    const archive = join(directory, name);
    console.log(`== ${archive} ==`);
    const listing = spawn('tar', ['-tzf', archive], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let manifest = false;
    await Promise.all([
      (async () => {
        for await (const line of createInterface({ input: listing.stdout })) {
          console.log(line);
          if (line === 'package/package.json') manifest = true;
        }
      })(),
      exited(listing),
    ]);
    if (!manifest)
      throw new Error(`Tarball ${archive} is missing package.json`);
    const scanner = join(
      dirname(fileURLToPath(import.meta.url)),
      'check-internal-content.mjs',
    );
    await exited(
      spawn(process.execPath, [scanner, '--tarball', archive], {
        stdio: 'inherit',
        windowsHide: true,
      }),
    );
  }
}

function exited(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Artifact verification failed with exit code ${code}; aborting before publish.`,
            ),
          ),
    );
  });
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
