import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { authorEmailError } from './check-author-emails.mjs';

const execFileAsync = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, '..', '..');
const run = (command, args, options = {}) =>
  execFileAsync(command, args, { windowsHide: true, ...options });

test('repository Node entry points parse on the current platform', async () => {
  const paths = (await readdir(scripts))
    .filter((file) => file.endsWith('.mjs'))
    .map((file) => join(scripts, file));
  paths.push(
    join(root, 'common', 'git-hooks', 'pre-commit'),
    join(root, '.agents', 'scripts', 'check.mjs'),
  );
  for (const path of paths) await run(process.execPath, ['--check', path]);
});

test('clean removes only the current package dist and is repeatable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dreamux-clean-'));
  try {
    await mkdir(join(dir, 'dist', 'nested'), { recursive: true });
    await writeFile(join(dir, 'dist', 'nested', 'old.js'), 'obsolete');
    await writeFile(join(dir, 'source.ts'), 'preserve');
    await run(process.execPath, [join(scripts, 'clean.mjs')], { cwd: dir });
    await run(process.execPath, [join(scripts, 'clean.mjs')], { cwd: dir });
    assert.deepEqual(await readdir(dir), ['source.ts']);
    assert.equal(await readFile(join(dir, 'source.ts'), 'utf8'), 'preserve');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('author identity keeps local rejection and applies the denylist to every address', () => {
  assert.match(
    authorEmailError('fixture@users.noreply.github.com', '.*'),
    /denylist/i,
  );
  assert.equal(authorEmailError('fixture@users.noreply.github.com', ''), null);
  assert.equal(authorEmailError('fixture@example.com'), null);
  assert.match(authorEmailError('fixture'), /invalid/);
  assert.match(authorEmailError(''), /not set/);
  for (const address of [
    'fixture@localhost',
    'fixture@host.local',
    'fixture@local',
  ]) {
    assert.match(authorEmailError(address), /machine-local/);
  }
  assert.match(
    authorEmailError('fixture@sub.EXAMPLE.com', '@([^@]*\\.)?example\\.com$'),
    /denylist/i,
  );
});

test('normal Git commits execute the Node hook and cannot bypass either content gate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dreamux-hook-'));
  try {
    await run('git', ['init', '--quiet', dir]);
    await run('git', ['config', 'user.name', 'Fixture'], { cwd: dir });
    await run(
      'git',
      ['config', 'user.email', 'fixture@users.noreply.github.com'],
      { cwd: dir },
    );
    await run('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: dir });
    await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    await mkdir(join(dir, 'common', 'scripts'), { recursive: true });
    for (const file of [
      'pre-commit.mjs',
      'check-author-emails.mjs',
      'check-internal-content.mjs',
    ]) {
      await copyFile(join(scripts, file), join(dir, 'common', 'scripts', file));
    }
    const hook = join(dir, '.git', 'hooks', 'pre-commit');
    await copyFile(join(root, 'common', 'git-hooks', 'pre-commit'), hook);
    await chmod(hook, 0o755);
    const tools = join(dir, 'tools');
    await mkdir(tools);
    const executable = join(
      tools,
      process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks',
    );
    await copyFile(process.execPath, executable);
    await chmod(executable, 0o755);
    // The executable fixture runs Node's normal script argv, allowing inspection
    // of the external gitleaks boundary without requiring it in every test job.
    await writeFile(
      join(dir, 'git'),
      "require('node:fs').writeFileSync('gate-args.json', JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.DREAMUX_TEST_GATE_EXIT || 0));\n",
    );
    const pathKey =
      Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ??
      'PATH';
    const env = {
      ...process.env,
      [pathKey]: `${tools}${delimiter}${process.env[pathKey] ?? ''}`,
      GITLEAKS_INSTALL_DIR: tools,
    };
    const stage = async (content) => {
      await writeFile(join(dir, 'fixture.txt'), content);
      await run('git', ['add', 'fixture.txt'], { cwd: dir });
    };
    await stage('safe content');
    await run('git', ['commit', '-m', 'fixture'], { cwd: dir, env });
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, 'gate-args.json'), 'utf8')),
      [
        '--staged',
        '--config',
        join(dir, '.gitleaks.toml'),
        '--redact',
        '--exit-code',
        '1',
        '-v',
      ],
    );
    await stage('changed safe content');
    await assert.rejects(
      run('git', ['commit', '-m', 'must fail'], {
        cwd: dir,
        env: { ...env, DREAMUX_TEST_GATE_EXIT: '1' },
      }),
    );
    await stage('/' + 'data00' + '/private');
    await assert.rejects(
      run('git', ['commit', '-m', 'must also fail'], { cwd: dir, env }),
      (error) => error.stderr.includes('[internal-content] FORBIDDEN'),
    );
    assert.equal(
      (
        await run('git', ['rev-list', '--count', 'HEAD'], { cwd: dir })
      ).stdout.trim(),
      '1',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('knowledge checker preserves links, reachability, citations and its Python task owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dreamux-kb-'));
  try {
    await run('git', ['init', '--quiet', dir]);
    for (const path of [
      '.agents/scripts',
      '.agents/domains',
      '.agents/tasks',
      '.agents/skills/dev-workflow/scripts',
      'packages/fixture/src',
    ]) {
      await mkdir(join(dir, path), { recursive: true });
    }
    await copyFile(
      join(root, '.agents/scripts/check.mjs'),
      join(dir, '.agents/scripts/check.mjs'),
    );
    await copyFile(
      join(root, '.agents/skills/dev-workflow/scripts/init_task.py'),
      join(dir, '.agents/skills/dev-workflow/scripts/init_task.py'),
    );
    await writeFile(
      join(dir, '.agents/root.md'),
      '[domain](domains/current.md)\n[tasks](tasks/README.md)\n',
    );
    await writeFile(
      join(dir, '.agents/domains/current.md'),
      '`/packages/fixture/src/live.ts`\n',
    );
    await writeFile(join(dir, 'packages/fixture/src/live.ts'), 'export {};\n');
    await writeFile(
      join(dir, '.agents/tasks/README.md'),
      '# Development Tasks\n\n## Child Scopes\n',
    );
    await writeFile(join(dir, 'packages/fixture/CLAUDE.md'), '`live.ts`\n');
    await run('git', ['add', '.'], { cwd: dir });
    const command = [join(dir, '.agents/scripts/check.mjs')];
    const good = await run(process.execPath, command, { cwd: dir });
    assert.match(good.stdout, /Task records OK: 0 checked/);
    assert.match(good.stdout, /KB OK \(2 files/);
    await writeFile(join(dir, '.agents/orphan.md'), '[broken](absent.md)\n');
    await writeFile(join(dir, 'packages/fixture/CLAUDE.md'), '`absent.ts`\n');
    await assert.rejects(
      run(process.execPath, command, { cwd: dir }),
      (error) => {
        assert.match(error.stderr, /broken markdown link/);
        assert.match(error.stderr, /orphan KB doc/);
        assert.match(error.stderr, /stale \.ts reference/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('release tarballs require a manifest and pass the shared artifact content gate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dreamux-artifact-gate-'));
  try {
    const archives = join(dir, 'archives');
    await mkdir(archives);
    await mkdir(join(dir, 'package'));
    const command = [join(scripts, 'verify-tarballs.mjs'), archives];
    await assert.rejects(run(process.execPath, command), /found none/);
    await writeFile(join(dir, 'package', 'readme.txt'), 'safe content');
    const pack = () =>
      run('tar', ['-czf', join(archives, 'fixture.tgz'), '-C', dir, 'package']);
    await pack();
    await assert.rejects(
      run(process.execPath, command),
      /missing package.json/,
    );
    await writeFile(join(dir, 'package', 'package.json'), '{"name":"fixture"}');
    await pack();
    await run(process.execPath, command);
    await writeFile(
      join(dir, 'package', 'readme.txt'),
      '/' + 'home' + '/me/private',
    );
    await pack();
    await assert.rejects(run(process.execPath, command), /FORBIDDEN/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('release SSH preparation uses published host keys and rejects missing credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dreamux-release-key-'));
  try {
    const preload = join(dir, 'fetch.mjs');
    await writeFile(
      preload,
      "globalThis.fetch = async (url) => { if (url !== 'https://api.github.com/meta') throw new Error('unexpected URL'); return Response.json({ssh_keys: ['ssh-fixture public-key']}); };\n",
    );
    const command = [
      '--import',
      pathToFileURL(preload).href,
      join(scripts, 'prepare-release-ssh.mjs'),
    ];
    const env = {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      RELEASE_DEPLOY_KEY: '',
    };
    await assert.rejects(
      run(process.execPath, command, { env }),
      /RELEASE_DEPLOY_KEY secret is missing/,
    );
    await run(process.execPath, command, {
      env: { ...env, RELEASE_DEPLOY_KEY: 'fixture-only-key' },
    });
    assert.equal(
      await readFile(join(dir, '.ssh', 'release_deploy_key'), 'utf8'),
      'fixture-only-key\n',
    );
    assert.equal(
      await readFile(join(dir, '.ssh', 'release_known_hosts'), 'utf8'),
      'github.com ssh-fixture public-key\n',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CI author check selects the event commit range and shares local identity rules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dreamux-author-gate-'));
  try {
    await run('git', ['init', '--quiet', dir]);
    await run('git', ['config', 'user.name', 'Fixture'], { cwd: dir });
    await run(
      'git',
      ['config', 'user.email', 'fixture@users.noreply.github.com'],
      { cwd: dir },
    );
    await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    await run('git', ['commit', '--allow-empty', '-m', 'public author'], {
      cwd: dir,
    });
    const before = (
      await run('git', ['rev-parse', 'HEAD'], { cwd: dir })
    ).stdout.trim();
    await run(
      'git',
      [
        '-c',
        'user.email=fixture@localhost',
        'commit',
        '--allow-empty',
        '-m',
        'local author',
      ],
      { cwd: dir },
    );
    const after = (
      await run('git', ['rev-parse', 'HEAD'], { cwd: dir })
    ).stdout.trim();
    const event = join(dir, 'event.json');
    const command = [join(scripts, 'check-author-emails.mjs')];
    const env = {
      ...process.env,
      GITHUB_EVENT_PATH: event,
      GITHUB_EVENT_NAME: 'push',
    };
    await writeFile(
      event,
      JSON.stringify({ before: '0'.repeat(40), after: before }),
    );
    await run(process.execPath, command, { cwd: dir, env });
    await writeFile(event, JSON.stringify({ before, after }));
    await assert.rejects(
      run(process.execPath, command, { cwd: dir, env }),
      /machine-local/,
    );
    await writeFile(
      event,
      JSON.stringify({
        pull_request: { base: { sha: before }, head: { sha: after } },
      }),
    );
    await assert.rejects(
      run(process.execPath, command, {
        cwd: dir,
        env: { ...env, GITHUB_EVENT_NAME: 'pull_request' },
      }),
      /machine-local/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('gitleaks installer rejects a mismatched checksum before publishing an executable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dreamux-installer-checksum-'));
  try {
    const preload = join(dir, 'fetch.mjs');
    await writeFile(
      preload,
      `let asset; globalThis.fetch = async (url) => {
        if (!url.endsWith('_checksums.txt')) { asset = url.split('/').at(-1); return new Response('corrupt archive'); }
        return new Response('0'.repeat(64) + '  ' + asset + '\\n');
      };\n`,
    );
    const directory = join(dir, 'installed');
    await assert.rejects(
      run(
        process.execPath,
        [
          '--import',
          pathToFileURL(preload).href,
          join(scripts, 'install-gitleaks.mjs'),
        ],
        {
          env: {
            ...process.env,
            GITLEAKS_INSTALL_DIR: directory,
            GITHUB_PATH: '',
          },
        },
      ),
      /checksum mismatch/,
    );
    await assert.rejects(readdir(directory), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
