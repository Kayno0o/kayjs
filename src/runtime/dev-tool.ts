// Loaded by every page a dev server serves: a bar in a corner of the page opens a drawer whose tabs show what kay knows of the page, its problems first; under `kay dev` the inspector adds its own tab and buttons.
// It runs in the browser from its own route, so it imports types only; its elements live in a shadow root on the root element, which a page swap keeps, styled by an adopted stylesheet, which a policy without inline styles allows.
import type { DevProblems } from './dev-boot'
import type { DevIconName } from './dev-tool-icons'
import type { fetchKind, parseUrl } from './dev-tool-kit'
import type { EntryParts, filterable, formatBytes, formatMs, ownFetch, Toolbar } from './dev-tool-parts'
import type { MissingMessages } from './dev-tool-problems'
import type { walkComposed } from './dev-tool-tab-order'
import type { TabEntry } from './dev-tool-tabs'
import type { Vitals } from './dev-tool-vitals'
import { HOST } from './dev-tool-constants'
import { iconOf } from './dev-tool-icons'
import { startKeys } from './dev-tool-keys'
import { makeKit } from './dev-tool-kit'
import { readLayout, readState, writeLayout, writeState } from './dev-tool-layout'
import { panelMarkdown } from './dev-tool-markdown'
import { makeOutline } from './dev-tool-outline'
import { answerErrorPage, copied } from './dev-tool-parts'
import { missingMessages, problemsTab } from './dev-tool-problems'
import { requestTab } from './dev-tool-request'
import { buildShell, COPY_TAB } from './dev-tool-shell'
import { STYLE } from './dev-tool-style'
import { watchSwaps } from './dev-tool-swaps'
import { startTabOrder } from './dev-tool-tab-order'
import { addLazyTabs, shownTab, tabMaker } from './dev-tool-tabs'
import { watchVitals } from './dev-tool-vitals'
import { startPlacement } from './dev-tool-window'
import { formatDate } from './i18n'

// The names a tab module or a library writes its types against.
export type { DevIconName } from './dev-tool-icons'
export type { VitalName, Vitals } from './dev-tool-vitals'

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
  // Takes the tab out of the list while `false`, for a tab with nothing to show for this app (no database, no queue), and puts it back with `true`; the drawer shows the first tab meanwhile.
  offer: (offered: boolean) => void
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
  // A moment as the time of day a log line starts with, `14:05:03` in 24 hours whatever the page's locale, in the site's time zone, or the browser's.
  time: (at: Date | number | string) => string
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
  const shell = buildShell(doc, make)
  const { ui, bar, mark, drawer, where, tabList, copyTab, order, close } = shell
  const tabs: TabEntry[] = []
  // A docked drawer pads the page by its size, so none of the page hides under it, and publishes it as `--kay-dev-inset-<edge>` for a panel of the page to sit beside it, with the room the bar takes at a bottom corner as `--kay-dev-bar-bottom-<side>`. The bar and a floating drawer keep out of what a panel of the page holds, which it publishes as `--kay-panel-right` or `-bottom`.
  const pageSheet = new CSSStyleSheet()
  const save = () => writeState(win, state)
  const saveLayout = () => writeLayout(win, layout)

  sheet.replaceSync(STYLE)
  root.adoptedStyleSheets = [sheet]
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, pageSheet]
  root.append(ui)
  host.setAttribute('data-kay-dev', '')
  doc.documentElement.append(host)

  // The page the tools describe, which a page swap changes without a load.
  const showWhere = () => {
    where.textContent = `${win.location.pathname}${win.location.search}`
  }
  const { place, dragged } = startPlacement({ doc, win, state, layout, saveLayout, shell, pageSheet })
  const render = () => {
    const current = shownTab(tabs, state)

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
      shownTab(tabs, state)?.button.focus()
  }

  copyTab.onclick = async () => {
    const current = shownTab(tabs, state)

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

  const tab = tabMaker({ doc, make, shell, state, tabs, openTab, closeDrawer, render })

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

  mark.onclick = () => {
    if (dragged())
      return

    if (state.open)
      closeDrawer()
    else
      openTab(undefined)
  }
  close.onclick = () => closeDrawer(true)
  const stopKeys = startKeys({ win, host, root, tabList, state, tabs, openTab, closeDrawer })

  let opener: ((source: string) => Promise<string | undefined>) | undefined
  let problems: { stop: () => void } | undefined
  let request: { stop: () => void } | undefined

  const { outline, hideOutline } = makeOutline(root, make)

  const tabOrder = startTabOrder(doc, root, make)

  order.onclick = () => {
    const shown = order.getAttribute('aria-pressed') !== 'true'

    order.setAttribute('aria-pressed', String(shown))
    tabOrder.show(shown)
  }

  // The buttons kay's error pages carry need a script and have no other.
  const listening = new AbortController()
  const swapLog = watchSwaps(doc, win, listening.signal)
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
    time: (at) => {
      const date = new Date(at)

      return Number.isNaN(date.getTime()) ? String(at) : formatDate('en-GB', date, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    },
    kit: makeKit(() => tool, listening.signal, missing, vitals, swapLog),
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
      stopKeys()
      listening.abort()
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter(other => other !== pageSheet)
      host.remove()
    },
  }

  problems = problemsTab(doc, tool, state, save, missing)
  request = requestTab(doc, tool)
  addLazyTabs(tool, doc, load)
  doc.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-kay-open],button[data-kay-copy]') : null

    if (target)
      void answerErrorPage(tool, target)
  }, { signal: listening.signal })

  return tool
}

// What a lazy tab's module default-exports: it fills the panel and gives back what reads the tab again each time it shows.
export type DevTabModule = (tool: DevTool, tab: DevTab) => (() => void) | void

// How the tool fetches a tab's module, which a test replaces with the module itself.
export type LoadTab = (url: string) => Promise<{ default: DevTabModule }>
