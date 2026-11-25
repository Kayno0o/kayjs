// Browser client helper for @kayjs/live SSE rooms (~65 LOC, zero dependencies).

import type { Signal } from 'kay'
import { onMount, signal } from 'kay'

export type LiveStatus = 'connecting' | 'open' | 'closed'

export interface LiveConnection<TMessage> {
  readonly status: Signal<LiveStatus>
  readonly last: Signal<TMessage | undefined>
  close(): void
}

export interface UseLiveOptions {
  /** Base reconnect delay in milliseconds after EventSource enters CLOSED state (default: 1000). */
  baseDelayMs?: number | undefined
  /** Maximum exponential backoff delay in milliseconds before jitter (default: 30000). */
  maxDelayMs?: number | undefined
  /** Maximum random jitter added in milliseconds (default: 30% of current delay). */
  jitterMs?: number | undefined
  /** Named SSE `event:` types to listen for in addition to default unnamed `message` events. */
  events?: readonly string[] | undefined
  /** Send cookies / credentials on cross-origin EventSource connections. */
  withCredentials?: boolean | undefined
}

const DEFAULT_BASE_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 30_000

export function useLive<TMessage>(
  url: string,
  onMessage?: (message: TMessage) => void,
  options?: UseLiveOptions,
): LiveConnection<TMessage> {
  const status = signal<LiveStatus>('connecting')
  const last = signal<TMessage | undefined>(undefined)
  let source: EventSource | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let manuallyClosed = false

  const clearReconnectTimer = () => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
  }

  const close = () => {
    manuallyClosed = true
    clearReconnectTimer()
    source?.close()
    source = undefined
    status.value = 'closed'
  }

  const connect = () => {
    if (manuallyClosed)
      return
    clearReconnectTimer()
    status.value = 'connecting'
    const es = options?.withCredentials !== undefined
      ? new EventSource(url, { withCredentials: options.withCredentials })
      : new EventSource(url)
    source = es

    es.onopen = () => {
      if (source !== es || manuallyClosed)
        return
      attempt = 0
      status.value = 'open'
    }

    es.onerror = () => {
      if (source !== es || manuallyClosed)
        return
      if (es.readyState === EventSource.CLOSED) {
        status.value = 'closed'
        source = undefined
        const base = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
        const max = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
        const exp = Math.min(max, base * 2 ** attempt)
        attempt++
        const maxJitter = options?.jitterMs ?? Math.max(1, Math.floor(exp * 0.3))
        const jitter = maxJitter > 0 ? Math.floor(Math.random() * maxJitter) : 0
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined
          connect()
        }, exp + jitter)
      }
      else {
        status.value = 'connecting'
      }
    }

    const handleEvent = (ev: Event) => {
      if (source !== es || manuallyClosed)
        return
      try {
        const parsed = JSON.parse((ev as MessageEvent<string>).data) as TMessage
        last.value = parsed
        onMessage?.(parsed)
      }
      catch {}
    }

    es.onmessage = handleEvent
    if (options?.events !== undefined) {
      for (const name of options.events)
        es.addEventListener(name, handleEvent)
    }
  }

  onMount(() => {
    manuallyClosed = false
    connect()
    return close
  })

  return { status, last, close }
}
