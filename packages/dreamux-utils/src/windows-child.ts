import { fork, type ChildProcess, type StdioOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { prepareCommand } from './process-command.js';
import type { SupervisedChildLaunch } from './supervised-child.js';
import { WindowsJob } from './windows-job.js';

// This controlled Node entry executes no user preload or target code until the
// host has assigned its verified process handle to the Job. Once started, IPC
// carries the target's ordinary messages without a second control protocol.
const bootstrap = `
const { spawn, fork } = require('node:child_process');
let target;
let forwarded = Promise.resolve();
process.on('disconnect', () => {
  if (!target) process.exit(1);
  else if (target.connected) target.disconnect();
});
process.once('message', ({ challenge }) => {
  process.send({ challenge });
  process.once('message', ({ launch }) => {
    const options = { ...launch.options, detached: false, windowsHide: true };
    target = launch.kind === 'fork'
      ? fork(launch.modulePath, launch.args, options)
      : spawn(launch.command, launch.args, options);
    target.once('spawn', () => {
      process.send({ started: true });
      process.on('message', (message, handle) => {
        if (target.connected) target.send(message, handle);
      });
    });
    target.on('message', (message, handle) => {
      if (process.connected) {
        // IPC writes complete in order. The last callback fences every earlier
        // forwarded message, including a terminal result under backpressure.
        forwarded = new Promise(resolve => process.send(message, handle, error => {
          if (error) process.exit(1);
          resolve();
        }));
      }
    });
    target.once('error', (error) => {
      if (process.connected) process.send({ error: { message: error.message, code: error.code } }, () => process.exit(1));
      else process.exit(1);
    });
    target.once('close', (code) => {
      void forwarded.then(() => process.exit(code ?? 1));
    });
    target.once('disconnect', () => {
      void forwarded.then(() => { if (process.connected) process.disconnect(); });
    });
  });
});
process.send({ ready: true });
`;

type ControlMessage = {
  ready?: boolean;
  challenge?: string;
  started?: boolean;
  error?: { message: string; code?: string };
};

function exchange(
  child: ChildProcess,
  accepts: (message: ControlMessage) => boolean,
  send?: object,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('disconnect', onExit);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (): void =>
      onError(new Error('Windows child exited before launch completed'));
    const onMessage = (message: ControlMessage): void => {
      if (message.error !== undefined) {
        onError(
          Object.assign(new Error(message.error.message), {
            code: message.error.code,
          }),
        );
      } else if (accepts(message)) {
        cleanup();
        resolve();
      }
    };
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('disconnect', onExit);
    if (send !== undefined)
      child.send(send, (error) => {
        if (error !== null) onError(error);
      });
  });
}

function childStdio(launch: SupervisedChildLaunch): StdioOptions {
  const stdio =
    launch.options?.stdio ??
    (launch.kind === 'fork' && !launch.options?.silent ? 'inherit' : 'pipe');
  return typeof stdio === 'string' ? [stdio, stdio, stdio] : [...stdio];
}

export async function launchWindowsChild(
  launch: SupervisedChildLaunch,
): Promise<{ child: ChildProcess; job: WindowsJob }> {
  const stdio = childStdio(launch) as Exclude<StdioOptions, string>;
  const targetStdio = stdio.map((value, index) =>
    value === 'ipc' ? 'ipc' : index,
  );
  const ipcIndex = stdio.indexOf('ipc');
  if (ipcIndex !== -1) stdio.splice(ipcIndex, 1, 'ignore');
  stdio.push('ipc');
  if (launch.kind === 'fork' && !targetStdio.includes('ipc'))
    targetStdio.push('ipc');
  const env = launch.options?.env ?? process.env;
  const wrapperEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== 'NODE_OPTIONS'),
  );
  const options = {
    ...launch.options,
    cwd:
      launch.options?.cwd instanceof URL
        ? fileURLToPath(launch.options.cwd)
        : launch.options?.cwd,
    stdio: targetStdio,
    env,
  };
  const prepared =
    launch.kind === 'spawn'
      ? {
          kind: 'spawn',
          ...(await prepareCommand(launch.command, launch.args, options)),
        }
      : {
          ...launch,
          args: [...(launch.args ?? [])],
          options: {
            ...options,
            execArgv: launch.options?.execArgv ?? process.execArgv,
          },
        };
  const job = await WindowsJob.create();
  let child: ChildProcess | undefined;
  try {
    const wrapperOptions = {
      execPath: process.execPath,
      execArgv: ['-e', bootstrap],
      env: wrapperEnv,
      stdio,
      windowsHide: true,
      serialization:
        launch.kind === 'fork'
          ? (launch.options?.serialization ?? 'json')
          : ('json' as const),
    };
    child = fork('', [], wrapperOptions);
    await exchange(child, (message) => message.ready === true);
    if (child.pid === undefined) throw new Error('Windows child has no PID');
    await job.openRoot(child.pid);
    // Holding a handle prevents PID reuse. A fresh response on the original
    // ChildProcess IPC proves that the held object is that same live child,
    // even if the original PID disappeared before OpenProcess ran.
    const challenge = randomUUID();
    await exchange(child, (message) => message.challenge === challenge, {
      challenge,
    });
    await job.assign();
    await exchange(child, (message) => message.started === true, {
      launch: prepared,
    });
    return { child, job };
  } catch (error) {
    // Before assignment this disconnect exits only our controlled bootstrap;
    // after assignment the Job is the sole termination authority.
    if (child?.connected) child.disconnect();
    try {
      await job.terminate();
    } finally {
      job.close();
    }
    throw error;
  }
}
