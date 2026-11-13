import type * as lark from '@larksuiteoapi/node-sdk';

import type { TransportDiagnostics } from './diagnostics.js';

/**
 * Who this app is, as Feishu reports it.
 *
 * Both lookups retry the same way and both degrade to a diagnostic rather than
 * failing the transport: a caller that gets no answer can still run, it just
 * loses the capability that answer enables.
 *
 * Bot identity additionally stays recoverable after a failed startup: only a
 * non-empty `open_id` is cached, so `createSelfIdentityCache` retries on a
 * caller's explicit request (`ensureSelfIdentity`).
 *
 * Both lookups are bounded end to end, not merely per HTTP call: the SDK makes
 * more than one call per request (a tenant-token exchange precedes it) and owns
 * those calls, so only a deadline around the whole lookup bounds it.
 */

// application/v6 owner.type: enterprise-member owner for a custom app.
export const FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER = 2;

/**
 * Raw identity of the app creator / owner, returned by
 * `GET /open-apis/application/v6/applications/{appId}` with
 * `user_id_type=open_id`.
 */
export interface FeishuAppOwnerIdentity {
  creatorOpenId?: string;
  ownerOpenId?: string;
  ownerType?: number;
}

export interface FeishuBotInfo {
  openId?: string;
  appName?: string | undefined;
}

const BOT_INFO_ATTEMPTS = 3;

/**
 * How long one request may take before it counts as a failed attempt.
 *
 * The Lark SDK builds its client from a bare `axios.create()`, whose timeout is
 * zero — no limit at all, on the outer call *and* on the tenant-token exchange
 * it performs first. An endpoint that accepts the connection and then never
 * answers would park either one indefinitely.
 *
 * Deliberately well under the whole lookup's ceiling: a per-request timeout at
 * the ceiling would mean the first attempt consumes the entire budget and the
 * retries never run, which is the opposite of what a retry is for.
 */
const LOOKUP_REQUEST_TIMEOUT_MS = 2_000;

/**
 * The whole lookup's ceiling, across every attempt and its backoff.
 *
 * A per-request timeout alone cannot bound this: the SDK may make more than one
 * HTTP call per request (the token exchange precedes the call itself), and it
 * owns those calls, not us. This deadline is what a caller can actually rely
 * on, and it is chosen against a budget this package does not own: the host
 * gives a signal-initiated shutdown fifteen seconds before it exits, and the
 * channel session spends up to five of those draining its card writer before it
 * reaches the work this lookup runs in. Ten seconds would consume the rest with
 * nothing left for the closes that follow, so the ceiling is half of that.
 */
const LOOKUP_DEADLINE_MS = 5_000;

/**
 * Run `lookup`, giving up at `deadlineMs` whatever it is doing.
 *
 * The timer is not unref'd: this promise is awaited by a caller that needs an
 * answer, and a pending lookup holding the loop open for its own ceiling is the
 * honest behaviour.
 *
 * Giving up is reported through `diag`, because it is otherwise invisible: the
 * caller sees only "no answer", the same thing a healthy-but-empty response
 * looks like, and the abandoned lookup's own diagnostics — if it ever finishes —
 * describe a later failure than the one that actually cost the answer.
 */
