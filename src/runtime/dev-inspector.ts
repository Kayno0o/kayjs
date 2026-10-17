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
const encoder = new TextEncoder()
// Each island's props attribute with its size, measured again only once it changes, as the tab refreshes twice a second.
const propsSizes = new WeakMap<HTMLElement, [props: string, bytes: number]>()

// Set by the hot swap in development: the values an island's signals hold now, in the order its script creates them, and how long it took to hydrate.
interface InspectedWindow {
  $kaySignals?: (island: HTMLElement) => unknown[] | undefined
  $kayHydrationMs?: (island: HTMLElement) => number | undefined
}

// What the dev server did with a position the inspector asked it to open.
type Opened = 'opened' | 'no editor' | 'failed' | 'unknown file' | 'unreachable'

const FAILURES: Record<Exclude<Opened, 'opened'>, string> = {
  'no editor': 'no editor found, set KAY_EDITOR',
  'failed': 'the editor failed to open it, see the kay dev terminal',
  'unknown file': 'not a source file of this project',
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
  const inspect = tool.button('Inspect', 'Inspect an element: click it to open its line', 'crosshair')
  const islandsTab = tool.tab({ id: 'islands', label: 'Islands', icon: 'boxes', summary: count => `${count} island${count === 1 ? '' : 's'}`, shown: () => watch(true), hidden: () => watch(false) })
  const panel = islandsTab.panel
  let inspecting = false
  // What the panel shows: rebuilt only when it changed, so a click, a selection or the focus inside it survives the refresh.
  let shown: { islands: HTMLElement[], text: string } | undefined
  let message: ReturnType<typeof setTimeout> | undefined
  let refresh: ReturnType<typeof setInterval> | undefined
  // Where the pointer last was, so pressing Alt outlines what it rests on without waiting for it to move.
  let pointer: { x: number, y: number } | undefined

  inspect.setAttribute('aria-pressed', 'false')

  const show = (target: Element, text: string) => tool.outline([target], text)
  const hide = () => tool.hideOutline()
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

      if (answer.opened === true)
        return 'opened'

      return answer.failed === true ? 'failed' : 'no editor'
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
    // The Escape ending Inspect is the inspector's, not the page's dialogs'.
    if (event.key === 'Escape' && inspecting) {
      event.preventDefault()
      event.stopImmediatePropagation()
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

    const rows = found.map(island => ({
      island,
      component: island.dataset.component ?? '?',
      values: win.$kaySignals?.(island)?.map(value => [formatted(value), typeOf(value)] as const),
      hydration: hydrationText(win.$kayHydrationMs?.(island)),
      props: propsBytes(island),
    }))
    const text = JSON.stringify(rows.map(({ component, values, hydration, props }) => [component, values, hydration, props]))

    if (shown?.text === text && shown.islands.length === found.length && shown.islands.every((island, index) => island === found[index]))
      return

    shown = { islands: found, text }
    hide()

    if (rows.length === 0) {
      panel.replaceChildren(tool.make('div', 'empty', 'No islands on this page.'))

      return
    }

    panel.replaceChildren(...rows.map(({ island, component, values, hydration, props }) => {
      const card = tool.make('div', 'island')
      const top = tool.make('div', 'top')
      const name = tool.make('button', 'name', component)

      name.type = 'button'
      name.onclick = () => void openFrom(island, `${component}:1:1`)
      top.append(name, tool.make('span', 'grow'))

      if (props !== undefined)
        top.append(tool.make('span', 'chip', `props ${sizeText(props)}`))

      top.append(values === undefined ? tool.make('span', 'pill', 'not hydrated') : tool.make('span', 'pill ok', hydration === undefined ? 'hydrated' : `hydrated in ${hydration}`))
      card.append(top)
      card.onpointerenter = () => show(island, component)
      card.onpointerleave = hide

      if (values?.length === 0)
        card.append(tool.make('span', 'note', 'no signals'))

      if (values !== undefined && values.length > 0) {
        const table = tool.make('table', 'signals')

        for (const [index, [value, type]] of values.entries()) {
          const row = tool.make('tr')

          row.append(tool.make('td', '', `#${index + 1}`), tool.make('td', 'value', value), tool.make('td', '', type))
          table.append(row)
        }

        card.append(table)
      }

      return card
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
  tool.setOpener(async (source) => {
    const opened = await open(source)

    return opened === 'opened' ? undefined : FAILURES[opened]
  })
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
      inspect.remove()
    },
  }
}

// The time an island took to hydrate, to a tenth of a millisecond under 10.
function hydrationText(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`
}

// The props the server wrote on an island, as the bytes of its attribute.
function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

function propsBytes(island: HTMLElement): number | undefined {
  const props = island.dataset.props

  if (props === undefined)
    return undefined

  const known = propsSizes.get(island)

  if (known?.[0] === props)
    return known[1]

  const bytes = encoder.encode(props).length

  propsSizes.set(island, [props, bytes])

  return bytes
}

// What a signal holds, as a word: its type, `function` and `element` apart.
function typeOf(value: unknown): string {
  if (value === null)
    return 'null'

  if (value instanceof Element)
    return 'element'

  return Array.isArray(value) ? 'array' : typeof value
}

function formatted(value: unknown): string {
  let text: string

  try {
    if (typeof value === 'function')
      text = 'function'
    else if (value instanceof Element)
      text = `<${value.localName}>`
    else
      text = JSON.stringify(value) ?? String(value)
  }
  catch {
    text = String(value)
  }

  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}...` : text
}
