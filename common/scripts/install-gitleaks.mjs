#!/usr/bin/env node
// Pinned, checksum-verified bootstrap shared by developer machines and release CI.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';

const GITLEAKS_VERSION = '8.30.1';
const execFileAsync = promisify(execFile);

async function download(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`download failed (${response.status}): ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      // Preserve the bootstrap's three retries for interrupted release downloads.
      if (attempt === 3) throw error;
      await setTimeout(1000 * 2 ** attempt);
    }
  }
}

async function main() {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[
    process.platform
  ];
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
  if (!os || !arch)
    throw new Error(
      `unsupported platform: ${process.platform}/${process.arch}`,
    );
  const directory =
    process.env.GITLEAKS_INSTALL_DIR || join(homedir(), '.local', 'bin');
  const binary = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks';
  const extension = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const asset = `gitleaks_${GITLEAKS_VERSION}_${os}_${arch}.${extension}`;
  const base = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`;
  const temporary = await mkdtemp(join(tmpdir(), 'dreamux-gitleaks-'));
  try {
    console.log(`downloading ${asset}`);
    const [archive, checksums] = await Promise.all([
      download(`${base}/${asset}`),
      download(`${base}/gitleaks_${GITLEAKS_VERSION}_checksums.txt`),
    ]);
    const expected = checksums
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .find(([, name]) => name === asset || name === `*${asset}`)?.[0];
    if (!expected)
      throw new Error(
        `no checksum published for ${asset}; refusing to install`,
      );
    const actual = createHash('sha256').update(archive).digest('hex');
    if (actual !== expected)
      throw new Error(
        `checksum mismatch for ${asset}: expected ${expected}, actual ${actual}`,
      );
    const archivePath = join(temporary, asset);
    await writeFile(archivePath, archive);
    // Windows ships bsdtar with ZIP support; Unix releases use standard tar.gz.
    const tar =
      process.platform === 'win32'
        ? join(process.env.SystemRoot, 'System32', 'tar.exe')
        : 'tar';
    await execFileAsync(tar, ['-xf', archivePath, '-C', temporary, binary], {
      windowsHide: true,
    });
    await mkdir(directory, { recursive: true });
    const installed = join(directory, binary);
    await copyFile(join(temporary, binary), installed);
    await chmod(installed, 0o755);
    const { stdout } = await execFileAsync(installed, ['version'], {
      windowsHide: true,
    });
    if (!stdout.includes(GITLEAKS_VERSION))
      throw new Error(
        `installed binary reports ${stdout.trim()}, expected ${GITLEAKS_VERSION}`,
      );
    console.log(`gitleaks ${GITLEAKS_VERSION} installed at ${installed}`);
    if (process.env.GITHUB_PATH)
      await appendFile(process.env.GITHUB_PATH, `${directory}\n`);
    const pathKey = Object.keys(process.env).find(
      (key) => key.toLowerCase() === 'path',
    );
    if (!(process.env[pathKey] ?? '').split(delimiter).includes(directory)) {
      console.log(
        `Add ${directory} to your PATH, or set GITLEAKS_INSTALL_DIR when committing.`,
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
