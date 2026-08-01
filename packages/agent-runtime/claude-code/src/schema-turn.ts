/**
 * One-shot `claude --print --json-schema` turn for structured output.
 *
 * The resident stream-json session applies CLI flags at spawn time and cannot
 * re-negotiate a per-turn JSON schema, so a turn that requests `outputSchema`
 * spawns a separate short-lived process here. The prompt is written to stdin;
 * the single `--output-format json` result on stdout carries a pre-validated
 * `structured_output` field. Returns the result as text so the caller (workflow
 * runner) does `JSON.parse` once, matching the codex path.
 */

import { SupervisedChild } from '@excitedjs/dreamux-utils';
import type { DispatcherClaudeCodeConfig } from './config.js';
import { claudeCodeSchemaArgs } from './args.js';

export interface RunSchemaTurnInput {
  bin: string;
  config: DispatcherClaudeCodeConfig;
  mcpConfigJson: string;
  outputSchema: Record<string, unknown>;
  systemPromptAppend?: readonly string[];
  skillAddDirs?: readonly string[];
  disableFeatures?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
}

export async function runClaudeCodeSchemaTurn(
  input: RunSchemaTurnInput,
): Promise<string | null> {
  const args = claudeCodeSchemaArgs({
    config: input.config,
    mcpConfigJson: input.mcpConfigJson,
    outputSchema: input.outputSchema,
    systemPromptAppend: input.systemPromptAppend,
    skillAddDirs: input.skillAddDirs,
    disableFeatures: input.disableFeatures,
  });
  const supervisor = new SupervisedChild({
    kind: 'spawn',
    command: input.bin,
    args,
    options: {
      cwd: input.cwd,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  });
  supervisor.onError((error) => {
    input.log?.('warn', 'claude-code schema child error', error);
  });
  const child = await supervisor.start();
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (stdout === null || stdin === null) {
    await supervisor.stop();
    throw new Error('claude-code schema child spawned without stdio');
  }
  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const exit = new Promise<number | null>((resolve) => {
    supervisor.onExit((exit) => resolve(exit.code));
  });
  stdin.end(input.prompt);
  const code = await exit;
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (code !== 0) {
    throw new Error(
      `claude-code schema child exited with code ${code}: ${raw.slice(0, 500)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `claude-code schema child returned non-JSON output: ${raw.slice(0, 500)}`,
    );
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { is_error?: boolean }).is_error === true
  ) {
    const msg =
      (parsed as { error?: string }).error ??
      (parsed as { result?: string }).result ??
      'claude-code schema turn failed';
    throw new Error(String(msg));
  }
  const structured = (parsed as { structured_output?: unknown })
    .structured_output;
  return structured !== undefined
    ? JSON.stringify(structured)
    : String((parsed as { result?: unknown }).result ?? '');
}
