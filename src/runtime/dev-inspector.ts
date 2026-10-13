// Loaded by every page `kay dev` serves, into the dev tool: holding Alt, or turning on Inspect, outlines the element under the pointer with the `.kay` line that wrote it, and a click opens that line in the editor; the Islands tab lists the page's islands with the values their signals hold.
// It runs in the browser from its own route, so it imports types only.
import type { DevTool } from './dev-tool'

const SOURCE = 'data-kay-src'
// markers.ts's ISLAND, copied as this file imports nothing.
const ISLAND = 'slot[data-component]'
const OPEN_URL = '/_kay/dev/open'
// A cross-site page cannot send this header without a preflight the dev server never answers.
const OPEN_HEADER = 'x-kay-dev'
const REFRESH_MS = 500
const MAX_VALUE = 120
const MESSAGE_MS = 4000

// Set by the hot swap in development: the values an island's signals hold now, in the order its script creates them.
interface InspectedWindow {
  $kaySignals?: (island: HTMLElement) => unknown[] | undefined
}

// What the dev server did with a position the inspector asked it to open.
type Opened = 'opened' | 'no editor' | 'failed' | 'unknown file' | 'unreachable'

const FAILURES: Record<Exclude<Opened, 'opened'>, string> = {
  'no editor': 'no editor found, set KAY_EDITOR',
  'failed': 'the editor failed to open it, see the kay dev terminal',
  'unknown file': 'not a .kay file of this project',
  'unreachable': 'kay dev did not answer',
}

export interface Inspector {
  // Asks the dev server to open `source` (`file:line:column`) in the editor.
  open: (source: string) => Promise<Opened>
  stop: () => void
}

