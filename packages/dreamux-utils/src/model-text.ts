/** Quote a result value without letting paths, refs or runtime ids form Markdown. */
export function quoteModelValue(value: string): string {
  // JSON quoting keeps quotes and control characters literal; Markdown escaping
  // also keeps links, code spans and tags literal, including GFM URL autolinks.
  return JSON.stringify(value).replace(/[\\`*_{}[\]()<>!|:.~&]/g, '\\$&');
}
