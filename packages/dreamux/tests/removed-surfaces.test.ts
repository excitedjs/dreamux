/**
 * Negative-surface regression guards (minimize-provider-boundaries §7
 * "Negative surface tests ... prove deleted methods, callbacks, events, Core
 * Collaboration Space Commands/types, aliases, and binding stores cannot be
 * imported or loaded").
 *
 * Every check here scans COMMENT-STRIPPED source: a docstring explaining why a
 * surface was removed (there are several in this repo) legitimately names the
 * old identifier in prose, and a raw-text grep would false-positive on exactly
 * the kind of comment this repo's CLAUDE.md asks authors to write. Stripping
 * comments first makes "the identifier is absent from CODE" the actual
 * assertion, matching the deleted-surfaces contract.
 *
 * Structural (interface-shape) checks are used instead of a bare-token scan
 * wherever the token is a short/common word that has a legitimate, unrelated,
 * CURRENT meaning elsewhere (`providerRef` as an error-constructor parameter,
 * `getCapabilities()` on the Provider or on Core's own TeammateService,
 * `outbox` as a COT presentation buffer). A bare grep for those would either
 * miss the real contract or drown in false positives; this file was written
 * only after confirming which shape those tokens legitimately take today.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { LegacyStateError } from '../src/service/legacy-state.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const dreamuxSrc = join(repoRoot, 'packages/dreamux/src');
const typesSrc = join(repoRoot, 'packages/dreamux-types/src');

interface RushProject {
  packageName: string;
  projectFolder: string;
}

function rushProjects(): RushProject[] {
  const raw = readFileSync(join(repoRoot, 'rush.json'), 'utf8');
  const re = /"packageName":\s*"([^"]+)"[\s\S]*?"projectFolder":\s*"([^"]+)"/g;
  const out: RushProject[] = [];
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    out.push({ packageName: m[1]!, projectFolder: m[2]! });
  }
  return out;
}

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

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every file under each rush project's src tree, repo-relative. */
const allPackageFiles = rushProjects().flatMap((p) =>
  walkTs(join(repoRoot, p.projectFolder, 'src')),
);

function relRepo(file: string): string {
  return relative(repoRoot, file);
}

describe('deleted files stay deleted', () => {
  it.each([
    'packages/dreamux/src/service/channel-service/channel-sessions.ts',
    'packages/dreamux/src/service/team-collection/dissolve-controller.ts',
    'packages/dreamux/src/service/team-collection/dissolve-lifecycle.ts',
    'packages/dreamux/src/service/team-collection/dissolve-runner.ts',
    'packages/dreamux/src/service/team-service/delivery-result.ts',
  ])('%s does not exist', (relativePath) => {
    expect(existsSync(join(repoRoot, relativePath))).toBe(false);
  });
});

