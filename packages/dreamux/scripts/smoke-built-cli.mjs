import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageJsonUrl = new URL('../package.json', import.meta.url);
const packageRoot = dirname(fileURLToPath(packageJsonUrl));
const bin = join(packageRoot, 'bin', 'dreamux');

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
  console.log(`dreamux built CLI smoke ok: ${version}`);
});
