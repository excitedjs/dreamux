import type * as lark from '@larksuiteoapi/node-sdk'

import type { TransportDiagnostics } from './diagnostics.js'

/**
 * Who this app is, as Feishu reports it.
 *
 * Both lookups are startup-time identity resolution with the same bounded
 * retry, and both degrade to a diagnostic rather than failing the transport:
 * without the bot open_id, mention-gated groups drop every message, and without
 * the app owner the channel simply cannot run owner-only flows.
 */

// application/v6 owner.type: enterprise-member owner for a custom app.
export const FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER = 2

/**
 * Raw identity of the app creator / owner, returned by
 * `GET /open-apis/application/v6/applications/{appId}` with
 * `user_id_type=open_id`.
 */
export interface FeishuAppOwnerIdentity {
  creatorOpenId?: string
  ownerOpenId?: string
  ownerType?: number
}

export interface FeishuBotInfo {
  openId?: string
  appName?: string
}

const BOT_INFO_ATTEMPTS = 3

export async function resolveBotInfo(
  client: lark.Client,
  diag: TransportDiagnostics,
): Promise<FeishuBotInfo | undefined> {
  for (let attempt = 1; attempt <= BOT_INFO_ATTEMPTS; attempt++) {
    try {
      const res = await client.request<{ bot?: { open_id?: string, app_name?: string } }>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      })
      const openId = res.bot?.open_id
      const appName = res.bot?.app_name
      if (openId) {
        return {
          openId,
          ...(appName !== undefined && appName !== '' ? { appName } : {}),
        }
      }
      diag.diagnostic(
        'bot info response carried no open_id — groups that ' +
          'require an @-mention will drop every message until the channel restarts',
      )
      return undefined
    } catch (err) {
      if (attempt < BOT_INFO_ATTEMPTS) {
        await delay(attempt * 500)
        continue
      }
      diag.diagnostic(
        `could not resolve the bot open_id after ${BOT_INFO_ATTEMPTS} ` +
          'attempts — groups that require an @-mention will drop every message ' +
          'until the channel restarts:',
        err,
      )
      return undefined
    }
  }
  return undefined
}

export async function resolveAppOwner(
  client: lark.Client,
  diag: TransportDiagnostics,
  appId: string,
): Promise<FeishuAppOwnerIdentity> {
  const identity: FeishuAppOwnerIdentity = {}
  for (let attempt = 1; attempt <= BOT_INFO_ATTEMPTS; attempt++) {
    try {
      const res = await client.request<{
        data?: {
          app?: {
            creator_id?: string
            owner?: { owner_id?: string; type?: number; owner_type?: number }
          }
        }
      }>({
        method: 'GET',
        url: `/open-apis/application/v6/applications/${encodeURIComponent(appId)}`,
        params: { lang: 'zh_cn', user_id_type: 'open_id' },
      })
      const app = res.data?.app
      if (typeof app?.creator_id === 'string' && app.creator_id !== '') {
        identity.creatorOpenId = app.creator_id
      }
      const ownerId = app?.owner?.owner_id
      const ownerType = app?.owner?.type ?? app?.owner?.owner_type
      if (typeof ownerType === 'number') identity.ownerType = ownerType
      if (
        typeof ownerId === 'string' &&
        ownerId !== '' &&
        (ownerType === undefined || ownerType === FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER)
      ) {
        identity.ownerOpenId = ownerId
      }
      return identity
    } catch (err) {
      if (attempt < BOT_INFO_ATTEMPTS) {
        await delay(attempt * 500)
        continue
      }
      diag.diagnostic(
        'could not resolve the Feishu app owner via application/v6. ' +
          'Ensure the app has scope `application:application:self_manage` ' +
          'or `admin:app.info:readonly`:',
        err,
      )
      return identity
    }
  }
  return identity
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
