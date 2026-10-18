import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageJsonUrl = new URL('../package.json', import.meta.url);
const packageRoot = dirname(fileURLToPath(packageJsonUrl));
const bin = join(packageRoot, 'bin', 'dreamux');
const manifest = JSON.parse(await readFile(packageJsonUrl, 'utf8'));

const serverModule = await import(
  pathToFileURL(join(packageRoot, 'dist', 'server.js')).href
);
if (typeof serverModule.Server !== 'function') {
  throw new Error('dreamux built package main does not export Server');
}

async function runCli(args) {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: parse(packageRoot).root,
    env: {
      ...process.env,
      DREAMUX_NODE_BIN: process.execPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, exitSignal) =>
      resolve({ code: exitCode, signal: exitSignal }),
    );
  });
  return { code, signal, stdout, stderr };
}

function describeResult(result) {
  return `code=${result.code} signal=${result.signal ?? 'none'} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`;
}

function requireSuccessful(result, label) {
  if (result.signal !== null || result.code !== 0) {
    throw new Error(`${label} failed: ${describeResult(result)}`);
  }
}

const versionResult = await runCli(['--version']);
requireSuccessful(versionResult, 'dreamux --version');
const version = versionResult.stdout.trim();
if (version !== manifest.version) {
  throw new Error(
    `dreamux built CLI version does not match package.json (${manifest.version}): ${describeResult(versionResult)}`,
  );
}

console.log(`dreamux built package/CLI smoke ok: ${version}`);
