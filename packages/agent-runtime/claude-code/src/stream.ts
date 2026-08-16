/**
 * The Claude Code stream-json wire protocol (issue #120).
 *
 * A clean-room model of the NDJSON envelopes the `claude` CLI emits and accepts
 * on stdio under `--input-format stream-json --output-format stream-json`. This
 * is what makes the `builtin:claude-code` runtime *resident*: one long-lived
 * `claude --print` process consumes user-message lines on stdin and streams
 * `init` / `assistant` / `result` envelopes on stdout, instead of a fresh
 * one-shot process per turn.
 *
 * Two design rules, both load-bearing:
 *
 *  - **Forward-tolerant by construction.** The CLI's real envelope set is much
 *    wider than anything Dreamux consumes (extra `system` subtypes, rate-limit
 *    events, hook lifecycle, streamlined variants, and extra `result` fields).
 *    This parser never validates a closed schema and never throws on an unknown
 *    `type` / `subtype`; it reads only the fields the runtime needs and ignores
 *    the rest. A wider or newer CLI build cannot break a turn.
 *
 *  - **Pure, no IO.** No process, no clock, no filesystem — so the line framer,
 *    the line parser, and the turn aggregator are unit-tested against synthetic
 *    envelope sequences (hand-authored to the real wire shapes) with no live
 *    `claude` binary.
 *
 * Public-safety note: this module is a generic protocol model. It carries no
 * Feishu identifiers, tokens, private paths, or environment-specific details.
 */

import type {
  JsonObject,
  ParsedLine,
  ResultEnvelope,
  TurnOutcome,
  TurnSubmitOptions,
} from './types.js';

export type {
  JsonObject,
  ParsedLine,
  ResultEnvelope,
  TurnOutcome,
} from './types.js';

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// ─── Line framing ───────────────────────────────────────────────────────────

/**
 * Incremental newline framer. The child's stdout is NDJSON but arrives in
 * arbitrary chunks; `push` returns the complete lines so far and buffers a
 * trailing partial line until its newline lands. Blank lines are dropped.
 */
export class LineBuffer {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let nl = this.buf.indexOf('\n');
    while (nl >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (trimmed.length > 0) out.push(trimmed);
      nl = this.buf.indexOf('\n');
    }
    return out;
  }

  /** Any buffered bytes with no trailing newline (e.g. at stream end). */
  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = '';
    return rest.length > 0 ? rest : null;
  }
}

/**
 * Join the text blocks of an Anthropic assistant `message.content` array.
 * `thinking` and `tool_use` blocks contribute no visible text and are skipped.
 */
export function assistantText(message: unknown): string {
  if (!isObject(message)) return '';
  const content = message['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block['type'] === 'text') {
      const t = str(block['text']);
      if (t !== null) parts.push(t);
    }
  }
  return parts.join('');
}

function parseResult(o: JsonObject): ResultEnvelope {
  const subtype = str(o['subtype']);
  const errorsRaw = o['errors'];
  const errors = Array.isArray(errorsRaw)
    ? errorsRaw.filter((e): e is string => typeof e === 'string')
    : [];
  let isError: boolean;
  if (subtype !== null) {
    isError = subtype !== 'success';
  } else {
    isError = o['is_error'] === true || errors.length > 0;
  }
  // In --json-schema mode Claude Code surfaces the validated object in
  // `structured_output`; prefer it over the free-form `result` text so the
  // workflow always receives clean, schema-conformant JSON to parse.
  //
  // Presence is checked by key, not by nullish: a JSON Schema `null` root type
  // is a valid structured output, so an explicit `structured_output: null` must
  // serialize to the JSON text `"null"` rather than falling back to `result`.
  const hasStructuredOutput = 'structured_output' in o;
  const text = hasStructuredOutput
    ? JSON.stringify(o['structured_output'])
    : str(o['result']);
  return {
    subtype,
    isError,
    text,
    sessionId: str(o['session_id']),
    errors,
    hasStructuredOutput,
  };
}

/**
 * Decode one stdout line. Never throws: a non-JSON line becomes `parse_error`,
 * and a JSON object of an unmodelled type becomes `other`.
 */
