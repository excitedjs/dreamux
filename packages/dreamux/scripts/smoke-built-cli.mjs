import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageJsonUrl = new URL('../package.json', import.meta.url);
const packageRoot = dirname(fileURLToPath(packageJsonUrl));
const bin = join(packageRoot, 'bin', 'dreamux');

const serverModule = await import(
  pathToFileURL(join(packageRoot, 'dist', 'server.js')).href
);
if (typeof serverModule.Server !== 'function') {
  throw new Error('dreamux built package main does not export Server');
}

const serviceModule = await import(
  pathToFileURL(join(packageRoot, 'dist', 'service', 'index.js')).href
);
const expectedServiceExports = [
  'DispatcherService',
  'Dispatchers',
  'TeamService',
  'WorkflowService',
];
const actualServiceExports = Object.keys(serviceModule).sort();
if (
  actualServiceExports.length !== expectedServiceExports.length ||
  actualServiceExports.some(
    (name, index) => name !== expectedServiceExports[index],
  )
) {
  throw new Error(
    `dreamux built service facade exports ${JSON.stringify(actualServiceExports)}`,
  );
}
for (const name of expectedServiceExports) {
  if (typeof serviceModule[name] !== 'function') {
    throw new Error(`dreamux built service facade export ${name} is not a value`);
  }
}

async function runCli(args) {
  const child = spawn(bin, args, {
    env: {
      ...process.env,
      DREAMUX_NODE_BIN: process.execPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
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
if (version === '') {
  throw new Error(
    `dreamux built CLI produced empty --version output: ${describeResult(versionResult)}`,
  );
}

console.log(`dreamux built package/service/CLI smoke ok: ${version}`);
