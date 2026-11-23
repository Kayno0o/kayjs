// Browser client helper for @kayjs/live SSE rooms (~35 LOC, zero dependencies).

import type { Signal } from 'kay'
import { onMount, signal } from 'kay'

export type LiveStatus = 'connecting' | 'open' | 'closed'

export interface LiveConnection<TMessage> {
  readonly status: Signal<LiveStatus>
  readonly last: Signal<TMessage | undefined>
  close(): void
}

export function useLive<TMessage>(
  url: string,
  onMessage?: (message: TMessage) => void,
): LiveConnection<TMessage> {
  const status = signal<LiveStatus>('connecting')
  const last = signal<TMessage | undefined>(undefined)
  let source: EventSource | undefined

  const close = () => {
    source?.close()
    source = undefined
    status.value = 'closed'
  }

  onMount(() => {
    const es = new EventSource(url)
    source = es
    es.onopen = () => {
      status.value = 'open'
    }
    es.onerror = () => {
      status.value = es.readyState === EventSource.CLOSED ? 'closed' : 'connecting'
    }
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as TMessage
        last.value = parsed
        onMessage?.(parsed)
      }
      catch {}
    }
    return close
  })

  return { status, last, close }
}
