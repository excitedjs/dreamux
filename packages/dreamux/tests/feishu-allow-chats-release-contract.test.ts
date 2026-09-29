import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const marker =
  'before deploying, inspect every existing non-empty group.allow_chats';

interface ChangeDeclaration {
  changes: Array<{ packageName: string; comment: string; type: string }>;
  packageName: string;
}

function pendingChange(relativePath: string): ChangeDeclaration | null {
  const path = join(repoRoot, relativePath);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as ChangeDeclaration)
    : null;
}

function publishedChange(
  relativePath: string,
  packageName: string,
): ChangeDeclaration['changes'][number] | null {
  const raw = JSON.parse(
    readFileSync(join(repoRoot, relativePath), 'utf8'),
  ) as {
    entries: Array<{ comments: Record<string, Array<{ comment: string }>> }>;
  };
  for (const entry of raw.entries) {
    for (const [type, comments] of Object.entries(entry.comments)) {
      const match = comments.find((candidate) =>
        candidate.comment.includes(marker),
      );
      if (match !== undefined)
        return { packageName, type, comment: match.comment };
    }
  }
  return null;
}

function currentOrPublishedChange(input: {
  pending: string;
  changelog: string;
  packageName: string;
}): ChangeDeclaration['changes'][number] {
  const pending = pendingChange(input.pending);
  const change =
    pending?.changes[0] ?? publishedChange(input.changelog, input.packageName);
  expect(
    change,
    `${input.packageName} trusted-chat change declaration`,
  ).not.toBeNull();
  return change!;
}

describe('trusted allow_chats release contract', () => {
  it.each([
    {
      packageName: '@excitedjs/feishu-channel',
      type: 'major',
      pending:
        'common/changes/@excitedjs/feishu-channel/feishu-trusted-allow-chats_2026-07-31-15-22.json',
      changelog: 'packages/channel/feishu-channel/CHANGELOG.json',
    },
    {
      packageName: '@excitedjs/dreamux',
      type: 'minor',
      pending:
        'common/changes/@excitedjs/dreamux/feishu-trusted-allow-chats_2026-07-31-15-22.json',
      changelog: 'packages/dreamux/CHANGELOG.json',
    },
  ])('$packageName declares the required breaking release note', (input) => {
    const change = currentOrPublishedChange(input);
    expect(change.packageName).toBe(input.packageName);
    expect(change.type).toBe(input.type);
    expect(change.comment).toMatch(/^BREAKING: Review:/);
    expect(change.comment).toContain('group.policy=allowlist');
    expect(change.comment).toContain('group.policy=follow-user');
    expect(change.comment).toContain(
      'Previously, follow-user ignored allow_chats',
    );
    expect(change.comment).toContain(
      'allowlist still applied dm_policy and allow_users',
    );
    expect(change.comment).toContain(
      'access.json remains V3 and needs no rebuild',
    );
    expect(change.comment).not.toContain('Rebuild:');
  });

  it('publishes both old-to-new authorization expansions and the V3 review warning', () => {
    const feishuReadme = readFileSync(
      join(repoRoot, 'packages/channel/feishu-channel/README.md'),
      'utf8',
    );
    const dreamuxReadme = readFileSync(
      join(repoRoot, 'packages/dreamux/README.md'),
      'utf8',
    );
    const domain = readFileSync(
      join(repoRoot, '.agents/domains/feishu-pairing-access.md'),
      'utf8',
    );
    for (const text of [feishuReadme, dreamuxReadme, domain]) {
      expect(text).toMatch(/version 3|V3/);
      expect(text).toMatch(/needs no rebuild|no rebuild/);
      expect(text).toMatch(/review every non-empty[\s\S]{0,100}allow_chats/i);
      expect(text).toMatch(/allowlist/);
      expect(text).toMatch(/follow-user/);
      expect(text).toMatch(/human membership/);
      expect(text).toMatch(/passive known-bot observation/);
    }
    expect(domain).toMatch(
      /retained `follow-user` `allow_chats` entry[\s\S]{0,180}ignored/,
    );
    expect(domain).toMatch(
      /retained `allowlist` entry[\s\S]{0,180}`dm_policy`/,
    );
    expect(feishuReadme).toMatch(/exact[\s\S]{0,220}is_bot_sender: false/);
    expect(feishuReadme).not.toContain('sender_kind` input');
  });

  it('documents every built-in Codex field and the parsed-but-unused timeout', () => {
    const readme = readFileSync(
      join(repoRoot, 'packages/dreamux/README.md'),
      'utf8',
    );
    const start = readme.indexOf('For `builtin:codex`, every config field');
    const end = readme.indexOf('Claude Code agents use a different', start);
    const codex = readme.slice(start, end);
    for (const field of [
      'bin',
      'approval_policy',
      'sandbox_mode',
      'extra_args',
      'extra_env',
      'initialize_timeout_ms',
      'turn_timeout_ms',
    ]) {
      expect(codex).toContain(`\`${field}\``);
    }
    expect(codex).toContain('`600000`');
    expect(codex).toMatch(/not passed into `CodexRuntime`/);
    expect(codex).toMatch(/currently has no runtime effect/);
  });

  it('locks the root maintenance synchronization and release-policy carve-out', () => {
    const rootRules = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
    const stateDomain = readFileSync(
      join(repoRoot, '.agents/domains/state-config-and-files.md'),
      'utf8',
    );
    const releaseDomain = readFileSync(
      join(repoRoot, '.agents/domains/repository-operations-and-release.md'),
      'utf8',
    );
    expect(rootRules).toMatch(
      /every change to the shape,[\s\S]{0,180}ownership, or meaning/,
    );
    expect(rootRules).toContain(
      '/packages/dreamux/skills/dispatcher/dreamux-maintenance/',
    );
    expect(rootRules).toMatch(/single owning reference/);
    expect(rootRules).toContain('references/self-upgrade.md');
    expect(rootRules).toMatch(/current-state-only/);
    // `BREAKING:` is upgrade-blocking migration only. The superseded
    // "same-shape semantic change carries BREAKING: + Review:" category must
    // stay deleted from the rule docs; published CHANGELOGs keep their
    // historical `BREAKING: Review:` notes and are asserted separately above.
    for (const rules of [rootRules, stateDomain, releaseDomain]) {
      expect(rules).toMatch(
        /incompatible shape, version, or path[\s\S]{0,180}`Rebuild:`/i,
      );
      expect(rules).toMatch(/upgrade-blocking/);
      expect(rules).toContain('`BREAKING:`, `Rebuild:`, or `Review:`');
      expect(rules).not.toMatch(/same-shape/);
    }
  });
});
