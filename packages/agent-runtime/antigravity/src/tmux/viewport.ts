export interface TmuxViewport {
  ready: boolean;
  busy: boolean;
  interrupted: boolean;
  nativeError: boolean;
  blocker: Error | undefined;
}

export function parseViewport(screen: string): TmuxViewport {
  const rows = screen
    .trimEnd()
    .split('\n')
    .map((row) => row.trim());
  const footer = rows.at(-1) ?? '';
  const busy = rows.some((row) => /^esc to cancel(?:\s|$)/i.test(row));
  const composer = rows
    .slice(0, -1)
    .findLastIndex((row) => row.startsWith('>'));
  const composerRows = rows
    .slice(composer, -1)
    .filter((row) => !separator(row));
  const ready =
    !busy &&
    /^\? for shortcuts(?:\s|$)/.test(footer) &&
    composer >= 0 &&
    emptyComposer(composerRows);
  const previous = rows.slice(0, composer).findLast((row) => !separator(row));
  const meaningful = rows.filter((row) => !separator(row));
  const trust =
    rows.includes('Trust this folder?') &&
    rows.some((row) => row.includes('Yes, I trust this folder'));
  const permission = rows.includes('Requesting permission for:');
  const blocker = trust
    ? new Error('Antigravity native TUI requires workspace trust')
    : permission
      ? new Error(
          'Antigravity native TUI is waiting for a tool permission decision',
        )
      : undefined;
  return {
    blocker,
    ready,
    busy,
    interrupted:
      ready &&
      previous === '⎿ Interrupted · What should Antigravity CLI do instead?',
    nativeError:
      !busy &&
      meaningful.at(-1) === '>' &&
      /^Error ID:\s+[a-z\d-]+$/i.test(meaningful.at(-2) ?? ''),
  };
}

function separator(row: string): boolean {
  return /^[─━]*$/.test(row);
}

function emptyComposer(rows: readonly string[]): boolean {
  const text = rows.join(' ');
  return (
    text === '>' ||
    /^> (?:Auto mode: edits & safe commands auto-approved|Accept-edits mode: file edits auto-approved|Plan mode: research & plan only|Best-of-N mode: fork into parallel arms and pick a winner) \(shift\+tab to cycle\)$/.test(
      text,
    )
  );
}
