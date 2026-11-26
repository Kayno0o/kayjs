// Native <kay-island> Custom Element: the build defines which strategies an app uses, so the loader drops the code of the others.

import { hydrate, mount } from './index'


declare const KAY_VISIBLE: boolean | undefined
declare const KAY_IDLE: boolean | undefined
declare const KAY_INTERACTION: boolean | undefined
declare const KAY_MEDIA: boolean | undefined
declare const KAY_CLIENT_ONLY: boolean | undefined
/** The URL `kay build` gave the prop revivers; left undefined, they load from source. */
declare const KAY_REVIVE: string | undefined

// Only props holding a Date, Map, Set or another tagged value load the revivers: plain JSON parses with no extra file.
const reviver = (): Promise<typeof import('./revive')> => typeof KAY_REVIVE === 'undefined' ? import('./revive') : import(KAY_REVIVE)

type IslandModule = { default: (props: Record<string, unknown>) => Node | DocumentFragment | null }

/** Finds this island's own `<script type="application/json" data-kay-props>` direct child. */
function findOwnPropsScript(root: Element): Element | null {
  for (let child = root.lastElementChild; child !== null; child = child.previousElementSibling) {
    if (child.tagName === 'SCRIPT' && child.hasAttribute('data-kay-props'))
      return child
  }
  return null
}

/** Finds this island's own `<kay-slot>` without descending into nested `<kay-island>` boundaries. */
function findOwnSlot(root: Element): Element | null {
  for (let child = root.firstElementChild; child !== null; child = child.nextElementSibling) {
    const tag = child.tagName
    if (tag === 'KAY-SLOT')
      return child
    if (tag === 'KAY-ISLAND')
      continue
    const nested = findOwnSlot(child)
    if (nested !== null)
      return nested
  }
  return null
}

function extractOwnSlot(root: Element): Element | null {
  for (let child = root.lastElementChild; child !== null; child = child.previousElementSibling) {
    if (child.tagName === 'TEMPLATE' && child.hasAttribute('data-kay-slot')) {
      const slot = document.createElement('kay-slot')
      slot.appendChild((child as HTMLTemplateElement).content)
      child.remove()
      return slot
    }
  }
  return findOwnSlot(root)
}

/** Collects box-generating descendant elements for IntersectionObserver, stepping through `display: contents` wrappers. */
function collectVisibleTargets(root: Element, out: Element[]): void {
  for (let child = root.firstElementChild; child !== null; child = child.nextElementSibling) {
    const tag = child.tagName
    if (tag === 'SCRIPT' || tag === 'TEMPLATE')
      continue
    const isContents = tag === 'KAY-SLOT'
      || tag === 'KAY-ISLAND'
      || (typeof getComputedStyle === 'function' && getComputedStyle(child).display === 'contents')
    if (isContents)
      collectVisibleTargets(child, out)
    else
      out.push(child)
  }
}

function replayEvent(root: Element, ev: Event, target: EventTarget | null): void {
  if (target === null || typeof target.dispatchEvent !== 'function')
    return
  if (typeof (target as Node).nodeType === 'number' && !root.contains(target as Node))
    return
  const init: EventInit = { bubbles: ev.bubbles, cancelable: ev.cancelable, composed: ev.composed }
  let clone: Event
  if (ev.type === 'keydown') {
    const ke = ev as KeyboardEvent
    clone = new KeyboardEvent(ev.type, { ...init, key: ke.key, code: ke.code, altKey: ke.altKey, ctrlKey: ke.ctrlKey, shiftKey: ke.shiftKey, metaKey: ke.metaKey })
  }
  else if (ev.type === 'click' || ev.type === 'pointerdown') {
    const me = ev as MouseEvent
    const Ctor = ev.type === 'pointerdown' && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
    clone = new Ctor(ev.type, { ...init, button: me.button, buttons: me.buttons, clientX: me.clientX, clientY: me.clientY, altKey: me.altKey, ctrlKey: me.ctrlKey, shiftKey: me.shiftKey, metaKey: me.metaKey })
  }
  else {
    clone = typeof FocusEvent === 'function' ? new FocusEvent(ev.type, init) : new Event(ev.type, init)
  }
  target.dispatchEvent(clone)
}

function isAllowedChunkUrl(chunk: string): boolean {
  // A browser reads `//host` and `/\host` as another site.
  if (chunk[0] === '/')
    return chunk[1] !== '/' && chunk[1] !== '\\'
  if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') {
    try {
      const parsed = new URL(chunk, location.href)
      return parsed.origin === location.origin
    }
    catch {
      return false
    }
  }
  return !/^(?:javascript|data|vbscript):/i.test(chunk)
}