describe('deleted identifiers stay absent from every package src (comment-stripped)', () => {
  // Each token here was checked to have NO legitimate current meaning
  // anywhere in packages/*/src before being added — see the file header. A
  // token whose bare form has a live, unrelated meaning (providerRef,
  // getCapabilities, outbox, resume, scope) is intentionally excluded from
  // this list and covered by a structural check below instead.
  const bannedTokens = [
    'waitIdle',
    'channelInput',
    'getCheckpoint',
    'wasCheckpointResumed',
    'readTranscript',
    'ChannelRoutes',
    'resolveTarget',
    'resolveInboundBinding',
    'messageBelongsToTarget',
    'binding_fallbacks',
    'ChannelOrigin',
    'turnOrigin',
    'displaySubmission',
    'name-claim.json',
    'team-create-requests.json',
    'team_member',
    'structuredOutput',
    'completionInput',
  ];

  it.each(bannedTokens)('%s does not appear in any package src', (token) => {
    const offenders = allPackageFiles.filter((file) =>
      stripComments(readFileSync(file, 'utf8')).includes(token),
    );
    expect(offenders.map(relRepo)).toEqual([]);
  });

  it('"binding.route" never appears as an emitted event kind', () => {
    // Narrower than a bare-token ban: "route" and "binding" are both common
    // words with legitimate unrelated uses (Feishu routing IS a real, kept
    // domain). What must stay absent specifically is the deleted event kind
    // literal.
    const offenders = allPackageFiles.filter((file) =>
      /['"]binding\.route['"]/.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map(relRepo)).toEqual([]);
  });

  it('"dispatcher.stop" is not called as a live method', () => {
    const offenders = allPackageFiles.filter((file) =>
      /\bdispatcher\.stop\(/.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map(relRepo)).toEqual([]);
  });

  it('Team-name tombstones do not exist (no "tombstone" vocabulary in team-collection)', () => {
    const files = walkTs(join(dreamuxSrc, 'service/team-collection'));
    const offenders = files.filter((file) =>
      /tombstone/i.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map(relRepo)).toEqual([]);
  });

  it('the Feishu provisioning/routing surface carries no saga/phase/outbox/recovery-cursor/restart-resume-scan vocabulary', () => {
    // Scoped to the routing/provisioning files specifically: "outbox" is a
    // legitimate, unrelated, CURRENT in-memory COT presentation buffer
    // elsewhere in this same package (feishu-cot-outbox.ts), so a package-wide
    // ban would false-positive. This checks the persisted provisioning surface
    // only, which is what the deleted-surfaces item actually names.
    const feishuChannelSrc = join(repoRoot, 'packages/channel/feishu-channel/src');
    const files = [
      ...walkTs(join(feishuChannelSrc, 'routing')),
      join(feishuChannelSrc, 'feishu-gate.ts'),
      join(feishuChannelSrc, 'feishu-session-bindings.ts'),
      join(feishuChannelSrc, 'feishu-target-router.ts'),
    ].filter((f) => existsSync(f));
    expect(files.length).toBeGreaterThan(0);
    const pattern = /\bsaga\b|\bphase\b|\boutbox\b|recovery_cursor|recoveryCursor|restart.?resume.?scan/i;
    const offenders = files.filter((file) =>
      pattern.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map(relRepo)).toEqual([]);
  });
});

describe('the Core Collaboration Space domain is fully absent', () => {
  // Scoped to Core (packages/dreamux/src) only: Feishu now legitimately OWNS
  // its own "Collaboration Space" concept end to end (bind_collaboration_space
  // / get_collaboration_space / list_collaboration_spaces are current, kept
  // Feishu channel tools — see minimize-provider-boundaries §7 "Feishu
  // Collaboration Space tests ... absence of Core Collaboration Space state,
  // Commands, events, or types"). What must be gone is CORE's own copy of
  // this domain, not the word itself repo-wide.
  const coreFiles = walkTs(dreamuxSrc);

  it('no collaboration-space service/state/config/types/MCP/admin module exists under packages/dreamux/src', () => {
    const offenders = coreFiles.filter((file) =>
      /collaboration.?space/i.test(relRepo(file)),
    );
    expect(offenders.map(relRepo)).toEqual([]);
  });

  it('no Core source file references a CollaborationSpace type or command', () => {
    const pattern = /CollaborationSpace|collaboration_space/;
    const offenders = coreFiles.filter((file) =>
      pattern.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map(relRepo)).toEqual([]);
  });

  it('Feishu keeps its own Collaboration Space MCP tools (not a false positive of the Core-domain ban)', () => {
    const spaceTools = readFileSync(
      join(repoRoot, 'packages/channel/feishu-channel/src/tools/space-tools.ts'),
      'utf8',
    );
    expect(spaceTools).toContain("name: 'bind_collaboration_space'");
    expect(spaceTools).toContain("name: 'list_collaboration_spaces'");
  });
});

describe('deleted Team MCP tool names stay absent (Feishu channel tools are a different, kept domain)', () => {
  it('no Team or TeamMate Command/tool is literally named team.bind_channel or team.transfer_back', () => {
    const pattern = /['"]team\.(bind_channel|transfer_back)['"]/;
    const offenders = allPackageFiles.filter((file) =>
      pattern.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map(relRepo)).toEqual([]);
  });

  it('no tool/command is literally named channel.invoke_tool, channel.mcp.describe, or channel.mcp.invoke', () => {
    const pattern = /['"]channel\.(invoke_tool|mcp\.describe|mcp\.invoke)['"]/;
    const offenders = allPackageFiles.filter((file) =>
      pattern.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map(relRepo)).toEqual([]);
  });

  it('no internal Command/tool is literally named team.send or teammate.send', () => {
    // The CURRENT Team/TeamMate MCP tool for this operation is named "send"
    // (registered under the "team" / "teammate" MCP servers respectively --
    // see service/team-collection/mcp-delegate.ts and
    // service/teammate-collection/mcp-delegate.ts); the admin.sock Command is
    // "team.submit" for Team. What must stay absent is an internal identifier
    // literally spelled "team.send" / "teammate.send" (the deleted dotted
    // Command/tool name), not the unqualified "send" tool name or prose
    // describing how a model addresses a namespaced MCP tool.
    const pattern = /name:\s*['"]team\.send['"]|name:\s*['"]teammate\.send['"]/;
    const offenders = allPackageFiles.filter((file) =>
      pattern.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map(relRepo)).toEqual([]);
  });

  it('the current Team Command name set has team.submit, not team.send', () => {
    // Positive companion to the negative check above: pins the CURRENT name
    // the deleted "team.send" was replaced by, so the negative check cannot
    // pass merely because nobody registers Team commands at all.
    const src = readFileSync(
      join(dreamuxSrc, 'service/team-collection/commands.ts'),
      'utf8',
    );
    expect(src).toContain("name: 'team.submit'");
    expect(src).not.toContain("name: 'team.send'");
  });

  it('bind_channel / unbind_channel / list_bindings remain legitimate Feishu CHANNEL tools (not a false positive of the Team-tool ban)', () => {
    const feishuTools = readFileSync(
      join(repoRoot, 'packages/channel/feishu-channel/src/tools/routing-tools.ts'),
      'utf8',
    );
    expect(feishuTools).toContain("name: 'bind_channel'");
    expect(feishuTools).toContain("name: 'unbind_channel'");
  });
});

describe('persisted Agent identity carries no removed field (role, checkpoint, transcript_locator, ...)', () => {
  it('the identity-store removed-field rejection list still names every field the deleted-surfaces contract retired', () => {
    // Companion pin to the behavioral test below: this asserts the exact
    // removed-field list assertNoRemovedRecordFields enforces still covers the
    // persisted-identity items this node is responsible for (role,
    // transcript_locator, session_ref, session_id, checkpoint,
    // checkpoint_kind). A shrinking list here would silently let a deleted
    // field become readable again — but a string-contains pin alone would
    // still pass if `read()` stopped INVOKING the check entirely, which is
    // why the behavioral test exercises the real call path.
    const src = readFileSync(
      join(dreamuxSrc, 'service/agent-entity/identity-store.ts'),
      'utf8',
    );
    for (const removedField of [
      'checkpoint',
      'checkpoint_kind',
      'session_ref',
      'session_id',
      'transcript_locator',
      'display_name',
      'close_status',
      'role',
    ]) {
      expect(src).toContain(`'${removedField}'`);
    }
  });

  const noopLog = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  };

  let identityDir: string;

  beforeEach(() => {
    identityDir = mkdtempSync(join(tmpdir(), 'dreamux-identity-legacy-'));
  });

  afterEach(() => {
    rmSync(identityDir, { recursive: true, force: true });
  });

  it('AgentIdentityStore.read() fails loud with LegacyStateError on a persisted "role" field (behavioral, not just a shape pin)', async () => {
    await writeFile(
      join(identityDir, 'identity.json'),
      JSON.stringify({
        version: 1,
        dispatcher_id: 'dispatcher-1',
        name: 'leader',
        agent_runtime: 'codex',
        cwd: identityDir,
        source_cwd: identityDir,
        runtime_cwd: identityDir,
        created_at: 1,
        updated_at: 1,
        skill_sources: [],
        // The removed field under test: a pre-#148 record that still names a
        // runtime "role" directly on the persisted identity.
        role: 'leader',
      }),
      'utf8',
    );
    const store = new AgentIdentityStore({
      dir: identityDir,
      dispatcherId: 'dispatcher-1',
      expectedName: 'leader',
      log: noopLog,
    });
    await expect(store.read()).rejects.toBeInstanceOf(LegacyStateError);
  });
});

describe('neutral contract shapes stay minimal (structural, not bare-token — see file header)', () => {
  const agentRuntimeSrc = readFileSync(join(typesSrc, 'agent-runtime.ts'), 'utf8');
  const channelSrc = readFileSync(join(typesSrc, 'channel.ts'), 'utf8');

  function interfaceBody(src: string, name: string): string {
    const start = src.indexOf(`export interface ${name} {`);
    expect(start, `interface ${name} present`).toBeGreaterThanOrEqual(0);
    const openBrace = src.indexOf('{', start);
    let depth = 0;
    for (let i = openBrace; i < src.length; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}') {
        depth--;
        if (depth === 0) return src.slice(openBrace + 1, i);
      }
    }
    throw new Error(`unterminated interface ${name}`);
  }

  it('AgentRuntime (the live handle) exposes exactly start/submit/stop — no waitIdle, resume, getStatus, getCheckpoint, getContext, getCapabilities, or providerRef', () => {
    const body = stripComments(interfaceBody(agentRuntimeSrc, 'AgentRuntime'));
    const methodNames = [...body.matchAll(/^\s*([a-zA-Z]+)\(/gm)].map((m) => m[1]);
    expect(methodNames.sort()).toEqual(['start', 'stop', 'submit']);
    expect(body).not.toMatch(/\bproviderRef\b/);
  });

  it('AgentRuntimeSubmissionInput carries only prepared text — no source identity, scope, reopenClosed, AbortSignal, or logging labels', () => {
    const body = stripComments(
      interfaceBody(agentRuntimeSrc, 'AgentRuntimeSubmissionInput'),
    );
    const propertyNames = [...body.matchAll(/readonly\s+([a-zA-Z]+)\s*:/g)].map(
      (m) => m[1],
    );
    expect(propertyNames).toEqual(['text']);
  });

  it('RuntimeCompletion has no displaySubmission member', () => {
    const start = agentRuntimeSrc.indexOf('export type RuntimeCompletion =');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = agentRuntimeSrc.indexOf('\n\nexport', start + 1);
    const block = agentRuntimeSrc.slice(start, end === -1 ? undefined : end);
    expect(block).not.toMatch(/displaySubmission/);
  });

  it('ChannelSession exposes exactly initialize/start/close — no reply or react', () => {
    const body = stripComments(interfaceBody(channelSrc, 'ChannelSession'));
    const methodNames = [...body.matchAll(/^\s*([a-zA-Z]+)\(/gm)].map((m) => m[1]);
    expect(methodNames.sort()).toEqual(['close', 'initialize', 'start']);
    expect(body).not.toMatch(/\breply\b|\breact\b/);
  });
});
