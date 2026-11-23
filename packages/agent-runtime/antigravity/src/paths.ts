import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AntigravityNativeRoots {
  geminiHome: string;
  appDataHome: string;
}

export function resolveAntigravityNativeRoots(
  env: NodeJS.ProcessEnv,
): AntigravityNativeRoots {
  const geminiHome = join(env.HOME ?? homedir(), '.gemini');
  return {
    geminiHome,
    appDataHome: join(geminiHome, 'antigravity-cli'),
  };
}

export function antigravityTranscriptPath(
  roots: AntigravityNativeRoots,
  sessionId: string,
): string {
  return join(
    roots.appDataHome,
    'brain',
    sessionId,
    '.system_generated',
    'logs',
    'transcript_full.jsonl',
  );
}