export function startInspector(tool: DevTool, doc: Document = document): Inspector {
  const win = doc.defaultView! as Window & InspectedWindow
  const host = tool.root.host
  const outline = tool.make('div', 'outline')
  const label = tool.make('div', 'label mono')
  const inspect = tool.button('Inspect', 'Inspect an element: click it to open its line')
  const islandsTab = tool.tab({ id: 'islands', label: 'Islands', summary: count => `${count} island${count === 1 ? '' : 's'}`, shown: () => watch(true), hidden: () => watch(false) })
  const panel = islandsTab.panel
  let inspecting = false
  // What the panel shows: rebuilt only when it changed, so a click, a selection or the focus inside it survives the refresh.
  let shown: { islands: HTMLElement[], text: string } | undefined
  let message: ReturnType<typeof setTimeout> | undefined
  let refresh: ReturnType<typeof setInterval> | undefined
  // Where the pointer last was, so pressing Alt outlines what it rests on without waiting for it to move.
  let pointer: { x: number, y: number } | undefined

  outline.hidden = true
  label.hidden = true
  inspect.setAttribute('aria-pressed', 'false')
  panel.classList.add('mono')
  tool.root.append(outline, label)

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
  const open = async (source: string): Promise<Opened> => {
    try {
      const response = await fetch(OPEN_URL, { method: 'POST', headers: { 'content-type': 'application/json', [OPEN_HEADER]: '1' }, body: JSON.stringify({ source }) })

      if (response.status === 404)
        return 'unknown file'

      if (!response.ok)
        return 'no editor'

      const answer = await response.json() as { opened?: boolean, failed?: boolean }

      return answer.opened === true ? 'opened' : answer.failed === true ? 'failed' : 'no editor'
    }
    catch {
      return 'unreachable'
    }
  }
  const openFrom = async (target: Element, source: string) => {
    const opened = await open(source)

    if (opened !== 'opened')
      say(target, `${source}: ${FAILURES[opened]}`)
  }
  const sourceOf = (event: Event): Element | undefined => {
    if (event.composedPath().includes(host))
      return undefined

    const target = event.target instanceof Element ? event.target : undefined

    return target?.closest(`[${SOURCE}]`) ?? undefined
  }
  const outlined = (target: Element | undefined) => {
    if (target)
      show(target, `${target.localName}  ${target.getAttribute(SOURCE)}`)
    else if (message === undefined)
      hide()
  }
  const setInspecting = (on: boolean) => {
    inspecting = on
    inspect.setAttribute('aria-pressed', String(on))
    doc.documentElement.style.cursor = on ? 'crosshair' : ''

    if (!on && message === undefined)
      hide()
  }
  const onMove = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY }
    outlined(event.altKey || inspecting ? sourceOf(event) : undefined)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && inspecting) {
      setInspecting(false)

      return
    }

    if (event.key !== 'Alt' || event.repeat || !pointer)
      return

    const under = doc.elementFromPoint(pointer.x, pointer.y)

    outlined(under === host ? undefined : under?.closest(`[${SOURCE}]`) ?? undefined)
  }
  const onClick = (event: MouseEvent) => {
    if (event.composedPath().includes(host))
      return

    const target = event.altKey || inspecting ? sourceOf(event) : undefined

    // A click while inspecting is the inspector's, whatever it lands on.
    if (inspecting) {
      event.preventDefault()
      event.stopImmediatePropagation()
      setInspecting(false)
    }

    if (!target)
      return

    // Alt+click on a link would download it.
    event.preventDefault()
    event.stopImmediatePropagation()

    void openFrom(target, target.getAttribute(SOURCE)!)
  }
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === 'Alt' && !inspecting)
      hide()
  }

  const islands = () => [...doc.querySelectorAll<HTMLElement>(ISLAND)]
  const render = () => {
    const found = islands()

    islandsTab.count(found.length)

    if (panel.hidden !== false)
      return

    const rows = found.map(island => ({ island, component: island.dataset.component ?? '?', values: win.$kaySignals?.(island)?.map(formatted) }))
    const text = JSON.stringify(rows.map(({ component, values }) => [component, values]))

    if (shown?.text === text && shown.islands.length === found.length && shown.islands.every((island, index) => island === found[index]))
      return

    shown = { islands: found, text }
    hide()

    if (rows.length === 0) {
      panel.replaceChildren(tool.make('div', 'empty', 'No islands on this page.'))

      return
    }

    panel.replaceChildren(...rows.map(({ island, component, values }) => {
      const row = tool.make('div', 'row')
      const name = tool.make('button', 'link', component)

      name.type = 'button'
      name.onclick = () => void openFrom(island, `${component}:1:1`)
      row.append(name)
      row.onpointerenter = () => show(island, component)
      row.onpointerleave = hide

      if (values === undefined)
        row.append(tool.make('div', 'note', 'not hydrated'))

      for (const [index, value] of (values ?? []).entries())
        row.append(tool.make('div', 'value', `#${index + 1} ${value}`))

      if (values?.length === 0)
        row.append(tool.make('div', 'note', 'no signals'))

      return row
    }))
  }

  // Polls the islands' values only while their tab shows; the count follows each page swap otherwise.
  function watch(on: boolean) {
    clearInterval(refresh)
    refresh = undefined
    shown = undefined

    if (on) {
      refresh = setInterval(render, REFRESH_MS)
      render()
    }
  }

  const swaps = new MutationObserver(() => {
    if (!doc.documentElement.hasAttribute('aria-busy'))
      render()
  })

  inspect.onclick = () => setInspecting(!inspecting)
  swaps.observe(doc.documentElement, { attributeFilter: ['aria-busy'] })
  render()

  win.addEventListener('pointermove', onMove, true)
  win.addEventListener('click', onClick, true)
  win.addEventListener('keydown', onKeyDown, true)
  win.addEventListener('keyup', onKeyUp, true)
  win.addEventListener('blur', hide)

  return {
    open,
    stop: () => {
      watch(false)
      clearTimeout(message)
      swaps.disconnect()
      setInspecting(false)
      win.removeEventListener('pointermove', onMove, true)
      win.removeEventListener('click', onClick, true)
      win.removeEventListener('keydown', onKeyDown, true)
      win.removeEventListener('keyup', onKeyUp, true)
      win.removeEventListener('blur', hide)
      outline.remove()
      label.remove()
      inspect.remove()
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
