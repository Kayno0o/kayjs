// Loaded by every page a dev server serves: a bar in a corner of the page opens a drawer whose tabs show what kay knows of the page, its problems first; under `kay dev` the inspector adds its own tab and buttons.
// It runs in the browser from its own route, so it imports types only; its elements live in a shadow root on the root element, which a page swap keeps, styled by an adopted stylesheet, which a policy without inline styles allows.
import type { DevRequest } from '../server/dev'
import type { DevProblems } from './dev-boot'
import type { DevIconName } from './dev-tool-icons'
import type { Dock, Room } from './dev-tool-layout'
import type { EntryParts, Toolbar } from './dev-tool-parts'
import type { MissingMessages } from './dev-tool-problems'
import type { Vitals } from './dev-tool-vitals'
import { HOST, REQUEST } from './dev-tool-constants'
import { DEFAULT_ICON, drawing, iconOf, MARK, setIcon, TONE_ICONS } from './dev-tool-icons'
import { ARROWS, BAR_HEIGHT, boxOf, clamp, DOCKS, DRAG_START, fitBox, follow, GRIPS, KEY_GRIPS, KEY_STEP, MARGIN, MIN_HEIGHT, MIN_WIDTH, NARROW, PAGE_LEFT, readLayout, readState, resized, snapped, writeLayout, writeState } from './dev-tool-layout'
import { panelMarkdown } from './dev-tool-markdown'
import { answerErrorPage, boundsOf, copied, copyButton, entry, filterable, formatBytes, formatMs, OWN_FETCHES, ownFetch, pill, positionButton, toolbar, withPositions } from './dev-tool-parts'
import { missingMessages, problemsTab } from './dev-tool-problems'
import { requestTab } from './dev-tool-request'
import { STYLE } from './dev-tool-style'
import { startTabOrder, walkComposed } from './dev-tool-tab-order'
import { watchVitals } from './dev-tool-vitals'

// The names a tab module or a library writes its types against.
export type { DevIconName } from './dev-tool-icons'
export type { VitalName, Vitals } from './dev-tool-vitals'

const DATA_TAB_URL = '/_kay/dev/tab/data.js'
const JOBS_TAB_URL = '/_kay/dev/tab/jobs.js'
const STYLES_TAB_URL = '/_kay/dev/tab/styles.js'
const ROUTES_TAB_URL = '/_kay/dev/tab/routes.js'
const HEAD_TAB_URL = '/_kay/dev/tab/head.js'
const READING_TAB_URL = '/_kay/dev/tab/reading.js'
const ENV_TAB_URL = '/_kay/dev/tab/env.js'
const NOT_FOUND_TAB_URL = '/_kay/dev/tab/not-found.js'
const I18N_TAB_URL = '/_kay/dev/tab/i18n.js'
const NETWORK_TAB_URL = '/_kay/dev/tab/network.js'
const IMAGES_TAB_URL = '/_kay/dev/tab/images.js'
const PERFORMANCE_TAB_URL = '/_kay/dev/tab/performance.js'
// The page swaps kept for the Network tab, as many as it lists navigations.
const SWAP_LOG = 10
const ACTION_PATH = /\/_kay\/action\//
const FONT_FILE = /\.(?:woff2?|ttf|otf)$/i
// server-islands.ts's ISLAND_PARAM, copied as this file imports types only.
const ISLAND_PARAM = 'kay_island'

// The tabs kay makes itself; those a library adds sit under a line.
const CORE_TABS = new Set(['problems', 'request', 'network', 'head', 'screen-reader', 'env', 'images', 'performance', 'routes', 'i18n', 'islands', 'not-found', 'data', 'jobs', 'styles'])

const SHOW_TAB_ORDER = 'Show the tab order'
const COPY_TAB = 'Copy this tab as Markdown'

export interface DevTabOptions {
  id: string
  label: string
  // The tab's icon, by name from kay's set; a puzzle piece without one.
  icon?: DevIconName
  // What the bar says for a count above zero, as `3 islands`; without it the count shows in the tab only.
  summary?: (count: number) => string
  // Says the bar's text politely to a screen reader as it changes.
  announce?: boolean
  // Called as the tab shows and hides, so it works only while shown.
  shown?: () => void
  hidden?: () => void
}

