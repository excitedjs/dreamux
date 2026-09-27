/** Map a runtime's replace/append system prompt onto Codex's thread-start/resume instructions fields. */
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
