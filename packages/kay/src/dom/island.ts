// Native <kay-island> Custom Element: dead-code-eliminates unused deferred/client strategies at build time.

import { hydrate, mount } from './index'

declare const KAY_DEFERRED: boolean | undefined
declare const KAY_CLIENT_ONLY: boolean | undefined

type IslandModule = { default: (props: Record<string, unknown>) => Node | DocumentFragment | null }

class KayIsland extends HTMLElement {
  _d: (() => void) | undefined
  _s = false

  connectedCallback(): void {
    if (this._s)
      return
    this._s = true

    const h = this.getAttribute('h')
    if (typeof KAY_DEFERRED === 'undefined' || KAY_DEFERRED) {
      if (h === 'visible') {
        const target = this.firstElementChild ?? this
        const io = new IntersectionObserver((entries) => {
          if (entries.some(e => e.isIntersecting)) {
            io.disconnect()
            void this._l(false)
          }
        }, { rootMargin: '200px' })
        io.observe(target)
        return
      }
      if (h === 'idle') {
        const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
        ric ? ric(() => void this._l(false)) : setTimeout(() => void this._l(false), 1)
        return
      }
      if (h === 'interaction') {
        const evs = ['pointerdown', 'focusin', 'keydown']
        const go = () => {
          for (const e of evs) this.removeEventListener(e, go, true)
          void this._l(false)
        }
        for (const e of evs) this.addEventListener(e, go, { capture: true, once: true })
        return
      }
      if (h !== null && h.startsWith('media(')) {
        const mq = matchMedia(h.slice(6, -1))
        if (mq.matches) {
          void this._l(false)
        }
        else {
          const go = () => {
            if (mq.matches) {
              mq.removeEventListener('change', go)
              void this._l(false)
            }
          }
          mq.addEventListener('change', go)
        }
        return
      }
    }

    void this._l(h === 'client')
  }

  disconnectedCallback(): void {
    // Defer disposal by a microtask so synchronous DOM moves (e.g. SPA persistent islands) stay alive!
    queueMicrotask(() => {
      if (!this.isConnected) {
        this._d?.()
        this._d = undefined
        this._s = false
      }
    })
  }

  async _l(clientOnly: boolean): Promise<void> {
    const chunk = this.getAttribute('c')
    if (!chunk)
      return

    const mod = await import(chunk) as IslandModule
    if (!this.isConnected)
      return

    const p = this.getAttribute('p')
    const props: Record<string, unknown> = p ? JSON.parse(p) : {}
    const slot = this.querySelector('kay-slot')
    if (slot !== null)
      props.children = slot
    const render = () => mod.default(props)
    this._d = (typeof KAY_CLIENT_ONLY === 'undefined' || KAY_CLIENT_ONLY) && clientOnly
      ? mount(this, render)
      : hydrate(this, render)
  }
}

export function defineIslandElement(): void {
  if (typeof customElements !== 'undefined' && !customElements.get('kay-island'))
    customElements.define('kay-island', KayIsland)
}