export interface DevTab {
  panel: HTMLElement
  // The count beside the tab's name and on the bar, `error` or `warn` coloring both; `note` is what the bar says instead of `summary`'s, and shows even at zero.
  count: (count: number, tone?: 'error' | 'warn', note?: string) => void
}

export interface DevKit {
  // Aborted when the tool stops.
  signal: AbortSignal
  entry: (kind: string, parts: EntryParts) => HTMLElement
  toolbar: (help: string, rerun: () => void, problems?: boolean) => Toolbar
  filterable: typeof filterable
  pill: (text: string, tone?: 'error' | 'warn' | 'ok' | 'accent') => HTMLElement
  copyButton: (what: string, text: string) => HTMLButtonElement
  positionButton: (source: string) => HTMLButtonElement
  ownFetch: typeof ownFetch
  withPositions: (text: string) => Node[]
  missing: MissingMessages
  vitals: Vitals
  formatBytes: typeof formatBytes
  fetchKind: typeof fetchKind
  formatMs: typeof formatMs
  // The addresses the tool fetched itself, which the Network tab leaves out.
  ownFetches: ReadonlySet<string>
  // The page swaps from the tool's start, for a tab whose module arrives later to replay.
  swaps: { path: string, log: { busy: boolean, at: number, path: string }[] }
  parseUrl: typeof parseUrl
  walkComposed: typeof walkComposed
}

export interface DevTool {
  root: ShadowRoot
  make: <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => HTMLElementTagNameMap[K]
  tab: (options: DevTabOptions) => DevTab
  // A button of its own on the bar, with an icon by name from kay's set before its text.
  button: (text: string, label: string, icon?: DevIconName) => HTMLButtonElement
  icon: (name: DevIconName) => SVGSVGElement
  // The helpers every list tab shares, for a tab whose code is a module of its own, which the browser loads as it is and so imports nothing from here.
  kit: DevKit
  // Outlines elements of the page, `text` beside the first, until `hideOutline`.
  outline: (targets: Element[], text: string) => void
  hideOutline: () => void
  // Opens `file:line:column` in the editor, giving back why it could not; only once `setOpener` said how, as the inspector does under `kay dev`.
  open: (source: string) => Promise<string | undefined>
  opens: () => boolean
  setOpener: (open: (source: string) => Promise<string | undefined>) => void
  stop: () => void
}

// A module a library's extension names in `devTool`, by the extension's name and where kay serves it.
export interface DevToolModule {
  name: string
  url: string
}

