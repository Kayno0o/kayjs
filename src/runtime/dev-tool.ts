// Loaded by every page a dev server serves: a bar in a corner of the page opens a drawer whose tabs show what kay knows of the page, its problems first; under `kay dev` the inspector adds its own tab and buttons.
// It runs in the browser from its own route, so it imports types only; its elements live in a shadow root on the root element, which a page swap keeps, styled by an adopted stylesheet, which a policy without inline styles allows.
import type { DevProblem, DevProblems } from './dev-boot'

const HOST = 'kay-dev'
const STATE_KEY = 'kay-dev'
const CHECK_PROBLEMS = 'kay-check-problems'
// The most problem texts a tab remembers as dismissed.
const MAX_DISMISSED = 200

const STYLE = `
:host { all: initial; --bg: #fff; --surface: #f5f5f7; --fg: #1c1c22; --muted: #6a6a76; --border: #e2e2e8; --accent: #6d28d9; --accent-soft: rgb(109 40 217 / 10%); --on-accent: #fff; --error: #c4262e; --warn: #9a5b00; --shadow: 0 8px 28px rgb(0 0 0 / 18%); color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :host { --bg: #1b1b21; --surface: #25252d; --fg: #ececf1; --muted: #a2a2ae; --border: #36363f; --accent: #a78bfa; --accent-soft: rgb(167 139 250 / 16%); --on-accent: #1b1b21; --error: #ff7a7a; --warn: #f2b450; --shadow: 0 8px 28px rgb(0 0 0 / 50%); color-scheme: dark; }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ui { font: 13px/1.45 system-ui, sans-serif; color: var(--fg); text-align: left; }
.mono { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.bar { position: fixed; bottom: 12px; left: 12px; z-index: 2147483647; display: flex; align-items: center; gap: 2px; padding: 3px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg); box-shadow: var(--shadow); }
.right .bar { left: auto; right: 12px; }
.bar > button { padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
.bar > button:hover { background: var(--surface); }
.bar > button[aria-pressed=true], .bar > button[aria-expanded=true] { background: var(--accent-soft); }
.mark { font-weight: 700; color: var(--accent); letter-spacing: .02em; }
.error { color: var(--error); }
.warn { color: var(--warn); }
.drawer { position: fixed; bottom: 52px; left: 12px; z-index: 2147483647; display: flex; flex-direction: column; width: min(36rem, calc(100vw - 24px)); max-height: min(60vh, 36rem); border: 1px solid var(--border); border-radius: 10px; background: var(--bg); box-shadow: var(--shadow); overflow: hidden; }
.right .drawer { left: auto; right: 12px; }
.head { display: flex; align-items: center; gap: 4px; padding: 6px; border-bottom: 1px solid var(--border); background: var(--surface); }
.tabs { display: flex; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; }
.tabs button { padding: 4px 10px; border-radius: 6px; color: var(--muted); white-space: nowrap; }
.tabs button[aria-selected=true] { background: var(--bg); color: var(--fg); box-shadow: 0 0 0 1px var(--border); }
.tabs .count { margin-left: 6px; padding: 0 6px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 11px; }
.tabs .count.error { background: var(--error); color: var(--bg); }
.tool { padding: 4px 8px; border-radius: 6px; color: var(--muted); }
.tool:hover { background: var(--bg); color: var(--fg); }
.panel { flex: 1; overflow: auto; padding: 10px; }
.actions { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.empty { color: var(--muted); padding: 8px 2px; }
.problem { margin: 0 0 8px; padding: 8px 10px; border-left: 3px solid var(--warn); border-radius: 4px; background: var(--surface); white-space: pre-wrap; word-break: break-word; }
.problem.error { border-left-color: var(--error); }
.problem.error, .problem.warn { color: var(--fg); }
.row { padding: 6px 4px 8px; border-bottom: 1px solid var(--border); }
.row:last-child { border-bottom: 0; }
.link { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.value { white-space: pre-wrap; word-break: break-all; }
.note { color: var(--muted); }
.outline { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid var(--accent); border-radius: 2px; background: var(--accent-soft); }
.label { position: fixed; z-index: 2147483647; pointer-events: none; padding: 2px 6px; border-radius: 4px; background: var(--accent); color: var(--on-accent); white-space: nowrap; }
@media (max-width: 480px) {
  .drawer, .right .drawer { left: 8px; right: 8px; width: auto; max-height: 55vh; }
}
`

