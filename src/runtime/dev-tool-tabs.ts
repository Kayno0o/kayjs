import type { DevRequest } from '../server/dev'
import type { DevTab, DevTabOptions, DevTool, LoadTab } from './dev-tool'
import type { DevState } from './dev-tool-layout'
import type { Shell } from './dev-tool-shell'
import { REQUEST } from './dev-tool-constants'
import { DEFAULT_ICON, iconOf, TONE_ICONS } from './dev-tool-icons'
import { pill } from './dev-tool-parts'

// The tabs of the drawer: how one is made, which kay makes itself, and those whose code is a module of its own fetched when it first shows. Split from dev-tool.ts, which opens and closes the drawer.

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

// The tabs kay makes itself; those a library adds sit under a line.
const CORE_TABS = new Set(['problems', 'request', 'network', 'head', 'screen-reader', 'env', 'images', 'performance', 'routes', 'i18n', 'islands', 'not-found', 'data', 'jobs', 'styles'])

export interface TabEntry {
  options: DevTabOptions
  button: HTMLButtonElement
  panel: HTMLElement
  badge: HTMLButtonElement
}

export interface TabParts {
  doc: Document
  make: DevTool['make']
  shell: Shell
  state: DevState
  tabs: TabEntry[]
  openTab: (id: string) => void
  closeDrawer: () => void
  render: () => void
}

export function tabMaker({ doc, make, shell, state, tabs, openTab, closeDrawer, render }: TabParts): DevTool['tab'] {
  const { drawer, bar, tabList, rule, content, status } = shell

  return (options: DevTabOptions): DevTab => {
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
}

export function addLazyTabs(tool: DevTool, doc: Document, load: LoadTab): void {
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
}

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
