import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeEmptyLogFile } from '@excitedjs/dreamux-utils';
import { createLogger } from '../src/platform/logger.js';

/**
 * Empty child-log cleanup (issue #182 logs stage): supervisors call
 * `removeEmptyLogFile` on a child's stdout/stderr log after the child exits, so
 * a clean run that produced no output leaves no zero-byte file behind, while any
 * file that captured output is kept.
 */
describe('removeEmptyLogFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dreamux-log-hygiene-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes a zero-byte log file', async () => {
    const path = join(dir, 'child.stderr.log');
    await writeFile(path, '');
    await removeEmptyLogFile(path);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a log file that captured output', async () => {
    const path = join(dir, 'child.stderr.log');
    await writeFile(path, 'panic: something went wrong\n');
    await removeEmptyLogFile(path);
    expect(await readFile(path, 'utf8')).toBe('panic: something went wrong\n');
  });

  it('is a no-op (never throws) when the file does not exist', async () => {
    await expect(
      removeEmptyLogFile(join(dir, 'never-created.log')),
    ).resolves.toBeUndefined();
  });
});

/**
 * Architecture guard: no secret, token, app_secret, or real Feishu id shape
 * may reach a persisted log line (issue #70 logger factory; repo CLAUDE.md
 * public-repo red line). `logger.test.ts` already pins the KEY-based
 * redaction mechanism itself (createLogger's `redactLogValue`); this file
 * covers the complementary gap that mechanism cannot close on its own:
 * redaction only inspects OBJECT KEYS in the fields argument, so a call site
 * that string-interpolates a secret straight into the MESSAGE argument would
 * defeat it entirely (pino has no way to redact inside a plain string). That
 * is a call-site discipline problem, not a redaction-config problem, so it
 * needs a source-shape guard alongside the behavioral redaction test.
 */
const here = dirname(fileURLToPath(import.meta.url));
const packagesRoot = join(here, '..', '..');

function walkTs(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function captureSink(): { sink: Writable; lines: () => unknown[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    sink,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l)),
  };
}

describe('log call sites never bypass key-based redaction with a dynamic message', () => {
  // Every package that takes a `DreamuxLogger` (core plus every provider
  // package built against it) is in scope, not just core: the redaction
  // mechanism and the "no dynamic message" discipline are the same call-site
  // contract wherever a DreamuxLogger is used, and a provider package logging
  // a secret via string interpolation would defeat redaction exactly as
  // easily as core doing it.
  const scannedPackageSrcDirs = [
    'dreamux/src',
    'agent-runtime/codex/src',
    'agent-runtime/claude-code/src',
    'channel/feishu-channel/src',
    'channel/feishu-transport/src',
  ];
  const scannedFiles = scannedPackageSrcDirs.flatMap((rel) =>
    walkTs(join(packagesRoot, rel)),
  );
  const relPackages = (f: string) => f.slice(packagesRoot.length + 1);

  it('no .info/.warn/.error/.debug/.trace( call anywhere in core or a provider package takes a template-literal message with interpolation', () => {
    // `logger.info(\`token=${x}\`)` is a message-first call: pino stores it
    // verbatim as `msg`, and `redactLogValue` (which only walks the FIELDS
    // object formatter sees) never touches it. Banning dynamic interpolation
    // in the message position closes that hole structurally rather than
    // trusting every call site to remember it.
    //
    // Scoped away from `console.*`: the CLI's `console.error(...)` calls are
    // direct operator-facing stderr text, a different mechanism than the
    // redaction-bearing DreamuxLogger this guard protects, and dynamic
    // interpolation there is normal, expected CLI UX (e.g. "unknown command:
    // ${verb}"). The `(?<!console)` lookbehind excludes exactly that receiver
    // without needing to know every logger variable's name. Comments are
    // stripped first so a docstring example is never mistaken for a real call
    // site.
    const pattern = /(?<!console)\.(info|warn|error|debug|trace)\(\s*`[^`]*\$\{/;
    const offenders = scannedFiles.filter((file) =>
      pattern.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map((f) => relPackages(f))).toEqual([]);
  });

  it('no .info/.warn/.error/.debug/.trace( call in core or a provider package builds its message by string-concatenating a variable', () => {
    const pattern = /(?<!console)\.(info|warn|error|debug|trace)\(\s*['"][^'"]*['"]\s*\+/;
    const offenders = scannedFiles.filter((file) =>
      pattern.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map((f) => relPackages(f))).toEqual([]);
  });

  it('no real Feishu id shape (oc_/om_/ou_/cli_ + a long hex body) is hardcoded anywhere in core or a provider package', () => {
    // Doubles as the repo's public-repo red line (root CLAUDE.md "never
    // commit ... real Feishu ids/tokens") scoped to what this node owns.
    // Placeholder ids used in fixtures/docs are short/obviously synthetic and
    // do not match a real SDK id's length.
    const realFeishuIdShape = /\b(oc|om|ou|cli)_[a-f0-9]{20,}\b/;
    const offenders = scannedFiles.filter((file) =>
      realFeishuIdShape.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map((f) => relPackages(f))).toEqual([]);
  });
});

describe('createLogger redacts an app_secret / token reaching a log field (behavioral companion)', () => {
  it('redacts app_secret and does not leak the raw value into the captured log line', () => {
    const { sink, lines } = captureSink();
    const logger = createLogger({ destination: sink });
    logger.info(
      { app_secret: 'real-not-a-placeholder-secret', token: 'bearer-xyz' },
      'onboard captured provider config',
    );
    const [line] = lines() as [Record<string, unknown>];
    expect(line['app_secret']).toBe('[REDACTED]');
    expect(line['token']).toBe('[REDACTED]');
    expect(JSON.stringify(line)).not.toContain('real-not-a-placeholder-secret');
    expect(JSON.stringify(line)).not.toContain('bearer-xyz');
  });

  it('does not redact a plain Feishu id field (ids are logged by design; only secret-shaped keys are censored)', () => {
    // Positive companion to the negative check above: proves the redaction
    // seam is key-name-scoped, not a blanket string scrub, so the structural
    // "no dynamic message" guard above is doing real, distinct work rather
    // than being redundant with this behavioral mechanism.
    const { sink, lines } = captureSink();
    const logger = createLogger({ destination: sink });
    logger.info({ chat_id: 'oc_placeholder_chat_id' }, 'inbound routed');
    const [line] = lines() as [Record<string, unknown>];
    expect(line['chat_id']).toBe('oc_placeholder_chat_id');
  });
});
