/**
 * Codex app-server LSP-style init handshake (required by codex 0.134+).
 *
 * Without this, every business RPC (`thread/start`, `turn/start`, …) is
 * answered with `Not initialized` and the daemon never moves. The sequence
 * is the canonical LSP one:
 *
 *   1. client → `initialize` request with ClientInfo + capabilities
 *   2. server → InitializeResponse (userAgent, codexHome, platform info)
 *   3. client → `initialized` notification (no params)
 *
 * Steps 1 + 3 are both required: codex's `Not initialized` guard is cleared
 * only once the notification arrives. Capabilities can be omitted (the spec
 * accepts `null`) — we pass an explicit default so the negotiation choices
 * are visible in the source.
 */

import type { CodexWsClient } from './rpc.js';
import type {
  ClientInfo,
  InitializeCapabilities,
  InitializeParams,
  InitializeResponse,
} from './types.js';

/**
 * Our default ClientInfo. Picked once at module load so the version doesn't
 * have to be threaded through every call site. Keep in sync with package.json.
 */
const DREAMUX_CLIENT_INFO: ClientInfo = {
  name: 'dreamux',
  title: 'dreamux Codex-host server',
  version: '0.1.0',
};

const DEFAULT_CAPABILITIES: InitializeCapabilities = {
  // We don't currently consume any experimental method, but turning this on
  // is harmless — codex only widens the set of method/field shapes it'll
  // emit. Keeping it true avoids a future surprise if we start consuming an
  // experimental notification (e.g. turn/streaming) and the daemon was
  // silently dropping it because of this flag.
  experimentalApi: true,
  // We do not handle attestation requests; do not invite them.
  requestAttestation: false,
};

export interface HandshakeOptions {
  clientInfo?: ClientInfo;
  capabilities?: InitializeCapabilities | null;
  /**
   * Hard ceiling on how long to wait for the daemon's InitializeResponse
   * before failing the handshake. Without this, a codex that accepts the
   * WebSocket upgrade but never replies (hang, crash mid-response, wrong
   * protocol version, …) would deadlock dispatcher startup indefinitely,
   * blocking both server boot and any retry path. Default: 10_000 ms,
   * which matches the spawn-readiness budget in CodexProcess.
   */
  timeoutMs?: number;
}

/**
 * Default cap on the initialize round-trip. See HandshakeOptions.timeoutMs.
 * 10s mirrors CodexProcess's spawn ready-probe so a hung handshake doesn't
 * outlive the codex spawn that produced it.
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Drive the full `initialize` + `initialized` exchange. Returns the
 * server's InitializeResponse (userAgent, codexHome, platform) so callers
 * can log it or surface it via admin.
 *
 * Times out (rejects) if the daemon does not reply within
 * `options.timeoutMs`. The pending request stays in the client's `pending`
 * map after timeout — callers that recover by tearing down the client
 * (e.g. CodexRuntime's cleanupOnFailure) will then drop those
 * pending entries when the WS connection closes.
 */
export async function performInitializeHandshake(
  client: CodexWsClient,
  options: HandshakeOptions = {},
): Promise<InitializeResponse> {
  const params: InitializeParams = {
    clientInfo: options.clientInfo ?? DREAMUX_CLIENT_INFO,
    capabilities:
      options.capabilities === undefined
        ? DEFAULT_CAPABILITIES
        : options.capabilities,
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const response = await withTimeout(
    client.request<InitializeResponse>('initialize', params),
    timeoutMs,
    `codex initialize handshake did not respond within ${timeoutMs}ms — the daemon may be hung, crashed mid-response, or speaking an incompatible protocol`,
  );
  // Per LSP convention the `initialized` notification carries no params.
  // codex's ClientNotification union accepts the bare `{ method: "initialized" }`
  // envelope without a `params` field.
  client.notify('initialized', undefined);
  return response;
}

/**
 * Race `p` against a timeout. Rejects with `Error(msg)` if the timeout wins.
 * The timer is `unref`ed so it doesn't keep the event loop alive on its own.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  msg: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
