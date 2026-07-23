import type { TransportDiagnostics } from './diagnostics.js'

export const FEISHU_USER_NAME_RESOLUTION_TIMEOUT_MS = 800
export const FEISHU_CONTACT_SCOPE_MISSING_CODE = 99991672

export interface FeishuUserNameEntry {
  openId: string
  name: string
}

export interface FeishuUserNameLookupOptions {
  signal?: AbortSignal
}

export interface FeishuUserNameResolver {
  observeUserNames(entries: FeishuUserNameEntry[]): void
  resolveUserName(
    openId: string,
    options?: FeishuUserNameLookupOptions,
  ): Promise<string | undefined>
}

export interface FeishuContactUserClient {
  contact?: {
    v3?: {
      user?: {
        get?: (input: {
          path: { user_id: string }
          params: { user_id_type: 'open_id' }
        }) => Promise<{
          code?: number
          msg?: string
          data?: { user?: { name?: string } }
        }>
      }
    }
  }
}

export function createFeishuUserNameResolver(
  client: FeishuContactUserClient,
  diagnostics: TransportDiagnostics,
): FeishuUserNameResolver {
  const names = new Map<string, string>()
  const versions = new Map<string, number>()
  const inFlight = new Map<string, PendingUserNameLookup>()
  let scopeUnavailable = false

  const advanceVersion = (openId: string): number => {
    const version = (versions.get(openId) ?? 0) + 1
    versions.set(openId, version)
    return version
  }

  const observeUserNames = (entries: FeishuUserNameEntry[]): void => {
    for (const entry of entries) {
      if (entry.openId !== '' && entry.name !== '') {
        advanceVersion(entry.openId)
        names.set(entry.openId, entry.name)
      }
    }
  }

  const fetchUserName = async (
    openId: string,
  ): Promise<FeishuUserNameFetchResult> => {
    const userApi = client.contact?.v3?.user
    if (userApi?.get === undefined) return {}
    try {
      const response = await userApi.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      })
      if (response.code === FEISHU_CONTACT_SCOPE_MISSING_CODE) {
        return { scopeUnavailable: true }
      }
      if (response.code !== undefined && response.code !== 0) return {}
      const name = response.data?.user?.name
      return typeof name === 'string' && name !== '' ? { name } : {}
    } catch {
      // Sender names are optional. Transient SDK/network failures degrade for
      // this message and deliberately do not open the permission circuit.
      return {}
    }
  }

  return {
    observeUserNames,
    async resolveUserName(
      openId: string,
      options: FeishuUserNameLookupOptions = {},
    ): Promise<string | undefined> {
      if (openId === '') return undefined
      if (isAborted(options.signal)) return undefined
      const cached = names.get(openId)
      if (cached !== undefined) return cached
      if (scopeUnavailable) return undefined

      let pending = inFlight.get(openId)
      if (pending === undefined) {
        const version = advanceVersion(openId)
        const promise = fetchUserName(openId)
        pending = { promise, version }
        inFlight.set(openId, pending)
        const local = pending
        const cleanup = (): void => {
          if (inFlight.get(openId) === local) inFlight.delete(openId)
        }
        void local.promise.then(cleanup, cleanup)
      }

      let result: FeishuUserNameFetchResult
      try {
        result = await withTimeout(
          pending.promise,
          FEISHU_USER_NAME_RESOLUTION_TIMEOUT_MS,
          options.signal,
        )
      } catch {
        if (inFlight.get(openId) === pending) inFlight.delete(openId)
        return names.get(openId)
      }
      if (
        isAborted(options.signal) ||
        versions.get(openId) !== pending.version
      ) {
        return names.get(openId)
      }
      if (result.scopeUnavailable === true) {
        scopeUnavailable = true
        diagnostics.diagnostic(
          'contact:user.base:readonly is unavailable; sender-name lookup is disabled for this Feishu transport instance',
        )
      } else if (result.name !== undefined) {
        names.set(openId, result.name)
      }
      return names.get(openId)
    },
  }
}

interface PendingUserNameLookup {
  promise: Promise<FeishuUserNameFetchResult>
  version: number
}

interface FeishuUserNameFetchResult {
  name?: string
  scopeUnavailable?: boolean
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted === true) {
    return Promise.reject(new FeishuUserNameLookupAbortedError())
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => {
      finish(() => reject(new FeishuUserNameLookupAbortedError()))
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error('Feishu sender-name resolution timed out')))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    void promise.then(
      (value) => {
        finish(() => resolve(value))
      },
      (error: unknown) => {
        finish(() => reject(error))
      },
    )
  })
}

class FeishuUserNameLookupAbortedError extends Error {
  constructor() {
    super('Feishu sender-name lookup was aborted')
    this.name = 'FeishuUserNameLookupAbortedError'
  }
}