// Calls the default export of each module with the tool, one after another so the tabs keep their order; a module that fails to load, throws or exports no function is logged as a kay problem, naming its extension, and the others still load.
export async function loadDevModules(tool: DevTool, modules: DevToolModule[], load: (url: string) => Promise<unknown> = async url => import(url), log: (message: string) => void = message => console.error(message)): Promise<void> {
  for (const { name, url } of modules) {
    let loaded: { default?: unknown }

    try {
      loaded = await load(url) as { default?: unknown }
    }
    catch (error) {
      log(`[kay] the dev tool module of ${name} failed to load: ${error instanceof Error ? error.message : String(error)}`)

      continue
    }

    if (typeof loaded.default !== 'function') {
      log(`[kay] the dev tool module of ${name} exports no default function`)

      continue
    }

    try {
      await (loaded.default as (tool: DevTool) => unknown)(tool)
    }
    catch (error) {
      log(`[kay] the dev tool module of ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const importTab: LoadTab = async url => await import(url) as { default: DevTabModule }

export function startDevTool(doc: Document = document, load: LoadTab = importTab): DevTool {
  const win = doc.defaultView! as Window & { $kayProblems?: DevProblems }
  const state = readState(win)
  const layout = readLayout(win)
  const host = doc.createElement(HOST)
  const root = host.attachShadow({ mode: 'open' })
  const sheet = new CSSStyleSheet()
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag)

    element.className = className
    element.textContent = text

    return element
  }
  const ui = make('div', 'ui')
  const bar = make('div', 'bar')
  const mark = make('button', 'mark')
  const drawer = make('div', 'drawer')
  const head = make('div', 'head')
  const title = make('span', 'title')
  const where = make('span', 'where')
  const body = make('div', 'body')
  const tabList = make('div', 'tabs')
  const rule = make('span', 'sep')
  const content = make('div', 'content')
  const dock = make('div', 'dock')
  const docks = DOCKS.map(([value, label, icon]) => {
    const button = make('button', 'icon')

    button.type = 'button'
    setIcon(button, label, icon)
    dock.append(button)

    return { value, button }
  })
  const size = make('button', 'icon size')
  const copyTab = make('button', 'icon')
  const order = make('button', 'icon')
  const close = make('button', 'icon')
  const grips = GRIPS.map((edge) => {
    const grip = make('div', `grip ${edge}`)

    grip.dataset.edge = edge

    return grip
  })
  const status = make('span', 'sr')
  const copies = make('div', 'sr copies')
  const tabs: { options: DevTabOptions, button: HTMLButtonElement, panel: HTMLElement, badge: HTMLButtonElement }[] = []
  // A docked drawer pads the page by its size, so none of the page hides under it, and publishes it as `--kay-dev-inset-<edge>` for a panel of the page to sit beside it, with the room the bar takes at a bottom corner as `--kay-dev-bar-bottom-<side>`. The bar and a floating drawer keep out of what a panel of the page holds, which it publishes as `--kay-panel-right` or `-bottom`.
  const pageSheet = new CSSStyleSheet()
  const save = () => writeState(win, state)
  const saveLayout = () => writeLayout(win, layout)

  sheet.replaceSync(STYLE)
  root.adoptedStyleSheets = [sheet]
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, pageSheet]
  dock.setAttribute('role', 'group')
  dock.setAttribute('aria-label', 'Dock')
  drawer.id = 'kay-dev-drawer'
  drawer.setAttribute('role', 'dialog')
  drawer.setAttribute('aria-label', 'kay dev tools')
  tabList.setAttribute('role', 'tablist')
  tabList.setAttribute('aria-orientation', 'vertical')
  rule.hidden = true
  rule.setAttribute('aria-hidden', 'true')
  tabList.append(rule)
  mark.type = 'button'
  mark.setAttribute('aria-label', 'kay dev tools (Alt+Shift+K)')
  mark.setAttribute('aria-controls', drawer.id)
  mark.append(drawing(doc, MARK, '4 5 54 52', ''), 'kay')
  title.append(drawing(doc, MARK, '4 5 54 52', ''), make('span', 'words', 'kay dev tools'))
  status.setAttribute('role', 'status')
  copies.setAttribute('role', 'status')
  size.type = 'button'
  close.type = 'button'
  setIcon(close, 'Close', 'x')
  setIcon(copyTab, COPY_TAB, 'clipboard-copy')
  copyTab.type = 'button'
  setIcon(order, SHOW_TAB_ORDER, 'list-ordered')
  order.type = 'button'
  order.setAttribute('aria-pressed', 'false')
  head.append(title, where, copyTab, order, dock, size, close)
  body.append(tabList, content)
  drawer.append(head, body, ...grips)
  bar.append(mark, status)
  ui.append(drawer, bar, copies)
  root.append(ui)
  host.setAttribute('data-kay-dev', '')
  doc.documentElement.append(host)

  // The page the tools describe, which a page swap changes without a load.
  const showWhere = () => {
    where.textContent = `${win.location.pathname}${win.location.search}`
  }
  // The window less its scrollbars, which a fixed element's edges stop at.
  const room = (): Room => ({ width: doc.documentElement.clientWidth || win.innerWidth, height: doc.documentElement.clientHeight || win.innerHeight })
  // A narrow window spans the drawer whatever the layout says.
  const dockOf = (): Dock => win.innerWidth > NARROW ? layout.dock : 'float'
  const dockSize = (value: number) => dockOf() === 'bottom' ? clamp(value, MIN_HEIGHT, room().height - PAGE_LEFT) : clamp(value, MIN_WIDTH, room().width - PAGE_LEFT)
  // Lays the bar and drawer out as the layout says, within the window as it is now.
  let padding = ''
  let maxed: boolean | undefined
  const place = () => {
    const current = dockOf()
    const floating = current === 'float'
    const docked = floating ? 0 : dockSize(current === 'bottom' ? layout.bottom : layout.right)
    // A floating drawer the pointer can move and resize, which a narrow window spans instead.
    const free = floating && !layout.max && win.innerWidth > NARROW
    const box = free && layout.box !== undefined ? fitBox(layout.box, room()) : undefined
    const keyGrip = KEY_GRIPS[current]
    // What the bar takes of a bottom corner, its margin and measured height, published as `--kay-dev-bar-bottom-<side>` for the page's own fixed elements at that corner to keep clear of it; nothing is published for a top corner, nor for a corner the bar is not in.
    const corner = layout.corner.startsWith('bottom') ? ` --kay-dev-bar-${layout.corner}: ${MARGIN + (bar.getBoundingClientRect().height || BAR_HEIGHT)}px;` : ''
    const sheet = `html {${corner}${state.open && !floating ? ` padding-${current}: ${docked}px !important; --kay-dev-inset-${current}: ${docked}px;` : ''} }`

    ui.classList.toggle('right', layout.corner.endsWith('right'))
    ui.classList.toggle('top', layout.corner.startsWith('top'))
    ui.classList.toggle('floating', free)
    ui.classList.toggle('max', floating && layout.max)
    ui.classList.toggle('dock-bottom', current === 'bottom')
    ui.classList.toggle('dock-right', current === 'right')
    ui.classList.toggle('open', state.open)
    ui.style.setProperty('--dock', `${docked}px`)
    drawer.style.left = box === undefined ? '' : `${box.left}px`
    drawer.style.top = box === undefined ? '' : `${box.top}px`
    drawer.style.width = box === undefined ? '' : `${box.width}px`
    drawer.style.height = box === undefined ? '' : `${box.height}px`
    drawer.style.right = drawer.style.bottom = box === undefined ? '' : 'auto'
    size.hidden = !floating

    if (sheet !== padding) {
      padding = sheet
      pageSheet.replaceSync(sheet)
    }

    if (layout.max !== maxed) {
      maxed = layout.max
      setIcon(size, layout.max ? 'Restore the size' : 'Fill the window', layout.max ? 'minimize-2' : 'maximize-2')
    }

    for (const { value, button } of docks)
      button.setAttribute('aria-pressed', String(layout.dock === value))

    for (const grip of grips) {
      const edge = grip.dataset.edge!
      const reached = edge === keyGrip

      grip.hidden = floating ? !free : !reached
      grip.tabIndex = reached ? 0 : -1

      if (reached) {
        grip.setAttribute('role', 'separator')
        grip.setAttribute('aria-label', 'Resize the dev tools, arrow keys')
        grip.setAttribute('aria-orientation', edge === 'n' ? 'horizontal' : 'vertical')
        // The height for the top edge, else the width, which the corner's left and right arrows change.
        grip.setAttribute('aria-valuemin', String(edge === 'n' ? MIN_HEIGHT : MIN_WIDTH))
        grip.setAttribute('aria-valuemax', String(edge === 'n' ? room().height : room().width))
        grip.setAttribute('aria-valuenow', String(Math.round(edge === 'n' ? drawer.offsetHeight : drawer.offsetWidth)))
      }
      else {
        for (const name of ['role', 'aria-label', 'aria-orientation', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow'])
          grip.removeAttribute(name)
      }
    }
  }
  const render = () => {
    const current = tabs.find(tab => tab.options.id === state.tab) ?? tabs[0]

    drawer.hidden = !state.open
    mark.setAttribute('aria-expanded', String(state.open))
    place()
    showWhere()

    for (const tab of tabs) {
      const selected = tab === current

      tab.button.setAttribute('aria-selected', String(selected))
      tab.button.tabIndex = selected ? 0 : -1
      tab.badge.setAttribute('aria-expanded', String(selected && state.open))

      if (tab.panel.hidden !== (selected && state.open))
        continue

      tab.panel.hidden = !(selected && state.open)

      if (tab.panel.hidden)
        tab.options.hidden?.()
      else
        tab.options.shown?.()
    }
  }
  const openTab = (id: string | undefined, focus = false) => {
    state.open = true
    state.tab = id ?? state.tab
    save()
    render()

    if (focus)
      (tabs.find(tab => tab.options.id === state.tab) ?? tabs[0])?.button.focus()
  }

  copyTab.onclick = async () => {
    const current = tabs.find(tab => tab.options.id === state.tab) ?? tabs[0]

    if (current !== undefined)
      await copied(copyTab, panelMarkdown(current.panel, `${current.options.label}, ${win.location.href}`), COPY_TAB, 'clipboard-copy')
  }
  const closeDrawer = (focus = false) => {
    state.open = false
    save()
    render()

    if (focus)
      mark.focus()
  }

  const tab = (options: DevTabOptions): DevTab => {
    const button = make('button')
    const count = make('span', 'count pill')
    const panel = make('div', 'panel')
    const badge = make('button')
    const entry = { options, button, panel, badge }
    const library = !CORE_TABS.has(options.id)
    // The tabs of kay come first, then a line, then those of libraries, each in the order they were made.
    const firstLibrary = tabs.findIndex(other => !CORE_TABS.has(other.options.id))
    const at = library || firstLibrary < 0 ? tabs.length : firstLibrary

    button.type = 'button'
    button.id = `kay-dev-tab-${options.id}`
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-controls', `kay-dev-${options.id}`)
    button.onclick = () => openTab(options.id)
    count.hidden = true
    button.append(iconOf(doc, options.icon ?? DEFAULT_ICON), make('span', 'name', options.label), count)
    panel.id = `kay-dev-${options.id}`
    panel.hidden = true
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', button.id)
    badge.type = 'button'
    badge.hidden = true
    badge.setAttribute('aria-controls', drawer.id)
    badge.onclick = () => state.open && state.tab === options.id ? closeDrawer() : openTab(options.id)

    if (library) {
      rule.hidden = false
      tabList.append(button)
    }
    else {
      tabList.insertBefore(button, tabs[at]?.button ?? rule)
    }

    content.append(panel)
    bar.insertBefore(badge, bar.children[2 + at] ?? null)
    tabs.splice(at, 0, entry)
    // Once the caller is done setting the tab up, as showing it runs its `shown`.
    queueMicrotask(render)

    return {
      panel,
      count: (value, tone, note) => {
        const text = note ?? options.summary?.(value) ?? ''

        count.hidden = value === 0
        count.textContent = String(value)
        count.className = tone === undefined ? 'count pill' : `count pill ${tone}`
        badge.hidden = note === undefined && (value === 0 || options.summary === undefined)
        badge.replaceChildren(pill({ make, icon: name => iconOf(doc, name) }, text, tone, tone === undefined ? undefined : TONE_ICONS[tone]))

        if (options.announce === true)
          status.textContent = value === 0 && note === undefined ? '' : text
      },
    }
  }

  const button = (text: string, label: string, icon?: DevIconName) => {
    const element = make('button')

    element.type = 'button'
    element.setAttribute('aria-label', label)

    if (icon !== undefined)
      element.append(iconOf(doc, icon))

    element.append(text)
    bar.append(element)

    return element
  }

  // A press on the mark that moves past a few pixels drags the bar, landing it in the nearest corner, and opens nothing.
  let dragged = false

  mark.onpointerdown = (event) => {
    if (event.button !== 0)
      return

    const start = bar.getBoundingClientRect()

    dragged = false
    follow(event, mark, (dx, dy) => {
      if (!dragged && Math.hypot(dx, dy) < DRAG_START)
        return

      dragged = true
      bar.style.left = `${start.left + dx}px`
      bar.style.top = `${start.top + dy}px`
      bar.style.right = bar.style.bottom = 'auto'
    }, () => {
      if (!dragged)
        return

      // The click that ends the press comes next, in this same task; a drag ended elsewhere gets none, and must not swallow the next one.
      win.setTimeout(() => {
        dragged = false
      })

      const box = bar.getBoundingClientRect()

      layout.corner = `${box.top + box.height / 2 < room().height / 2 ? 'top' : 'bottom'}-${box.left + box.width / 2 < room().width / 2 ? 'left' : 'right'}`
      bar.style.left = bar.style.top = bar.style.right = bar.style.bottom = ''
      saveLayout()
      place()
    })
  }
  mark.onclick = () => {
    if (dragged)
      return

    if (state.open)
      closeDrawer()
    else
      openTab(undefined)
  }
  close.onclick = () => closeDrawer(true)
  size.onclick = () => {
    layout.max = !layout.max
    saveLayout()
    place()
  }

  // Through the entry, not a destructured binding: tsgo's declaration emit panics on a property assigned to one.
  for (const entry of docks) {
    entry.button.onclick = () => {
      layout.dock = entry.value
      saveLayout()
      place()
    }
  }

  // The head of a floating drawer moves it, snapping it to an edge near where it is let go.
  head.onpointerdown = (event) => {
    if (event.button !== 0 || !ui.classList.contains('floating') || (event.target as Element).closest('button') !== null)
      return

    const start = boxOf(drawer)
    // A press that does not move leaves a drawer that was never moved where its corner puts it.
    let moved = false

    event.preventDefault()
    follow(event, head, (dx, dy) => {
      if (!moved && Math.hypot(dx, dy) < DRAG_START)
        return

      moved = true
      layout.box = fitBox({ ...start, left: start.left + dx, top: start.top + dy }, room())
      place()
    }, () => {
      if (!moved)
        return

      layout.box = snapped(fitBox(layout.box ?? start, room()), room())
      saveLayout()
      place()
    })
  }

  // Each edge and corner resizes the drawer as the pointer moves it; the one the keyboard reaches resizes it by arrow keys.
  const resizeFrom = (edge: string) => {
    const start = boxOf(drawer)

    return (dx: number, dy: number) => {
      const current = dockOf()

      if (current === 'bottom')
        layout.bottom = dockSize(start.height - dy)
      else if (current === 'right')
        layout.right = dockSize(start.width - dx)
      else
        layout.box = fitBox(resized(start, edge, dx, dy, room()), room())

      place()
    }
  }

  for (const grip of grips) {
    grip.onpointerdown = (event) => {
      if (event.button !== 0)
        return

      event.preventDefault()
      follow(event, grip, resizeFrom(grip.dataset.edge!), saveLayout)
    }
    grip.onkeydown = (event) => {
      const arrow = ARROWS[event.key]

      if (arrow === undefined)
        return

      event.preventDefault()
      resizeFrom(grip.dataset.edge!)(arrow[0] * KEY_STEP, arrow[1] * KEY_STEP)
      saveLayout()
    }
  }

  // Up and Down, Home and End move between the tabs, as a vertical tab list's do.
  tabList.onkeydown = (event) => {
    const index = tabs.findIndex(tab => tab.button === root.activeElement)
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: tabs.length - 1 }[event.key]

    if (index < 0 || next === undefined)
      return

    event.preventDefault()
    openTab(tabs[(next + tabs.length) % tabs.length]!.options.id, true)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyK') {
      event.preventDefault()

      if (event.repeat)
        return

      if (state.open)
        closeDrawer(true)
      else
        openTab(undefined, true)
    }
    // Only from inside the tool, so the page's own dialogs keep their Escape.
    else if (event.key === 'Escape' && state.open && event.composedPath().includes(host)) {
      closeDrawer(true)
    }
  }

  win.addEventListener('keydown', onKeyDown, true)

  const label = make('div', 'label mono')
  const boxes: HTMLElement[] = []
  let opener: ((source: string) => Promise<string | undefined>) | undefined
  let problems: { stop: () => void } | undefined
  let request: { stop: () => void } | undefined

  label.hidden = true
  root.append(label)

  const outline = (targets: Element[], text: string) => {
    for (const [index, target] of targets.entries()) {
      const box = boundsOf(target)
      const element = boxes[index] ?? root.appendChild(make('div', 'outline'))

      boxes[index] = element
      element.hidden = false
      element.style.left = `${box.left}px`
      element.style.top = `${box.top}px`
      element.style.width = `${box.width}px`
      element.style.height = `${box.height}px`

      if (index === 0) {
        label.hidden = false
        label.textContent = text
        label.style.left = `${Math.max(0, box.left)}px`
        label.style.top = `${box.top > 24 ? box.top - 22 : box.bottom + 2}px`
      }
    }

    for (const box of boxes.slice(targets.length))
      box.hidden = true
  }
  const hideOutline = () => {
    label.hidden = true

    for (const box of boxes)
      box.hidden = true
  }

  const tabOrder = startTabOrder(doc, root, make)

  order.onclick = () => {
    const shown = order.getAttribute('aria-pressed') !== 'true'

    order.setAttribute('aria-pressed', String(shown))
    tabOrder.show(shown)
  }

  // The buttons kay's error pages carry need a script and have no other.
  const listening = new AbortController()
  const here = () => `${win.location.pathname}${win.location.search}`
  const swapLog = { path: here(), log: [] as { busy: boolean, at: number, path: string }[] }
  const swapWatch = new MutationObserver(() => {
    swapLog.log.push({ busy: doc.documentElement.getAttribute('aria-busy') === 'true', at: win.performance.now(), path: here() })

    if (swapLog.log.length > SWAP_LOG)
      swapLog.log.shift()
  })

  swapWatch.observe(doc.documentElement, { attributes: true, attributeFilter: ['aria-busy'] })
  listening.signal.addEventListener('abort', () => swapWatch.disconnect())
  const missing = missingMessages()
  const vitals = watchVitals(doc.defaultView!, listening.signal)
  // A page swap marks the document busy until the new page is in, and a back or forward step moves without one.
  const swaps = new MutationObserver(showWhere)

  swaps.observe(doc.documentElement, { attributeFilter: ['aria-busy'] })
  win.addEventListener('popstate', showWhere, { signal: listening.signal })
  win.addEventListener('resize', place, { signal: listening.signal })
  showWhere()
  listening.signal.addEventListener('abort', () => swaps.disconnect())

  const tool: DevTool = {
    root,
    make,
    tab,
    button,
    icon: name => iconOf(doc, name),
    kit: {
      signal: listening.signal,
      entry: (kind, parts) => entry(tool, kind, parts),
      toolbar: (help, rerun, problems) => toolbar(tool, help, rerun, problems),
      filterable,
      pill: (text, tone) => pill(tool, text, tone),
      copyButton: (what, text) => copyButton(tool, what, text),
      positionButton: source => positionButton(tool, source),
      ownFetch,
      withPositions: text => withPositions(text, tool),
      missing,
      vitals,
      formatBytes,
      fetchKind,
      formatMs,
      ownFetches: OWN_FETCHES,
      swaps: swapLog,
      parseUrl,
      walkComposed,
    },
    outline,
    hideOutline,
    open: async source => opener ? opener(source) : 'no editor here, run kay dev',
    opens: () => opener !== undefined,
    setOpener: (open) => {
      opener = open

      for (const position of root.querySelectorAll<HTMLButtonElement>('button.position'))
        position.disabled = false
    },
    stop: () => {
      problems?.stop()
      request?.stop()
      tabOrder.stop()
      win.removeEventListener('keydown', onKeyDown, true)
      listening.abort()
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter(other => other !== pageSheet)
      host.remove()
    },
  }

  problems = problemsTab(doc, tool, state, save, missing)
  request = requestTab(doc, tool)
  lazyTab(tool, { id: 'network', label: 'Network', icon: 'network' }, NETWORK_TAB_URL, load, true)
  lazyTab(tool, { id: 'head', label: 'Head', icon: 'scan-search' }, HEAD_TAB_URL, load, true)
  lazyTab(tool, { id: 'screen-reader', label: 'Screen reader', icon: 'ear', hidden: () => tool.hideOutline() }, READING_TAB_URL, load, true)
  lazyTab(tool, { id: 'env', label: 'Env', icon: 'key-round' }, ENV_TAB_URL, load, true)
  lazyTab(tool, { id: 'images', label: 'Images', icon: 'image' }, IMAGES_TAB_URL, load, true)
  lazyTab(tool, { id: 'performance', label: 'Performance', icon: 'gauge' }, PERFORMANCE_TAB_URL, load, true)
  lazyTab(tool, { id: 'routes', label: 'Routes', icon: 'route' }, ROUTES_TAB_URL, load)

  // Only a site with `i18n` has the tab, whose request block lists the locales.
  if ((JSON.parse(doc.getElementById(REQUEST)?.textContent ?? 'null') as DevRequest | null)?.locales !== undefined)
    lazyTab(tool, { id: 'i18n', label: 'i18n', icon: 'languages' }, I18N_TAB_URL, load, true)

  lazyTab(tool, { id: 'not-found', label: 'Not found', icon: 'circle-x' }, NOT_FOUND_TAB_URL, load, true)
  lazyTab(tool, { id: 'data', label: 'Data', icon: 'database' }, DATA_TAB_URL, load)
  lazyTab(tool, { id: 'jobs', label: 'Jobs', icon: 'list-checks' }, JOBS_TAB_URL, load)
  lazyTab(tool, { id: 'styles', label: 'Styles', icon: 'palette' }, STYLES_TAB_URL, load)
  doc.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-kay-open],button[data-kay-copy]') : null

    if (target)
      void answerErrorPage(tool, target)
  }, { signal: listening.signal })

  return tool
}

function parseUrl(src: string, base: string): URL | undefined {
  try {
    return new URL(src, base)
  }
  catch {
    return undefined
  }
}

// What a request was for: an action, a server island, a page a swap or prefetch fetched, another fetch, or the kind of file the page loaded.
function fetchKind(fetched: PerformanceResourceTiming, url: URL): string {
  const type = 'contentType' in fetched && typeof fetched.contentType === 'string' ? fetched.contentType : ''

  if (fetched.entryType === 'navigation')
    return 'document'

  if (ACTION_PATH.test(url.pathname))
    return 'action'

  if (url.searchParams.has(ISLAND_PARAM))
    return 'server island'

  if (fetched.initiatorType === 'fetch' || fetched.initiatorType === 'xmlhttprequest')
    return type.startsWith('text/html') ? 'page' : 'fetch'

  if (fetched.initiatorType === 'script' || url.pathname.endsWith('.js'))
    return 'script'

  if (url.pathname.endsWith('.css') || type.startsWith('text/css'))
    return 'stylesheet'

  if (fetched.initiatorType === 'img' || fetched.initiatorType === 'image' || type.startsWith('image/'))
    return 'image'

  if (FONT_FILE.test(url.pathname) || type.startsWith('font/'))
    return 'font'

  return fetched.initiatorType === '' ? 'other' : fetched.initiatorType
}

// What a lazy tab's module default-exports: it fills the panel and gives back what reads the tab again each time it shows.
export type DevTabModule = (tool: DevTool, tab: DevTab) => (() => void) | void

// How the tool fetches a tab's module, which a test replaces with the module itself.
export type LoadTab = (url: string) => Promise<{ default: DevTabModule }>

// A tab whose code is a module of its own, fetched the first time the tab opens so the tool carries none of it until then; a module that fails to load says so in the panel and is tried again at the next open.
// A tab with `early` shows a badge from the page itself, so its module is fetched at once and sets the badge as it runs, the panel read again if it is open by then.
function lazyTab(tool: DevTool, options: Pick<DevTabOptions, 'id' | 'label' | 'icon' | 'hidden'>, url: string, load: LoadTab, early = false): void {
  let refresh: (() => void) | undefined
  let loading = false
  let open: () => void = () => undefined
  const tab: DevTab = tool.tab({ ...options, shown: () => open() })

  open = () => {
    if (refresh !== undefined)
      return refresh()

    if (loading)
      return

    loading = true
    void (async () => {
      try {
        const loaded = await load(url)

        // The tool stopped while the module was on its way.
        if (tool.kit.signal.aborted)
          return

        refresh = loaded.default(tool, tab) ?? (() => undefined)

        if (!early || tab.panel.hidden === false)
          refresh()
      }
      catch (error) {
        tab.panel.replaceChildren(tool.make('div', 'empty', `Could not load the ${options.label} tab: ${error instanceof Error ? error.message : String(error)}`))
      }
      finally {
        loading = false
      }
    })()
  }

  if (early)
    open()
}
