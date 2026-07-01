/**
 * Build the process env for a Codex app-server child. The neutral env boundary
 * (issue #209 cleanup) is `{ ...process.env, ...injectEnv, ...extraEnv }`:
 *   - `injectEnv` is the host's optional neutral env-injection seam from the
 *     create context (empty today); core owns what it injects.
 *   - `extraEnv` is THIS provider's own `config.extra_env`, merged last so a
 *     dispatcher can override an injected value.
 * The child inherits the operator's ambient `CODEX_HOME` like a vanilla
 * `codex` invocation — Dreamux creates no dispatcher-private Codex home (MVP),
 * so there is nothing to strip.
 */
export function codexProcessEnv(
  injectEnv: Record<string, string> = {},
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { ...globalThis.process.env, ...injectEnv, ...extraEnv };
}

export function buildCodexSystemPromptAppendItem(
  systemPromptAppend: readonly string[],
): Record<string, unknown> {
  return {
    type: 'message',
    role: 'developer',
    content: [
      {
        type: 'input_text',
        text: renderCodexSystemPromptAppend(systemPromptAppend),
      },
    ],
  };
}

export function renderCodexSystemPromptAppend(
  append: readonly string[],
): string {
  return append
    .filter((prompt) => prompt !== '')
    .map(
      (prompt) =>
        `<developer-reminder>\n${escapeXmlText(prompt)}\n</developer-reminder>`,
    )
    .join('\n\n');
}

function escapeXmlText(text: string): string {
  return text.replace(/[&<>]/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      default:
        return char;
    }
  });
}
