import { describe, expect, it } from 'vitest';

import {
  detectServiceNodeVersionManager,
  selectServiceNodeBin,
  stabilizeHomebrewCellarNode,
  stableNodeCandidates,
  versionManagerOfPath,
  type ServiceNodeProbe,
} from '../src/onboard/service.js';
import type { CommandRunner } from '../src/onboard/types.js';

class FakeRunner implements CommandRunner {
  // node bin path -> version string the probe should report
  readonly versions = new Map<string, string>();
  readonly captured: string[] = [];

  async run(): Promise<void> {}
  async check(): Promise<boolean> {
    return true;
  }
  async capture(command: string, args: string[]): Promise<string> {
    if (args[0] === '--version') {
      this.captured.push(command);
      const version = this.versions.get(command);
      if (version === undefined) {
        throw new Error(`no fake node at ${command}`);
      }
      return version;
    }
    throw new Error(`unexpected capture: ${command} ${args.join(' ')}`);
  }
}

/** A probe whose executable set and symlink map are explicit. */
function probeFrom(options: {
  executables: string[];
  links?: Record<string, string>;
}): ServiceNodeProbe {
  const executables = new Set(options.executables);
  const links = options.links ?? {};
  return {
    isExecutable: (path) => executables.has(path),
    realpath: async (path) => {
      if (path in links) return links[path];
      if (executables.has(path)) return path;
      throw new Error(`ENOENT: ${path}`);
    },
  };
}

describe('versionManagerOfPath', () => {
  it.each([
    ['/home/u/.nvm/versions/node/v22.7.0/bin/node', 'nvm'],
    ['/home/u/.fnm/node-versions/v22/installation/bin/node', 'fnm'],
    ['/home/u/.local/state/fnm_multishells/12345_1/bin/node', 'fnm'],
    ['/home/u/.local/share/fnm/node-versions/v22/installation/bin/node', 'fnm'],
    ['/Users/u/Library/Application Support/fnm/node-versions/v22/bin/node', 'fnm'],
    ['/home/u/.asdf/installs/nodejs/22.7.0/bin/node', 'asdf'],
    ['/home/u/.asdf/shims/node', 'asdf'],
    ['/home/u/.volta/tools/image/node/22.7.0/bin/node', 'volta'],
  ])('flags %s as %s', (path, manager) => {
    expect(versionManagerOfPath(path)).toBe(manager);
  });

  it('does not match a user directory literally named volta', () => {
    expect(versionManagerOfPath('/home/volta/bin/node')).toBeNull();
  });

  it('returns null for system paths', () => {
    expect(versionManagerOfPath('/usr/local/bin/node')).toBeNull();
    expect(versionManagerOfPath('/opt/homebrew/bin/node')).toBeNull();
  });
});

describe('detectServiceNodeVersionManager', () => {
  it('catches a system-looking shim that realpaths into a version manager', async () => {
    const probe = probeFrom({
      executables: ['/usr/local/bin/node'],
      links: {
        '/usr/local/bin/node': '/home/u/.nvm/versions/node/v22.7.0/bin/node',
      },
    });
    expect(
      await detectServiceNodeVersionManager('/usr/local/bin/node', probe),
    ).toBe('nvm');
  });

  it('returns null when neither the raw nor resolved path is managed', async () => {
    const probe = probeFrom({ executables: ['/usr/bin/node'] });
    expect(
      await detectServiceNodeVersionManager('/usr/bin/node', probe),
    ).toBeNull();
  });

  it('falls back to the raw path when realpath fails', async () => {
    const probe = probeFrom({ executables: [] });
    expect(
      await detectServiceNodeVersionManager(
        '/home/u/.volta/tools/image/node/22.7.0/bin/node',
        probe,
      ),
    ).toBe('volta');
  });
});

describe('stableNodeCandidates', () => {
  it('covers Homebrew on macOS', () => {
    const list = stableNodeCandidates('darwin');
    expect(list).toContain('/opt/homebrew/bin/node');
    expect(list).toContain('/opt/homebrew/opt/node@22/bin/node');
    expect(list).toContain('/usr/local/opt/node/bin/node');
    expect(list).toContain('/usr/bin/node');
  });

  it('uses system locations on Linux', () => {
    expect(stableNodeCandidates('linux')).toEqual([
      '/usr/local/bin/node',
      '/usr/bin/node',
      '/bin/node',
    ]);
  });
});

