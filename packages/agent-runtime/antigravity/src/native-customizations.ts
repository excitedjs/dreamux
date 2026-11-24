import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentRuntimeCreateContext } from '@excitedjs/dreamux-types';

import type { AntigravityConfig } from './config.js';
import {
  antigravityNativeLogPath,
  antigravityRuntimeKey,
  type AntigravityRuntimeOptions,
} from './runtime-options.js';

/** Build default-agent customizations in provider cache, never user skill dirs. */
export async function prepareNativeCustomizations(
  context: AgentRuntimeCreateContext<AntigravityConfig>,
): Promise<AntigravityRuntimeOptions> {
  return {
    nativeLogPath: antigravityNativeLogPath(context),
    skillAddDir: await materializeCustomizations(context),
  };
}

async function materializeCustomizations(
  context: AgentRuntimeCreateContext<AntigravityConfig>,
): Promise<string | null> {
  const promptAppend = (context.systemPrompt?.append ?? []).join('\n\n');
  const tmux = context.config.transport === 'tmux';
  const needsRoot =
    context.skillSources.length > 0 ||
    (tmux && (context.mcpServers.length > 0 || promptAppend !== ''));
  if (!needsRoot) return null;

  const root = join(
    context.paths.cacheDir(),
    'antigravity',
    'native-customizations',
    antigravityRuntimeKey(context),
  );
  const temporary = `${root}.${randomUUID()}.tmp`;
  const skillsRoot = join(temporary, '.agents', 'skills');
  try {
    await mkdir(skillsRoot, { recursive: true });
    const linked = new Map<string, string>();
    for (const source of context.skillSources) {
      const entries = await readdir(source.path, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = join(source.path, entry.name);
        const previous = linked.get(entry.name);
        if (previous !== undefined && previous !== skillPath) {
          throw new Error(
            `duplicate Antigravity skill ${JSON.stringify(entry.name)} from ${previous} and ${skillPath}`,
          );
        }
        if (previous !== undefined) continue;
        linked.set(entry.name, skillPath);
        await symlink(
          skillPath,
          join(skillsRoot, entry.name),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
    }
    if (tmux) {
      if (context.mcpServers.length > 0) {
        const mcpServers = Object.fromEntries(
          context.mcpServers.map((server) => [
            server.name,
            {
              command: server.command,
              args: server.args,
              ...(server.env === undefined ? {} : { env: server.env }),
            },
          ]),
        );
        await writeFile(
          join(temporary, '.agents', 'mcp_config.json'),
          `${JSON.stringify({ mcpServers }, null, 2)}\n`,
          { mode: 0o600 },
        );
      }
      if (promptAppend !== '') {
        await mkdir(join(temporary, '.agents', 'rules'), { recursive: true });
        await writeFile(
          join(temporary, '.agents', 'rules', 'dreamux.md'),
          `---\ntrigger: always_on\n---\n${promptAppend}\n`,
          { mode: 0o600 },
        );
      }
    }
    await mkdir(dirname(root), { recursive: true });
    await rm(root, { recursive: true, force: true });
    await rename(temporary, root);
    return root;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}
