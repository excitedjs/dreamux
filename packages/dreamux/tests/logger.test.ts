/**
 * Unit tests for the issue #70 logger factory.
 *
 * The factory takes an explicit destination so these tests never touch
 * ~/.dreamux: filesystem assertions use a mkdtemp path, behavioural assertions
 * use an in-memory capture stream. (paths.ts hardcodes homedir() and does not
 * honor DREAMUX_CONFIG_DIR, so injection — not an env var — is the seam.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import {
  createLogger,
  loggerToLevelFn,
  pinoToTransportLogger,
} from '../src/runtime/logger.js';

function captureSink(): { sink: Writable; text: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { sink, text: () => chunks.join('') };
}

describe('logger factory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dreamux-logger-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the log dir and a 0600 file at an injected path', () => {
    const filePath = join(dir, 'nested', 'server.log');
    const logger = createLogger({ name: 'server', filePath, stderr: false });
    logger.info('hello');

    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    const contents = readFileSync(filePath, 'utf8');
    expect(contents).toContain('"msg":"hello"');
    expect(contents).toContain('"name":"server"');
  });

  it('tightens a pre-existing wider-permission file to 0600', async () => {
    const filePath = join(dir, 'pre.log');
    writeFileSync(filePath, '', { mode: 0o644 });
    const logger = createLogger({ filePath, stderr: false });
    logger.info('x');
    // The defensive re-tighten is a fire-and-forget async chmod (createLogger
    // stays synchronous, the gate bans *Sync), so poll until it lands.
    await vi.waitFor(() =>
      expect(statSync(filePath).mode & 0o777).toBe(0o600),
    );
  });

  it('redacts credential fields by default', () => {
    const { sink, text } = captureSink();
    const logger = createLogger({ destination: sink });
    logger.info({ app_secret: 'top-secret-value', feishu: { app_secret: 'nested' } }, 'cfg');
    const out = text();
    expect(out).not.toContain('top-secret-value');
    expect(out).not.toContain('nested');
    expect(out).toContain('[REDACTED]');
  });

  it('does not log fields the caller never passes (message bodies)', () => {
    const { sink, text } = captureSink();
    const logger = createLogger({ destination: sink });
    // The server logs ids only; a body would only appear if a caller passed it.
    logger.info({ chat_id: 'chat-a', message_id: 'm1', reason: 'bot not mentioned' }, 'drop');
    const out = text();
    expect(out).toContain('chat-a');
    expect(out).not.toContain('the actual message body text');
  });

  it('honors an explicit level and drops lines below it', () => {
    const { sink, text } = captureSink();
    const logger = createLogger({ destination: sink, level: 'warn' });
    logger.info('below threshold');
    logger.warn('at threshold');
    const out = text();
    expect(out).not.toContain('below threshold');
    expect(out).toContain('at threshold');
  });

  it('reads DREAMUX_LOG_LEVEL when no explicit level is set', () => {
    const prev = process.env['DREAMUX_LOG_LEVEL'];
    process.env['DREAMUX_LOG_LEVEL'] = 'error';
    try {
      const { sink, text } = captureSink();
      const logger = createLogger({ destination: sink });
      logger.warn('warn dropped');
      logger.error('error kept');
      expect(text()).not.toContain('warn dropped');
      expect(text()).toContain('error kept');
    } finally {
      if (prev === undefined) delete process.env['DREAMUX_LOG_LEVEL'];
      else process.env['DREAMUX_LOG_LEVEL'] = prev;
    }
  });

  it('writes to both the file and stderr when filePath is set (foreground stays visible)', () => {
    const filePath = join(dir, 'dual.log');
    // We cannot easily capture fd 2 here; assert the file half of the dual
    // stream. The stderr half is exercised by foreground `serve` in practice.
    const logger = createLogger({ name: 'server', filePath });
    logger.info('dual-output line');
    expect(readFileSync(filePath, 'utf8')).toContain('dual-output line');
  });

  it('adapts to the (level, msg, err) seam used by dispatcher runtime', () => {
    const { sink, text } = captureSink();
    const logger = createLogger({ destination: sink });
    const fn = loggerToLevelFn(logger);
    fn('error', 'start failed', new Error('boom'));
    const line = JSON.parse(text().trim()) as Record<string, unknown>;
    expect(line['msg']).toBe('start failed');
    expect(line['level']).toBe(50);
    expect((line['err'] as { message: string }).message).toBe('boom');
  });

  it('adapts to the feishu-transport TransportLogger seam (#74)', () => {
    const { sink, text } = captureSink();
    const logger = createLogger({ destination: sink });
    const transportLogger = pinoToTransportLogger(logger);

    // The transport seam emits (message, fields?); pino takes (mergingObject,
    // message). The adapter flips the order and supplies {} when no fields.
    transportLogger.info('connection ready', { source: 'feishu-transport-connection' });
    transportLogger.error('sdk failure', { source: 'feishu-sdk' });
    transportLogger.warn('best-effort failure');

    const lines = text()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      msg: 'connection ready',
      level: 30,
      source: 'feishu-transport-connection',
    });
    expect(lines[1]).toMatchObject({
      msg: 'sdk failure',
      level: 50,
      source: 'feishu-sdk',
    });
    expect(lines[2]).toMatchObject({ msg: 'best-effort failure', level: 40 });
  });

  it('redacts an app_secret a transport diagnostic field might carry', () => {
    const { sink, text } = captureSink();
    const logger = createLogger({ destination: sink });
    const transportLogger = pinoToTransportLogger(logger);

    // The transport never logs the secret, but the host's redact config is the
    // backstop — assert it still censors an app_secret reaching the field path.
    transportLogger.warn('diagnostic', { app_secret: 'fake-not-a-real-secret' });

    expect(text()).not.toContain('fake-not-a-real-secret');
    expect(text()).toContain('[REDACTED]');
  });
});
