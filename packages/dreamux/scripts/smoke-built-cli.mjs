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
  'ChannelToolAuthorizationError',
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

const child = spawn(bin, ['--version'], {
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

child.once('error', (err) => {
  console.error(`dreamux built CLI smoke failed to start: ${err.message}`);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`dreamux built CLI smoke terminated by ${signal}`);
    if (stderr.trim() !== '') console.error(stderr.trim());
    process.exit(1);
  }
  if (code !== 0) {
    console.error(`dreamux built CLI smoke exited with code ${code}`);
    if (stdout.trim() !== '') console.error(`stdout:\n${stdout.trim()}`);
    if (stderr.trim() !== '') console.error(`stderr:\n${stderr.trim()}`);
    process.exit(code ?? 1);
  }
  const version = stdout.trim();
  if (version === '') {
    console.error('dreamux built CLI smoke produced empty --version output');
    if (stderr.trim() !== '') console.error(`stderr:\n${stderr.trim()}`);
    process.exit(1);
  }
  console.log(`dreamux built package/service/CLI smoke ok: ${version}`);
});
