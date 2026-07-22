interface MarkdownFence {
  marker: '`' | '~';
  length: number;
}

export function markdownFenceCloser(value: string): string {
  const fence = activeMarkdownFence(value);
  if (fence === null) return '';
  const leadingNewline = value.endsWith('\n') ? '' : '\n';
  return `${leadingNewline}${fence.marker.repeat(fence.length)}\n`;
}

function activeMarkdownFence(value: string): MarkdownFence | null {
  let active: MarkdownFence | null = null;
  for (const rawLine of value.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (active === null) {
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (opening === null) continue;
      const run = opening[1];
      active = {
        marker: run[0] as '`' | '~',
        length: run.length,
      };
      continue;
    }
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (
      closing !== null &&
      closing[1][0] === active.marker &&
      closing[1].length >= active.length
    ) {
      active = null;
    }
  }
  return active;
}