async function withDeadline<T>(
  deadlineMs: number,
  label: string,
  diag: TransportDiagnostics,
  lookup: () => Promise<T>,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      diag.diagnostic(
        `${label} did not answer within ${deadlineMs}ms — giving up on it; ` +
          'the caller gets no answer and will retry on its own next request',
      );
      resolve(undefined);
    }, deadlineMs);
  });
  try {
    return await Promise.race([lookup(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function resolveBotInfo(
  client: lark.Client,
  diag: TransportDiagnostics,
): Promise<FeishuBotInfo | undefined> {
  return await withDeadline(
    LOOKUP_DEADLINE_MS,
    'the bot-info lookup',
    diag,
    () => resolveBotInfoAttempts(client, diag),
  );
}

async function resolveBotInfoAttempts(
  client: lark.Client,
  diag: TransportDiagnostics,
): Promise<FeishuBotInfo | undefined> {
  for (let attempt = 1; attempt <= BOT_INFO_ATTEMPTS; attempt++) {
    try {
      const res = await client.request<{
        bot?: { open_id?: string; app_name?: string };
      }>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
        timeout: LOOKUP_REQUEST_TIMEOUT_MS,
      });
      const openId = res.bot?.open_id;
      const appName = res.bot?.app_name;
      if (openId) {
        return {
          openId,
          appName:
            appName !== undefined && appName !== '' ? appName : undefined,
        };
      }
      diag.diagnostic(
        'bot info response carried no open_id — identity stays unresolved, so ' +
          'a caller can retry it; anything that needs this app to know its own ' +
          'open_id has no answer until one succeeds',
      );
      return undefined;
    } catch (err) {
      if (attempt < BOT_INFO_ATTEMPTS) {
        await delay(attempt * 500);
        continue;
      }
      diag.diagnostic(
        `could not resolve the bot open_id after ${BOT_INFO_ATTEMPTS} ` +
          'attempts — identity stays unresolved, so a caller can retry it; ' +
          'anything that needs this app to know its own open_id has no answer ' +
          'until one succeeds:',
        err,
      );
      return undefined;
    }
  }
  return undefined;
}

/**
 * Process-local self identity for the running app.
 *
 * Only a lookup that returned a non-empty `open_id` is cached; a failed or
 * empty lookup is not an answer, so identity stays unresolved and the next
 * inbound chat message retries it. Concurrent messages share the one in-flight
 * lookup. There is no negative cache, timer, background loop, or persisted
 * state — the cache holds a success or nothing.
 */
export interface FeishuSelfIdentityCache {
  /** The cached identity, or `undefined` while it is still unresolved. */
  readonly resolved: FeishuBotInfo | undefined;
  /** Resolve while unresolved, sharing one in-flight bot-info lookup. */
  ensureResolved(): Promise<void>;
}

export function createSelfIdentityCache(
  client: lark.Client,
  diag: TransportDiagnostics,
): FeishuSelfIdentityCache {
  let resolved: FeishuBotInfo | undefined;
  let inFlight: Promise<void> | undefined;

  return {
    get resolved(): FeishuBotInfo | undefined {
      return resolved;
    },

    ensureResolved(): Promise<void> {
      if (resolved !== undefined) return Promise.resolve();
      inFlight ??= resolveBotInfo(client, diag)
        .then((info) => {
          if (info?.openId !== undefined && info.openId !== '') resolved = info;
        })
        // `resolveBotInfo` already reports its own failures; a lookup must
        // never turn into a rejected inbound dispatch.
        .catch(() => undefined)
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}

export async function resolveAppOwner(
  client: lark.Client,
  diag: TransportDiagnostics,
  appId: string,
): Promise<FeishuAppOwnerIdentity> {
  const resolved = await withDeadline(
    LOOKUP_DEADLINE_MS,
    'the app-owner lookup',
    diag,
    () => resolveAppOwnerAttempts(client, diag, appId),
  );
  // A deadline expiry rejects rather than answering `{}`. The empty identity
  // means "Feishu says this app has no owner", which a caller renders as a
  // configuration defect; a lookup that never answered is a transient failure
  // and has to be told apart from it, or a slow endpoint tells an operator to
  // go fix an app that is fine.
  if (resolved === undefined) {
    throw new Error(
      `the app-owner lookup did not answer within ${LOOKUP_DEADLINE_MS}ms`,
    );
  }
  return resolved;
}

async function resolveAppOwnerAttempts(
  client: lark.Client,
  diag: TransportDiagnostics,
  appId: string,
): Promise<FeishuAppOwnerIdentity> {
  const identity: FeishuAppOwnerIdentity = {};
  for (let attempt = 1; attempt <= BOT_INFO_ATTEMPTS; attempt++) {
    try {
      const res = await client.request<{
        data?: {
          app?: {
            creator_id?: string;
            owner?: { owner_id?: string; type?: number; owner_type?: number };
          };
        };
      }>({
        method: 'GET',
        url: `/open-apis/application/v6/applications/${encodeURIComponent(appId)}`,
        params: { lang: 'zh_cn', user_id_type: 'open_id' },
        timeout: LOOKUP_REQUEST_TIMEOUT_MS,
      });
      const app = res.data?.app;
      if (typeof app?.creator_id === 'string' && app.creator_id !== '') {
        identity.creatorOpenId = app.creator_id;
      }
      const ownerId = app?.owner?.owner_id;
      const ownerType = app?.owner?.type ?? app?.owner?.owner_type;
      if (typeof ownerType === 'number') identity.ownerType = ownerType;
      if (
        typeof ownerId === 'string' &&
        ownerId !== '' &&
        (ownerType === undefined ||
          ownerType === FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER)
      ) {
        identity.ownerOpenId = ownerId;
      }
      return identity;
    } catch (err) {
      if (attempt < BOT_INFO_ATTEMPTS) {
        await delay(attempt * 500);
        continue;
      }
      diag.diagnostic(
        'could not resolve the Feishu app owner via application/v6. ' +
          'Ensure the app has scope `application:application:self_manage` ' +
          'or `admin:app.info:readonly`:',
        err,
      );
      return identity;
    }
  }
  return identity;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