export function parseLine(line: string): ParsedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'parse_error', raw: line };
  }
  if (!isObject(parsed)) return { kind: 'parse_error', raw: line };
  const type = str(parsed['type']);
  const subtype = str(parsed['subtype']);

  switch (type) {
    case 'system':
      if (subtype === 'init') {
        return {
          kind: 'init',
          sessionId: str(parsed['session_id']),
          model: str(parsed['model']),
          capabilities: Array.isArray(parsed['capabilities'])
            ? parsed['capabilities'].filter(
                (value): value is string => typeof value === 'string',
              )
            : [],
          raw: parsed,
        };
      }
      if (subtype === 'command_lifecycle') {
        const state = str(parsed['state']);
        return {
          kind: 'command_lifecycle',
          commandUuid: str(parsed['command_uuid']),
          state:
            state === 'queued' ||
            state === 'started' ||
            state === 'completed' ||
            state === 'cancelled' ||
            state === 'discarded'
              ? state
              : null,
          raw: parsed,
        };
      }
      return { kind: 'other', type, subtype, raw: parsed };
    case 'assistant':
      return {
        kind: 'assistant',
        text: assistantText(parsed['message']),
        sessionId: str(parsed['session_id']),
        raw: parsed,
      };
    case 'result':
      return { kind: 'result', outcome: parseResult(parsed), raw: parsed };
    case 'control_request': {
      const request = parsed['request'];
      return {
        kind: 'control_request',
        requestId: str(parsed['request_id']),
        subtype: isObject(request) ? str(request['subtype']) : null,
        request: isObject(request) ? request : {},
        raw: parsed,
      };
    }
    case 'control_response': {
      const response = parsed['response'];
      if (isObject(response)) {
        const inner = response['response'];
        return {
          kind: 'control_response',
          requestId: str(response['request_id']),
          ok: response['subtype'] === 'success',
          response: isObject(inner) ? inner : null,
          error: str(response['error']),
          raw: parsed,
        };
      }
      return {
        kind: 'control_response',
        requestId: null,
        ok: false,
        response: null,
        error: null,
        raw: parsed,
      };
    }
    default:
      return { kind: 'other', type, subtype, raw: parsed };
  }
}

// ─── Outbound message builders (stdin) ──────────────────────────────────────

/**
 * One user turn as a stream-json `user` message line (no trailing newline).
 *
 * `isSynthetic` / `priority` are siblings of `message` on the stdin envelope
 * (claude-code SDKUserMessage schema), not part of the message body. They are
 * only set for the native completion-notification idiom; a plain channel turn
 * omits them entirely and reads as a normal human user turn.
 */
export function buildUserMessage(
  text: string,
  options: TurnSubmitOptions = {},
  commandUuid?: string,
): string {
  const envelope: Record<string, unknown> = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
  if (commandUuid !== undefined) envelope['uuid'] = commandUuid;
  if (options.isSynthetic === true) envelope['isSynthetic'] = true;
  if (options.priority !== undefined) envelope['priority'] = options.priority;
  return JSON.stringify(envelope);
}

/** Enable Claude Code Remote Control via a stream-json control request. */
export function buildRemoteControlEnable(requestId: string): string {
  return JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'remote_control', enabled: true },
  });
}

/**
 * Answer a `can_use_tool` control request with `allow`. A Dreamux dispatcher
 * runs unattended, so the answer for a runtime that has no human to consult is
 * "allow"; `updatedInput` echoes the tool's original input back unchanged.
 *
 * This is a defensive path: under a bypassing permission mode the CLI does not
 * gate tools, so `can_use_tool` is not normally emitted. It is wired so that if
 * a build or mode does emit one, the runtime answers it rather than leaving the
 * turn waiting on an unanswered control request.
 */
export function buildCanUseToolAllow(requestId: string, input: JsonObject): string {
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { behavior: 'allow', updatedInput: input },
    },
  });
}

/** Acknowledge any other control request with a bare success so the CLI proceeds. */
export function buildControlAck(requestId: string): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: {} },
  });
}

// ─── Turn aggregation ───────────────────────────────────────────────────────

/**
 * Accumulates the envelopes of a single turn and resolves a `TurnOutcome` when
 * the `result` lands. One aggregator per turn: feed every `ParsedLine`, then
 * read `outcome()` once `done` is true.
 *
 * The final text prefers the `result.result` (the CLI's own canonical answer)
 * and falls back to the latest `assistant` snapshot — so a turn that ends
 * tool-only or whose result text is empty still surfaces whatever the model
 * last said.
 */
export class TurnAggregator {
  private lastAssistantText = '';
  private result: ResultEnvelope | null = null;
  private initSessionId: string | null = null;

  /** Returns `true` once the terminal `result` has been seen. */
  get done(): boolean {
    return this.result !== null;
  }

  /** The session id from `init` (or the result), once known. */
  get sessionId(): string | null {
    return this.result?.sessionId ?? this.initSessionId;
  }

  accept(line: ParsedLine): void {
    switch (line.kind) {
      case 'init':
        if (line.sessionId !== null) this.initSessionId = line.sessionId;
        break;
      case 'assistant':
        if (line.text.length > 0) this.lastAssistantText = line.text;
        break;
      case 'result':
        this.result = line.outcome;
        break;
      default:
        break;
    }
  }

  outcome(): TurnOutcome | null {
    const r = this.result;
    if (r === null) return null;
    const text =
      r.text !== null && r.text.length > 0 ? r.text : this.lastAssistantText;
    return {
      isError: r.isError,
      text,
      sessionId: r.sessionId ?? this.initSessionId,
      subtype: r.subtype,
      errors: r.errors,
      hasStructuredOutput: r.hasStructuredOutput,
    };
  }
}
