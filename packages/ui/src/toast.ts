// Browser-scoped reactive toast store with automatic & cancellable dismiss timers.

import type { Signal } from '@kayjs/kay'
import type { Tone } from './static'
import { signal } from '@kayjs/kay'

export interface ToastItem {
  id: string
  title: string
  description?: string | undefined
  tone: Tone
}

interface ToastStore {
  i: Signal<ToastItem[]>
  t: Map<string, ReturnType<typeof setTimeout>>
  s: number
}

const TOAST_KEY = Symbol.for('kay.ui.toasts')
let emptyToasts: Signal<ToastItem[]> | undefined

function getToastStore(): ToastStore | undefined {
  if (typeof document === 'undefined')
    return undefined
  const host = document as unknown as Record<symbol, ToastStore | undefined>
  return (host[TOAST_KEY] ??= { i: signal<ToastItem[]>([]), t: new Map(), s: 0 })
}

function pushToast(tone: Tone, title: string, description?: string, durationMs = 4500): string {
  const s = getToastStore()
  if (!s)
    return ''
  const id = `t-${++s.s}`
  s.i.value = [...s.i.value, { id, title, description, tone }]
  if (durationMs > 0)
    s.t.set(id, setTimeout(() => toast.dismiss(id), durationMs))
  return id
}

export const toast = {
  get items(): Signal<ToastItem[]> {
    return getToastStore()?.i ?? (emptyToasts ??= signal<ToastItem[]>([]))
  },
  show: (title: string, description?: string, durationMs?: number) => pushToast('neutral', title, description, durationMs),
  info: (title: string, description?: string, durationMs?: number) => pushToast('accent', title, description, durationMs),
  success: (title: string, description?: string, durationMs?: number) => pushToast('success', title, description, durationMs),
  warning: (title: string, description?: string, durationMs?: number) => pushToast('warning', title, description, durationMs),
  danger: (title: string, description?: string, durationMs?: number) => pushToast('danger', title, description, durationMs),
  error: (title: string, description?: string, durationMs?: number) => pushToast('danger', title, description, durationMs),
  dismiss(id: string) {
    const s = getToastStore()
    if (!s)
      return
    clearTimeout(s.t.get(id))
    s.t.delete(id)
    s.i.value = s.i.value.filter(x => x.id !== id)
  },
  clear() {
    const s = getToastStore()
    if (!s)
      return
    for (const h of s.t.values())
      clearTimeout(h)
    s.t.clear()
    s.i.value = []
  },
}