interface DevState {
  open: boolean
  tab: string
  side: 'left' | 'right'
  dismissed: string[]
}

export interface DevTabOptions {
  id: string
  label: string
  // What the bar says for a count above zero, as `3 islands`; without it the count shows in the tab only.
  summary?: (count: number) => string
  // Called as the tab shows and hides, so it works only while shown.
  shown?: () => void
  hidden?: () => void
}

export interface DevTab {
  panel: HTMLElement
  // The count beside the tab's name and on the bar, `error` coloring both.
  count: (count: number, tone?: 'error') => void
}

export interface DevTool {
  // Where the inspector puts its outline and label, over the page.
  root: ShadowRoot
  make: <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => HTMLElementTagNameMap[K]
  tab: (options: DevTabOptions) => DevTab
  // A button of its own on the bar.
  button: (text: string, label: string) => HTMLButtonElement
  stop: () => void
}

export function startDevTool(doc: Document = document): DevTool {
  const win = doc.defaultView! as Window & { $kayProblems?: DevProblems }
  const state = readState(win)
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
  const mark = make('button', 'mark', 'kay')
  const drawer = make('div', 'drawer')
  const head = make('div', 'head')
  const tabList = make('div', 'tabs')
  const side = make('button', 'tool')
  const close = make('button', 'tool', 'Close')
  const tabs: { options: DevTabOptions, button: HTMLButtonElement, panel: HTMLElement, badge: HTMLButtonElement }[] = []
  const save = () => writeState(win, state)

  sheet.replaceSync(STYLE)
  root.adoptedStyleSheets = [sheet]
  ui.classList.toggle('right', state.side === 'right')
  drawer.id = 'kay-dev-drawer'
  drawer.setAttribute('role', 'dialog')
  drawer.setAttribute('aria-label', 'kay dev tools')
  tabList.setAttribute('role', 'tablist')
  mark.type = 'button'
  mark.setAttribute('aria-label', 'kay dev tools (Alt+Shift+K)')
  mark.setAttribute('aria-controls', drawer.id)
  side.type = 'button'
  close.type = 'button'
  head.append(tabList, side, close)
  drawer.append(head)
  bar.append(mark)
  ui.append(drawer, bar)
  root.append(ui)
  host.setAttribute('data-kay-dev', '')
  doc.documentElement.append(host)

  const render = () => {
    const current = tabs.find(tab => tab.options.id === state.tab) ?? tabs[0]

    drawer.hidden = !state.open
    mark.setAttribute('aria-expanded', String(state.open))
    side.textContent = state.side === 'left' ? 'Dock right' : 'Dock left'

    for (const tab of tabs) {
      const selected = tab === current

      tab.button.setAttribute('aria-selected', String(selected))
      tab.button.tabIndex = selected ? 0 : -1

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
  const closeDrawer = (focus = false) => {
    state.open = false
    save()
    render()

    if (focus)
      mark.focus()
  }

  const tab = (options: DevTabOptions): DevTab => {
    const button = make('button', '', options.label)
    const count = make('span', 'count')
    const panel = make('div', 'panel')
    const badge = make('button', '')
    const entry = { options, button, panel, badge }

    button.type = 'button'
    button.id = `kay-dev-tab-${options.id}`
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-controls', `kay-dev-${options.id}`)
    button.onclick = () => openTab(options.id)
    count.hidden = true
    button.append(count)
    panel.id = `kay-dev-${options.id}`
    panel.hidden = true
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', button.id)
    badge.type = 'button'
    badge.hidden = true
    badge.onclick = () => state.open && state.tab === options.id ? closeDrawer() : openTab(options.id)
    tabList.append(button)
    drawer.append(panel)
    bar.insertBefore(badge, bar.children[1 + tabs.length] ?? null)
    tabs.push(entry)
    // Once the caller is done setting the tab up, as showing it runs its `shown`.
    queueMicrotask(render)

    return {
      panel,
      count: (value, tone) => {
        count.hidden = value === 0
        count.textContent = String(value)
        count.classList.toggle('error', tone === 'error')
        badge.hidden = value === 0 || options.summary === undefined
        badge.textContent = options.summary?.(value) ?? ''
        badge.className = tone ?? ''
      },
    }
  }

  const button = (text: string, label: string) => {
    const element = make('button', '', text)

    element.type = 'button'
    element.setAttribute('aria-label', label)
    bar.append(element)

    return element
  }

  mark.onclick = () => state.open ? closeDrawer() : openTab(undefined)
  close.onclick = () => closeDrawer(true)
  side.onclick = () => {
    state.side = state.side === 'left' ? 'right' : 'left'
    ui.classList.toggle('right', state.side === 'right')
    save()
    render()
  }

  // Arrow keys move between the tabs, as a tab list's do.
  tabList.onkeydown = (event) => {
    const index = tabs.findIndex(tab => tab.button === root.activeElement)
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0

    if (index < 0 || step === 0)
      return

    event.preventDefault()
    openTab(tabs[(index + step + tabs.length) % tabs.length]!.options.id, true)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyK') {
      event.preventDefault()

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

  const problems = problemsTab(doc, { tab, make }, state, save)

  return {
    root,
    make,
    tab,
    button,
    stop: () => {
      problems.stop()
      win.removeEventListener('keydown', onKeyDown, true)
      host.remove()
    },
  }
}

// What kay logged, what `kay check` found and what the accessibility check found, a problem listed once; those the page logged leave with it on a page swap.
function problemsTab(doc: Document, tool: Pick<DevTool, 'tab' | 'make'>, state: DevState, save: () => void): { stop: () => void } {
  const win = doc.defaultView! as Window & { $kayProblems?: DevProblems }
  const tab = tool.tab({ id: 'problems', label: 'Problems', summary: count => `${count} problem${count === 1 ? '' : 's'}` })
  const actions = tool.make('div', 'actions')
  const clear = tool.make('button', 'tool', 'Dismiss all')
  const list = tool.make('div', 'mono')
  const empty = tool.make('div', 'empty', 'No problems on this page.')
  const shown = new Map<string, { problem: DevProblem, element: HTMLElement, check: boolean }>()
  const dismissed = new Set(state.dismissed)

  clear.type = 'button'
  actions.append(clear)
  list.setAttribute('aria-live', 'polite')
  tab.panel.append(actions, empty, list)

  const update = () => {
    const errors = [...shown.values()].some(({ problem }) => problem.level === 'error')

    tab.count(shown.size, errors ? 'error' : undefined)
    empty.hidden = shown.size > 0
    actions.hidden = shown.size === 0
  }
  const add = (problem: DevProblem, check = false) => {
    if (shown.has(problem.text) || dismissed.has(problem.text))
      return

    const element = tool.make('pre', `problem mono ${problem.level}`, problem.text)

    shown.set(problem.text, { problem, element, check })
    list.append(element)
    update()
  }

  clear.onclick = () => {
    for (const [text, { element }] of shown) {
      dismissed.add(text)
      element.remove()
    }

    shown.clear()
    state.dismissed = [...dismissed].slice(-MAX_DISMISSED)
    save()
    update()
  }

  for (const text of JSON.parse(doc.getElementById(CHECK_PROBLEMS)?.textContent ?? '[]') as string[])
    add({ level: text.startsWith('error') ? 'error' : 'warn', text }, true)

  // What was logged before this loaded, then each problem as it is logged, a microtask later so a failure here never breaks the call that logged.
  const early = Array.isArray(win.$kayProblems) ? win.$kayProblems as DevProblem[] : []

  win.$kayProblems = {
    push: (problem: DevProblem) => queueMicrotask(() => {
      try {
        add(problem)
      }
      catch {}
    }),
  }

  for (const problem of early)
    add(problem)

  // A page swap marks the document busy until the new page is in: the old page's problems go as it starts.
  const swaps = new MutationObserver(() => {
    if (!doc.documentElement.hasAttribute('aria-busy'))
      return

    for (const [text, { element, check }] of shown) {
      if (!check) {
        element.remove()
        shown.delete(text)
      }
    }

    update()
  })

  swaps.observe(doc.documentElement, { attributeFilter: ['aria-busy'] })
  update()

  return {
    stop: () => {
      swaps.disconnect()
      // Problems logged from now on wait for the next tool.
      win.$kayProblems = [] as DevProblem[]
    },
  }
}

function readState(win: Window): DevState {
  const fallback: DevState = { open: false, tab: 'problems', side: 'left', dismissed: [] }

  try {
    return { ...fallback, ...JSON.parse(win.sessionStorage.getItem(STATE_KEY) ?? '{}') as Partial<DevState> }
  }
  catch {
    return fallback
  }
}

// Per browser tab, as the page's own state is: another tab starts closed.
function writeState(win: Window, state: DevState): void {
  try {
    win.sessionStorage.setItem(STATE_KEY, JSON.stringify(state))
  }
  catch {}
}
