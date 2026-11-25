// Native <kay-island> Custom Element: dead-code-eliminates unused deferred/client strategies at build time.

import { hydrate, mount } from './index'

declare const KAY_DEFERRED: boolean | undefined
declare const KAY_CLIENT_ONLY: boolean | undefined

const REVIVERS: Record<string, (v: never) => unknown> = {
  __proto__: null as never,
  D: (v: string) => new Date(v),
  S: (v: unknown[]) => new Set(v),
  M: (v: [unknown, unknown][]) => new Map(v),
  U: (v: string) => new URL(v),
  R: ([src, flags]: [string, string]) => new RegExp(src, flags),
  B: (v: string) => BigInt(v),
}

export function parseIslandProps(raw: string): Record<string, unknown> {
  if (!raw.includes('"__k":'))
    return JSON.parse(raw) as Record<string, unknown>
  return JSON.parse(raw, (_k, v: unknown) => {
    if (v !== null && typeof v === 'object' && '__k' in v && 'v' in v) {
      const revive = REVIVERS[(v as { __k: string }).__k]
      if (revive !== undefined)
        return revive((v as { v: never }).v)
    }
    return v
  }) as Record<string, unknown>
}

type IslandModule = { default: (props: Record<string, unknown>) => Node | DocumentFragment | null }

export function defineIslandElement(): void {
  if (typeof customElements === 'undefined' || customElements.get('kay-island'))
    return

  class KayIsland extends HTMLElement {
    _d: (() => void) | undefined
    _c: (() => void) | undefined
    _s = false
    _t = 0

    _clearStrategy(): void {
      this._c?.()
      this._c = undefined
    }

    connectedCallback(): void {
      if (this._s)
        return
      this._s = true
      const token = ++this._t

      const h = this.getAttribute('h')
      if (typeof KAY_DEFERRED === 'undefined' || KAY_DEFERRED) {
        if (h === 'visible') {
          const target = this.firstElementChild ?? this
          const io = new IntersectionObserver((entries) => {
            if (entries.some(e => e.isIntersecting))
              void this._l(false, token)
          }, { rootMargin: '200px' })
          this._c = () => io.disconnect()
          io.observe(target)
          return
        }
        if (h === 'idle') {
          const g = globalThis as { requestIdleCallback?: (cb: () => void) => number, cancelIdleCallback?: (id: number) => void }
          const run = () => void this._l(false, token)
          if (g.requestIdleCallback) {
            const id = g.requestIdleCallback(run)
            this._c = () => g.cancelIdleCallback?.(id)
          }
          else {
            const id = setTimeout(run, 1)
            this._c = () => clearTimeout(id)
          }
          return
        }
        if (h === 'interaction') {
          const evs = ['pointerdown', 'focusin', 'keydown']
          const stop = () => {
            for (const e of evs) this.removeEventListener(e, go, true)
          }
          const go = () => void this._l(false, token)
          for (const e of evs) this.addEventListener(e, go, { capture: true, once: true })
          this._c = stop
          return
        }
        if (h !== null && h.startsWith('media(')) {
          const mq = matchMedia(h.slice(6, -1))
          if (mq.matches) {
            void this._l(false, token)
          }
          else {
            const go = () => {
              if (mq.matches)
                void this._l(false, token)
            }
            mq.addEventListener('change', go)
            this._c = () => mq.removeEventListener('change', go)
          }
          return
        }
      }

      void this._l(h === 'client', token)
    }

    disconnectedCallback(): void {
      // Defer disposal by a microtask so synchronous DOM moves (e.g. SPA persistent islands) stay alive!
      queueMicrotask(() => {
        if (!this.isConnected) {
          this._t++
          this._clearStrategy()
          this._d?.()
          this._d = undefined
          this._s = false
        }
      })
    }

    async _l(clientOnly: boolean, token: number): Promise<void> {
      this._clearStrategy()
      const chunk = this.getAttribute('c')
      if (!chunk || token !== this._t || !this.isConnected || this._d !== undefined)
        return

      let dispose: (() => void) | undefined
      try {
        const mod = await import(chunk) as IslandModule
        if (!this.isConnected || token !== this._t || this._d !== undefined)
          return

        const p = this.getAttribute('p')
        const props: Record<string, unknown> = p ? parseIslandProps(p) : {}
        const slot = this.querySelector('kay-slot')
        if (slot !== null)
          props.children = slot
        const render = () => mod.default(props)
        dispose = (typeof KAY_CLIENT_ONLY === 'undefined' || KAY_CLIENT_ONLY) && clientOnly
          ? mount(this, render)
          : hydrate(this, render)
        if (!this.isConnected || token !== this._t) {
          dispose()
          return
        }
        this._d = dispose
      }
      catch (err) {
        dispose?.()
        console.error(`[kay-island] failed to hydrate ${chunk}:`, err)
      }
    }
  }

  customElements.define('kay-island', KayIsland)
}
