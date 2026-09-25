/**
 * Build the process env for a Codex app-server child: `{ ...process.env,
 * ...extraEnv }`, where `extraEnv` is this provider's own `config.extra_env`.
 * The child inherits the operator's ambient `CODEX_HOME` like a vanilla
 * `codex` invocation — Dreamux creates no dispatcher-private Codex home (MVP),
 * so there is nothing to strip.
 */
export function codexProcessEnv(
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { ...globalThis.process.env, ...extraEnv };
}

export function codexThreadInstructions(options: {
  systemPromptReplace?: string | undefined;
  systemPromptAppend?: readonly string[] | undefined;
}): { baseInstructions?: string; developerInstructions?: string } {
  if (options.systemPromptReplace !== undefined) {
    return { baseInstructions: options.systemPromptReplace };
  }
  const developerInstructions = (options.systemPromptAppend ?? [])
    .filter((prompt) => prompt !== '')
    .map(
      (prompt) =>
        `<developer-reminder>\n${escapeXmlText(prompt)}\n</developer-reminder>`,
    )
    .join('\n\n');
  return developerInstructions === '' ? {} : { developerInstructions };
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