describe('selectServiceNodeBin', () => {
  it('picks the first executable, non-managed, version-satisfying candidate', async () => {
    const runner = new FakeRunner();
    runner.versions.set('/usr/local/bin/node', 'v22.9.0');
    const probe = probeFrom({ executables: ['/usr/local/bin/node'] });

    const selected = await selectServiceNodeBin({
      platform: 'linux',
      currentNodeBin: '/home/u/.nvm/versions/node/v18.0.0/bin/node',
      runner,
      probe,
    });
    // Persists the candidate path itself, never its realpath.
    expect(selected).toBe('/usr/local/bin/node');
  });

  it('skips a candidate that is too old and tries the next', async () => {
    const runner = new FakeRunner();
    runner.versions.set('/usr/local/bin/node', 'v18.20.0');
    runner.versions.set('/usr/bin/node', 'v22.7.0');
    const probe = probeFrom({
      executables: ['/usr/local/bin/node', '/usr/bin/node'],
    });

    const selected = await selectServiceNodeBin({
      platform: 'linux',
      currentNodeBin: '/usr/bin/node',
      runner,
      probe,
    });
    expect(selected).toBe('/usr/bin/node');
  });

  it('skips a version-manager-bound candidate without probing its version', async () => {
    const runner = new FakeRunner();
    const probe = probeFrom({
      executables: ['/usr/local/bin/node'],
      links: {
        '/usr/local/bin/node': '/home/u/.fnm/node-versions/v22/installation/bin/node',
      },
    });

    const selected = await selectServiceNodeBin({
      platform: 'linux',
      currentNodeBin: '/some/current/node',
      runner,
      probe,
    });
    expect(selected).toBe('/some/current/node');
    expect(runner.captured).not.toContain('/usr/local/bin/node');
  });

  it('falls back to the current Node when no stable candidate exists', async () => {
    const runner = new FakeRunner();
    const probe = probeFrom({ executables: [] });

    const selected = await selectServiceNodeBin({
      platform: 'linux',
      currentNodeBin: '/home/u/.nvm/versions/node/v22.7.0/bin/node',
      runner,
      probe,
    });
    // Fallback reproduces the fragility; the doctor advisory is the safety net.
    expect(selected).toBe('/home/u/.nvm/versions/node/v22.7.0/bin/node');
  });
});

describe('stabilizeHomebrewCellarNode', () => {
  it('remaps a Cellar path to the @major Homebrew symlink that points back to it', async () => {
    const cellar = '/opt/homebrew/Cellar/node@22/22.7.0/bin/node';
    const probe = probeFrom({
      executables: ['/opt/homebrew/opt/node@22/bin/node', cellar],
      links: { '/opt/homebrew/opt/node@22/bin/node': cellar },
    });

    expect(await stabilizeHomebrewCellarNode(cellar, 'darwin', probe)).toBe(
      '/opt/homebrew/opt/node@22/bin/node',
    );
  });

  it('remaps an unversioned Cellar node to opt/node/bin/node', async () => {
    const cellar = '/usr/local/Cellar/node/24.1.0/bin/node';
    const probe = probeFrom({
      executables: ['/usr/local/opt/node/bin/node', cellar],
      links: { '/usr/local/opt/node/bin/node': cellar },
    });

    expect(await stabilizeHomebrewCellarNode(cellar, 'darwin', probe)).toBe(
      '/usr/local/opt/node/bin/node',
    );
  });

  it('keeps the input when no stable symlink resolves back to it', async () => {
    const cellar = '/opt/homebrew/Cellar/node/24.1.0/bin/node';
    const probe = probeFrom({ executables: [cellar] });

    expect(await stabilizeHomebrewCellarNode(cellar, 'darwin', probe)).toBe(
      cellar,
    );
  });

  it('is a no-op on non-darwin platforms', async () => {
    const cellar = '/opt/homebrew/Cellar/node/24.1.0/bin/node';
    const probe = probeFrom({ executables: [cellar] });

    expect(await stabilizeHomebrewCellarNode(cellar, 'linux', probe)).toBe(
      cellar,
    );
  });

  it('leaves a non-Cellar path untouched', async () => {
    const probe = probeFrom({ executables: ['/opt/homebrew/bin/node'] });

    expect(
      await stabilizeHomebrewCellarNode('/opt/homebrew/bin/node', 'darwin', probe),
    ).toBe('/opt/homebrew/bin/node');
  });
});
