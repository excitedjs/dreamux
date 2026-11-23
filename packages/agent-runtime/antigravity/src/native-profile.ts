import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type {
  AgentRuntimeCreateContext,
  AgentRuntimeSkillSource,
} from '@excitedjs/dreamux-types';

import type { AntigravityConfig } from './config.js';
import { resolveAntigravityNativeRoots } from './paths.js';
import type { AntigravityRuntimeOptions } from './runtime-options.js';

function nativeAgentName(
  context: AgentRuntimeCreateContext<AntigravityConfig>,
): string {
  const digest = createHash('sha256')
    .update(context.paths.cacheDir())
    .update('\0')
    .update(context.identity.runtimeId)
    .digest('hex')
    .slice(0, 24);
  return `dreamux-${digest}`;
}

async function nativeSkillPaths(
  sources: readonly AgentRuntimeSkillSource[],
): Promise<string[]> {
  const paths: string[] = [];
  for (const source of sources) {
    const entries = await readdir(source.path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) paths.push(join(source.path, entry.name));
    }
  }
  return paths.sort();
}

function nativeSystemPrompt(
  prompt: AgentRuntimeCreateContext<AntigravityConfig>['systemPrompt'],
): string {
  if (prompt?.replace !== undefined) return prompt.replace;
  return (prompt?.append ?? []).join('\n\n');
}

const DISABLED_TOOLS_BY_FEATURE: Record<string, readonly string[]> = {
  cron: ['schedule'],
  userInterrupt: ['ask_question'],
};

function nativeDisabledTools(features: readonly string[]): string[] {
  return [
    ...new Set(
      features.flatMap((feature) => DISABLED_TOOLS_BY_FEATURE[feature] ?? []),
    ),
  ];
}

/** Materialize the stable native role agy exact-resume reloads by name. */
export async function prepareNativeProfile(
  context: AgentRuntimeCreateContext<AntigravityConfig>,
): Promise<AntigravityRuntimeOptions> {
  const agentName = nativeAgentName(context);
  const roots = resolveAntigravityNativeRoots({
    ...process.env,
    ...context.config.extra_env,
  });
  const profileDir = join(roots.geminiHome, 'config', 'agents', agentName);
  const logDir = join(context.paths.logsDir(), 'antigravity');
  await Promise.all([
    mkdir(profileDir, { recursive: true, mode: 0o700 }),
    mkdir(logDir, { recursive: true, mode: 0o700 }),
  ]);
  const skills = await nativeSkillPaths(context.skillSources);
  const mcpServers =
    context.config.transport === 'tmux'
      ? context.mcpServers.map((server) => ({
          name: server.name,
          command: server.command,
          args: server.args,
          ...(server.env === undefined ? {} : { env: server.env }),
        }))
      : [];
  const document = `---\nname: ${agentName}\ndescription: Dreamux-managed native role ${agentName}\nmainAgent: true\ninheritMcp: false\nskills: ${JSON.stringify(skills)}\nmcpServers: ${JSON.stringify(mcpServers)}\ndisabledTools: ${JSON.stringify(nativeDisabledTools(context.disabledFeatures))}\n---\n${nativeSystemPrompt(context.systemPrompt)}\n`;
  await writeFile(join(profileDir, 'agent.md'), document, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return {
    agentName,
    nativeLogPath: join(logDir, `${agentName}-${randomUUID()}.log`),
  };
}
