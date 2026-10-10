// Loaded by every page `kay dev` serves: holding Alt outlines the element under the pointer with the `.kay` line that wrote it, Alt+click opens that line in the editor, and a button lists the page's islands with the values their signals hold.
// It runs in the browser from its own route, so it imports nothing; its elements live in a shadow root outside the body, which a page swap replaces.
const SOURCE = 'data-kay-src'
const ISLAND = 'slot[data-component]'
const OPEN_URL = '/_kay/dev/open'
// A cross-site page cannot send this header without a preflight the dev server never answers.
const OPEN_HEADER = 'x-kay-dev'
const REFRESH_MS = 500
const MAX_VALUE = 120
const MESSAGE_MS = 4000
const FONT = 'font:12px/1.5 ui-monospace,monospace'

// Set by the hot swap in development: the values an island's signals hold now, in the order its script creates them.
interface InspectedWindow {
  $kaySignals?: (island: HTMLElement) => unknown[] | undefined
}

export interface Inspector {
  // Asks the dev server to open `source` (`file:line:column`) in the editor; resolves to whether it could.
  open: (source: string) => Promise<boolean>
  stop: () => void
}

export function startInspector(doc: Document = document): Inspector {
  const win = doc.defaultView! as Window & InspectedWindow
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, css: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag)

    element.style.cssText = css

    return element
  }
  const host = make('div', 'all:initial')
  const root = host.attachShadow({ mode: 'open' })
  const outline = make('div', 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #7c3aed;background:rgba(124,58,237,.08);border-radius:2px')
  const label = make('div', `position:fixed;z-index:2147483647;pointer-events:none;padding:2px 6px;background:#7c3aed;color:#fff;border-radius:3px;white-space:nowrap;${FONT}`)
  const toggle = make('button', `position:fixed;left:.75rem;bottom:.75rem;z-index:2147483647;padding:.25rem .6rem;border:1px solid #7c3aed;border-radius:999px;background:#fff;color:#4c1d95;cursor:pointer;${FONT}`)
  const panel = make('div', `position:fixed;left:.75rem;bottom:2.75rem;z-index:2147483647;width:min(28rem,calc(100vw - 1.5rem));max-height:50vh;overflow:auto;padding:.5rem;border:1px solid #ddd;border-radius:6px;background:#fff;color:#1a1a1a;box-shadow:0 4px 16px rgba(0,0,0,.15);${FONT}`)
  let expanded = false
  let message: ReturnType<typeof setTimeout> | undefined

  host.setAttribute('data-kay-inspector', '')
  outline.hidden = true
  label.hidden = true
  panel.hidden = true
  panel.id = 'kay-islands'
  toggle.type = 'button'
  toggle.setAttribute('aria-controls', panel.id)
  toggle.setAttribute('aria-expanded', 'false')
  root.append(outline, label, panel, toggle)
  doc.documentElement.append(host)

  const show = (target: Element, text: string) => {
    const box = boundsOf(target)

    outline.hidden = false
    label.hidden = false
    outline.style.left = `${box.left}px`
    outline.style.top = `${box.top}px`
    outline.style.width = `${box.width}px`
    outline.style.height = `${box.height}px`
    label.textContent = text
    label.style.left = `${Math.max(0, box.left)}px`
    label.style.top = `${box.top > 24 ? box.top - 22 : box.bottom + 2}px`
  }
  const hide = () => {
    outline.hidden = true
    label.hidden = true
  }
  // Stays a few seconds, whatever the pointer does meanwhile.
  const say = (target: Element, text: string) => {
    show(target, text)
    clearTimeout(message)
    message = setTimeout(() => {
      message = undefined
      hide()
    }, MESSAGE_MS)
  }
  const open = async (source: string) => {
    try {
      const response = await fetch(OPEN_URL, { method: 'POST', headers: { 'content-type': 'application/json', [OPEN_HEADER]: '1' }, body: JSON.stringify({ source }) })

      return response.ok && (await response.json() as { opened?: boolean }).opened === true
    }
    catch {
      return false
    }
  }
  const openFrom = async (target: Element) => {
    const source = target.getAttribute(SOURCE)!

    if (!await open(source))
      say(target, `${source}: no editor found, set KAY_EDITOR`)
  }
  const sourceOf = (event: Event): Element | undefined => {
    if (event.composedPath().includes(host))
      return undefined

    const target = event.target instanceof Element ? event.target : undefined

    return target?.closest(`[${SOURCE}]`) ?? undefined
  }
  const onMove = (event: PointerEvent) => {
    const target = event.altKey ? sourceOf(event) : undefined

    if (target)
      show(target, `${target.localName}  ${target.getAttribute(SOURCE)}`)
    else if (message === undefined)
      hide()
  }
  const onClick = (event: MouseEvent) => {
    const target = event.altKey ? sourceOf(event) : undefined

    if (!target)
      return

    // Alt+click on a link would download it.
    event.preventDefault()
    event.stopImmediatePropagation()

    void openFrom(target)
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Alt' && event.type === 'keyup')
      hide()
  }
  const islands = () => [...doc.querySelectorAll<HTMLElement>(ISLAND)]
  const note = (text: string) => {
    const element = make('div', 'color:#666')

    element.textContent = text

    return element
  }
  const render = () => {
    const found = islands()

    toggle.hidden = found.length === 0
    toggle.textContent = `${found.length} island${found.length === 1 ? '' : 's'}`

    if (!expanded)
      return

    panel.replaceChildren(...found.map((island) => {
      const row = make('div', 'padding:.25rem .25rem .5rem;border-bottom:1px solid #eee')
      const name = make('button', `padding:0;border:0;background:none;color:#4c1d95;cursor:pointer;text-decoration:underline;${FONT}`)
      const component = island.dataset.component ?? '?'

      name.type = 'button'
      name.textContent = component
      name.onclick = () => void open(`${component}:1:1`)
      row.append(name)
      row.onpointerenter = () => show(island, component)
      row.onpointerleave = hide

      const values = win.$kaySignals?.(island)

      if (values === undefined)
        row.append(note('not hydrated'))

      for (const [index, value] of (values ?? []).entries()) {
        const line = make('div', 'white-space:pre-wrap;word-break:break-all')

        line.textContent = `#${index + 1} ${formatted(value)}`
        row.append(line)
      }

      if (values?.length === 0)
        row.append(note('no signals'))

      return row
    }))
  }

  toggle.onclick = () => {
    expanded = !expanded
    panel.hidden = !expanded
    toggle.setAttribute('aria-expanded', String(expanded))
    render()
  }
  render()
  const refresh = setInterval(render, REFRESH_MS)

  win.addEventListener('pointermove', onMove, true)
  win.addEventListener('click', onClick, true)
  win.addEventListener('keyup', onKey, true)
  win.addEventListener('blur', hide)

  return {
    open,
    stop: () => {
      clearInterval(refresh)
      clearTimeout(message)
      win.removeEventListener('pointermove', onMove, true)
      win.removeEventListener('click', onClick, true)
      win.removeEventListener('keyup', onKey, true)
      win.removeEventListener('blur', hide)
      host.remove()
    },
  }
}

// An island's slot lays out as its contents, so its box is theirs.
function boundsOf(target: Element): DOMRect {
  const rect = target.getBoundingClientRect()

  if (rect.width > 0 || rect.height > 0 || target.children.length === 0)
    return rect

  const boxes = [...target.children].map(child => boundsOf(child))
  const left = Math.min(...boxes.map(box => box.left))
  const top = Math.min(...boxes.map(box => box.top))

  return new DOMRect(left, top, Math.max(...boxes.map(box => box.right)) - left, Math.max(...boxes.map(box => box.bottom)) - top)
}

function formatted(value: unknown): string {
  let text: string

  try {
    text = typeof value === 'function' ? 'function' : value instanceof Element ? `<${value.localName}>` : JSON.stringify(value) ?? String(value)
  }
  catch {
    text = String(value)
  }

  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}...` : text
}