let clientIslandIdSeq = 0

export function defineIslandElement(): void {
  if (typeof customElements === 'undefined' || customElements.get('kay-island'))
    return

  class KayIsland extends HTMLElement {
    _d: (() => void) | undefined
    _c: (() => void) | undefined
    _p: string | undefined
    _slot: Element | undefined
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
      if ((typeof KAY_VISIBLE === 'undefined' || KAY_VISIBLE) && h === 'visible') {
        if (typeof IntersectionObserver === 'undefined') {
          void this._l(false, token)
          return
        }
        const targets: Element[] = []
        collectVisibleTargets(this, targets)
        let restoreDisplay: (() => void) | undefined
        if (targets.length === 0) {
          const display = typeof getComputedStyle === 'function' ? getComputedStyle(this).display : 'contents'
          if (display === 'contents' || display === '') {
            const prev = this.style.display
            this.style.display = 'inline'
            restoreDisplay = () => { this.style.display = prev }
          }
          targets.push(this)
        }
        const io = new IntersectionObserver((entries) => {
          if (entries.some(e => e.isIntersecting))
            void this._l(false, token)
        }, { rootMargin: '200px' })
        this._c = () => {
          io.disconnect()
          restoreDisplay?.()
        }
        for (const target of targets)
          io.observe(target)
        return
      }
      if ((typeof KAY_IDLE === 'undefined' || KAY_IDLE) && h === 'idle') {
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
      if ((typeof KAY_INTERACTION === 'undefined' || KAY_INTERACTION) && h === 'interaction') {
        const evs = ['pointerdown', 'click', 'focusin', 'keydown']
        const queued: { ev: Event, target: EventTarget | null }[] = []
        let loading = false
        const stop = () => {
          for (const e of evs) this.removeEventListener(e, go, true)
        }
        const go = (ev: Event) => {
          queued.push({ ev, target: ev.target })
          if (!loading) {
            loading = true
            void this._l(false, token, true, () => {
              for (let i = 0; i < queued.length; i++)
                replayEvent(this, queued[i]!.ev, queued[i]!.target)
            })
          }
        }
        for (const e of evs) this.addEventListener(e, go, true)
        this._c = stop
        return
      }
      if ((typeof KAY_MEDIA === 'undefined' || KAY_MEDIA) && h !== null && h.startsWith('media(')) {
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

    async _l(clientOnly: boolean, token: number, keepStrategy = false, after?: () => void): Promise<void> {
      if (!keepStrategy)
        this._clearStrategy()
      const chunk = this.getAttribute('c')
      if (!chunk || !isAllowedChunkUrl(chunk) || token !== this._t || !this.isConnected || this._d !== undefined) {
        this._clearStrategy()
        return
      }

      let dispose: (() => void) | undefined
      let mod: IslandModule | undefined
      try {
        const ps = findOwnPropsScript(this)
        if (ps !== null) {
          this._p = ps.textContent || '{}'
          ps.remove()
        }
        const raw = this._p ?? this.getAttribute('p')
        const [loaded, revive] = await Promise.all([import(chunk) as Promise<IslandModule>, raw?.includes('"__k":') ? reviver() : undefined])
        mod = loaded
        if (!this.isConnected || token !== this._t || this._d !== undefined) {
          this._clearStrategy()
          return
        }
        this._clearStrategy()

        const props = (raw ? revive?.parseIslandProps(raw) ?? JSON.parse(raw) : {}) as Record<string, unknown>
        const slot = extractOwnSlot(this) ?? this._slot ?? null
        if (slot !== null) {
          this._slot = slot
          props.children = slot
        }
        const idPrefix = this.getAttribute('i') ?? `c${clientIslandIdSeq++}-`
        const render = () => loaded.default(props)
        dispose = (typeof KAY_CLIENT_ONLY === 'undefined' || KAY_CLIENT_ONLY) && clientOnly
          ? mount(this, render, idPrefix)
          : hydrate(this, render, idPrefix)
        if (!this.isConnected || token !== this._t) {
          dispose()
          return
        }
        this._d = dispose
        after?.()
      }
      catch (err) {
        this._clearStrategy()
        dispose?.()
        // The chunk URL is a hash; in dev the component's own name says which island failed.
        console.error(`[kay-island] failed to hydrate ${process.env.NODE_ENV !== 'production' && mod?.default?.name ? `<${mod.default.name}> (${chunk})` : chunk}:`, err)
      }
    }
  }

  customElements.define('kay-island', KayIsland)
}
