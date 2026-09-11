import { isPlainObject } from './config-validate.js';

/**
 * What a conversation, a log line, and a printed config must not publish
 * verbatim. One capability with two ways in, because a caller has one of two
 * things: text, or structure.
 *
 * `redactText` is for text — a command line, an assistant message, a serialized
 * payload — and finds secrets by shape. `isSecretKeyName` is for structure,
 * where a field's *name* already says the value is a secret and no shape
 * matching is needed or wanted. They share one list of secret key names, which
 * is why this module exists: that list used to be written out three times, and
 * the three copies had drifted.
 */

/**
 * A value shaped like JSON, declared here rather than imported.
 *
 * JSON is not a Dreamux concept, and this package deliberately knows no Dreamux
 * contracts: `@excitedjs/dreamux-types` is the type set an *external provider*
 * compiles against, so a utility every layer calls must not reach into it — not
 * even for a type. The shape is structural, so a caller holding that package's
 * `JsonValue` passes one of these without a cast.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * The key names that mean "the value beside me is a secret". Written once and
 * compiled into both the inline text pattern and the bare-name test, so the
 * names a log line hides and the names a tool argument hides cannot drift
 * apart again.
 */
const SECRET_KEY_NAMES = [
  'secret',
  'password',
  'passwd',
  'token',
  'authorization',
  'cookie',
  'credential',
  'api[_-]?key',
  'private[_-]?key',
  'client[_-]?secret',
].join('|');

const BACKTICK = '`';

/**
 * `key: value` / `key=value` pairs whose key names a secret. The value is one
 * quoted string (a JSON string with its escapes, or a shell-style single- or
 * back-quoted one) or one bare word. A bare word stops at whitespace, a
 * separator, a quote, or a closing bracket, so the shape *around* the secret
 * survives: a `token: xyz` phrase inside a quoted string does not swallow the
 * quote and bracket that close it.
 *
 * This reads *text*, so what it sees is one level of quoting. A caller holding
 * a structure walks it instead and hands each string leaf here on its own —
 * that is what `redactJson` is for, and it is why this pattern does not try to
 * understand a JSON string nested inside another. A regex cannot count nesting
 * depth; the walk does not have to.
 */
const INLINE_SECRET_RE = new RegExp(
  String.raw`(["']?\b(?:` +
    SECRET_KEY_NAMES +
    String.raw`)\b["']?)(\s*[:=]\s*)(` +
    String.raw`"(?:[^"\\]|\\.)*"` + '|' +
    String.raw`'[^']*'` + '|' +
    BACKTICK + `[^${BACKTICK}]*` + BACKTICK + '|' +
    String.raw`[^\s,;"'` + BACKTICK + String.raw`)\]}]+)`,
  'giu',
);

const SECRET_KEY_NAME_RE = new RegExp(`(?:${SECRET_KEY_NAMES})`, 'iu');

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const COMMON_ACCESS_KEY_RE = /\b(?:AKIA|ASIA|AKLT)[A-Z0-9]{12,}\b/gu;

/**
 * What may sit inside a path without ending it.
 *
 * A prefix only counts as a path when the characters around it agree that it is
 * one: `~/work` is this operator's home, `/home/alicexyz` is somebody else's
 * directory that merely starts with the same letters, and `not/home/alice` is a
 * fragment of a longer path that was never rooted here. Letters, digits, and
 * the separators/punctuation that appear inside real path segments continue a
 * token; anything else — whitespace, a quote, a colon, a comma — ends it.
 * Two narrower exceptions are handled at a match: a period closes prose only
 * when what follows is already a boundary, and a preceding slash starts a path
 * only when it completes a URL scheme's `://`.
 */
const PATH_TOKEN_CHARACTER_RE = /[\p{L}\p{N}_.~\\/-]/u;

/**
 * Redaction never truncates. How much of a payload a surface can show is that
 * surface's own limit, applied where it sends. Cutting here would hand every
 * surface an already-damaged value — a JSON result that no longer parses —
 * with no way to get it back.
 */
export interface RedactedText { value: string; redacted: boolean }

/**
 * Whether a field's *name* says its value is a secret.
 *
 * Structure needs no shape matching: a caller holding `{ api_key: "..." }`
 * knows the value is a secret whatever it looks like, and a low-entropy or
 * oddly-punctuated one would slip past every pattern. The substring test is
 * deliberate, so `feishu_app_secret` and `refreshToken` both count.
 */
export function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_NAME_RE.test(key);
}

/**
 * Replace, in place, every value whose key names a secret — at any depth.
 *
 * The caller owns a parsed, mutable structure it is about to display, and this
 * is the one thing it must not show. Values are destroyed rather than masked
 * by shape, because the key already settled the question.
 */
export function redactSecretKeyValues(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) redactSecretKeyValues(item);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKeyName(key)) {
      value[key] = '<redacted>';
      continue;
    }
    redactSecretKeyValues(child);
  }
}

/**
 * Rewrite what displayed text must not publish verbatim.
 *
 * Two different jobs share this function. Secrets are *destroyed* — a token has
 * no legible form worth keeping. Paths are only *renamed*: a reader still needs
 * to know which file was touched, so the workspace becomes `.` and this host's
 * home becomes `~`, exactly the way the operator's own shell prints them. Order
 * matters: the workspace usually sits under the home, so relativizing it first
 * keeps the shorter, more useful form.
 *
 * `homePaths` is explicit so this stays pure and never depends on
 * process-global resolution state.
 */
