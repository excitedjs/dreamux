/**
 * Minimal subset of the Codex app-server JSON-RPC protocol used by dreamux.
 *
 * The full schema lives in the codex repo (ts-rs generated); we hand-curate
 * the shapes we actually consume / send. This avoids vendoring the whole
 * codex-protocol package — at the cost of a CI drift gate that should be
 * added in a follow-up (see issue #2 §"Codex 协议处理").
 */

export interface UserInputText {
  type: 'text';
  text: string;
  text_elements: never[];
}

export type UserInput = UserInputText;

/**
 * Init handshake (codex 0.134+ LSP-style).
 *
 * Without this the daemon answers every other RPC with `Not initialized`.
 * The sequence is: client → `initialize` request, server → response, client
 * → `initialized` notification.
 */
export interface ClientInfo {
  name: string;
  title?: string | null;
  version: string;
}

export interface InitializeCapabilities {
  experimentalApi: boolean;
  requestAttestation: boolean;
  optOutNotificationMethods?: string[] | null;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface ThreadStartParams {
  cwd?: string | null;
  approvalPolicy?: string | null;
  baseInstructions?: string | null;
}

export interface ThreadStartResponse {
  thread: { id: string };
  [k: string]: unknown;
}

export interface ThreadResumeParams {
  threadId: string;
  cwd?: string | null;
  approvalPolicy?: string | null;
  baseInstructions?: string | null;
}

export interface ThreadResumeResponse {
  thread: { id: string };
  [k: string]: unknown;
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
}

export interface TurnStartResponse {
  turn: { id: string };
}

/** Subset of ThreadItem we actually read. We collapse the union to a structural type. */
export interface ThreadItem {
  type: string;
  id: string;
  text?: string;
  // commandExecution / reasoning / etc. carry extra fields we ignore.
  [k: string]: unknown;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: { id: string; items?: ThreadItem[]; error?: { message: string } };
}

/**
 * codex `error` server notification (method `"error"`). `willRetry: true` is a
 * transient error that does NOT interrupt the turn (codex retries internally);
 * `willRetry: false` is a fatal error that interrupts the turn — and codex does
 * NOT emit a subsequent `turn/completed` for it, so a turn collector that only
 * waits for `turn/completed` would hang forever. We treat `willRetry === false`
 * as the turn's terminal failure.
 */
export interface TurnErrorNotification {
  threadId?: string;
  turnId?: string;
  willRetry?: boolean;
  error: { message: string; [k: string]: unknown };
}

export interface ItemCompletedNotification {
  threadId: string;
  turnId: string;
  completedAtMs: number;
  item: ThreadItem;
}

/** JSON-RPC envelope shapes (codex omits the `jsonrpc` version field). */
export interface RequestEnvelope {
  method: string;
  id: number;
  params: unknown;
}

export interface OkResponseEnvelope {
  id: number;
  result: unknown;
}

export interface ErrResponseEnvelope {
  id: number;
  error: { code?: number; message: string; data?: unknown };
}

export type ResponseEnvelope = OkResponseEnvelope | ErrResponseEnvelope;

export interface ServerNotification {
  method: string;
  params: unknown;
}

export interface ServerRequest {
  method: string;
  id: number;
  params: unknown;
}