export function redactText(
  value: string,
  cwd: string,
  homePaths: readonly string[],
): RedactedText {
  let redacted = replacePathPrefix(value, cwd, '.', '', true);
  redacted = redacted.replace(PRIVATE_KEY_RE, '<redacted-private-key>');
  for (const homePath of homePaths) {
    redacted = replacePathPrefix(redacted, homePath, '~', '~', false);
  }
  redacted = redacted.replace(BEARER_RE, 'Bearer <redacted>');
  redacted = redacted.replace(JWT_RE, '<redacted-jwt>');
  redacted = redacted.replace(COMMON_ACCESS_KEY_RE, '<redacted-access-key>');
  redacted = redacted.replace(
    INLINE_SECRET_RE,
    (_match, key: string, separator: string, secret: string) => {
      // A quoted secret stays a quoted (now empty of meaning) string, so the
      // text around it keeps whatever grammar it had — JSON included. A nested
      // JSON string is quoted by its escape, not by the bare character.
      const quote = secret.startsWith('\\"')
        ? '\\"'
        : (/^["'`]/u.test(secret) ? secret[0] : '');
      return `${key}${separator}${quote}<redacted>${quote}`;
    },
  );
  return { value: redacted, redacted: redacted !== value };
}

/**
 * Redact a JSON value by walking it, not by reading its serialization.
 *
 * Text is the wrong level for a payload that has structure. Serializing first
 * hides every string inside escapes — `{"client_secret":"x"}` written into a
 * field becomes `{\"client_secret\":\"x\"}`, where the key no longer sits
 * beside its separator and no pattern tuned for text can see it, at any nesting
 * depth. Walking removes the problem instead of chasing it: each level of
 * structure is peeled by the caller that parsed it, so every string this
 * reaches is ordinary text, which is the one thing `redactText` is good at.
 *
 * Two rules, and a key outranks a shape. A field whose *name* says secret has
 * its value destroyed whatever it looks like, which is what catches the
 * low-entropy and oddly-punctuated values no pattern would. Every other string
 * goes through `redactText`. Numbers and booleans carry neither a secret worth
 * masking nor a path worth renaming, so they travel as they are.
 *
 * The result is a new value; the input is not touched. Because the structure
 * survives, a caller that serializes afterwards always gets valid JSON.
 */
export function redactJson(
  value: JsonValue | null,
  cwd: string,
  homePaths: readonly string[],
): { value: JsonValue | null; redacted: boolean } {
  let redacted = false;
  const walk = (node: JsonValue): JsonValue => {
    if (typeof node === 'string') {
      const result = redactText(node, cwd, homePaths);
      redacted ||= result.redacted;
      return result.value;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const out: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(node)) {
      if (isSecretKeyName(key)) {
        redacted = true;
        out[key] = '<redacted>';
        continue;
      }
      out[key] = walk(child);
    }
    return out;
  };
  return value === null
    ? { value: null, redacted: false }
    : { value: walk(value), redacted };
}

/**
 * Replace every occurrence of `rawPrefix` that is actually the head of a path.
 *
 * Scanning for a known prefix is what makes this honest where a regex is not: a
 * pattern like `/home/<name>/...` matches any string of that *shape*, including
 * a directory on some other machine quoted in a log, and blanking those costs
 * legibility for no privacy gain. Only the prefixes this host really uses are
 * offered here, and each hit must still be bounded on both sides — preceded by
 * a non-path character and followed by a separator or the end of a token.
 *
 * A hit with a path continuing after it (`<prefix>/rest`) takes
 * `nestedReplacement`, and `stripNestedSeparator` drops the separator with it so
 * a workspace `<cwd>/rest` turns into `rest`. A hit that ends there takes
 * `exactReplacement`, so a bare workspace becomes `.`.
 */
function replacePathPrefix(
  value: string,
  rawPrefix: string,
  exactReplacement: string,
  nestedReplacement: string,
  stripNestedSeparator: boolean,
): string {
  const prefix = rawPrefix.replace(/[\\/]+$/u, '');
  if (prefix === '') return value;

  let cursor = 0;
  let searchFrom = 0;
  let result = '';
  while (searchFrom < value.length) {
    const matchAt = value.indexOf(prefix, searchFrom);
    if (matchAt < 0) break;

    const suffixAt = matchAt + prefix.length;
    const next = value[suffixAt];
    const nested = next === '/' || next === '\\';
    const ends = isPathPrefixEnd(value, suffixAt);
    if (isPathPrefixBoundary(value, matchAt) && (nested || ends)) {
      result += value.slice(cursor, matchAt);
      result += nested ? nestedReplacement : exactReplacement;
      cursor = suffixAt + (nested && stripNestedSeparator ? 1 : 0);
      searchFrom = cursor;
      continue;
    }
    searchFrom = suffixAt;
  }
  return cursor === 0 ? value : result + value.slice(cursor);
}

function isPathPrefixBoundary(value: string, matchAt: number): boolean {
  if (matchAt === 0 || isPathTokenBoundary(value[matchAt - 1])) return true;
  return matchAt >= 3 && value.slice(matchAt - 3, matchAt) === '://';
}

function isPathPrefixEnd(value: string, suffixAt: number): boolean {
  const next = value[suffixAt];
  if (next === undefined) return true;
  return next === '.'
    ? isPathTokenBoundary(value[suffixAt + 1])
    : isPathTokenBoundary(next);
}

function isPathTokenBoundary(character: string | undefined): boolean {
  return character === undefined || !PATH_TOKEN_CHARACTER_RE.test(character);
}
