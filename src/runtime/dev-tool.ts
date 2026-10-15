// Loaded by every page a dev server serves: a bar in a corner of the page opens a drawer whose tabs show what kay knows of the page, its problems first; under `kay dev` the inspector adds its own tab and buttons.
// It runs in the browser from its own route, so it imports types only; its elements live in a shadow root on the root element, which a page swap keeps, styled by an adopted stylesheet, which a policy without inline styles allows.
import type { DevHead, DevRequest, DevResponse, DevRoute, DevRoutes } from '../server/dev'
import type { DevProblem, DevProblems } from './dev-boot'

const HOST = 'kay-dev'
const STATE_KEY = 'kay-dev'
const CHECK_PROBLEMS = 'kay-check-problems'
const REQUEST = 'kay-dev-request'
const ROUTES_URL = '/_kay/dev/routes'
const HEAD_URL = '/_kay/dev/head'
const ENV_URL = '/_kay/env.js'
const MODULE_START = 'export default '
const HEAD_HEADER = 'x-kay-dev'
const REQUEST_URL = '/_kay/dev/request'
const SIZES_URL = '/_kay/dev/sizes'
// Shown first among the response headers.
const FIRST_HEADERS = ['content-security-policy', 'content-security-policy-report-only', 'cache-control']
const PRERENDER = { 'page': 'prerendered by kay build', 'listed': 'prerendered by kay build for the paths its setting lists', 'server islands': 'prerendered by kay build, its server islands rendered on request' }
// The most problem texts a tab remembers as dismissed.
const MAX_DISMISSED = 200
// How long an error page's copy button says it copied.
const COPIED_MS = 1500
// How long the bar says what `kay dev` rebuilt, then how long it fades.
const BUILT_MS = 4000
const FADE_MS = 400
// The event the live reload script fires for each restart or stylesheet swap `kay dev` announces.
const BUILT_EVENT = 'kay-dev-built'
// A path segment, kay's `(group)`, `[param]`, `[[optional]]` and `[...rest]` names included.
const SEGMENT = String.raw`(?:\([\w@.+=-]+\)|\[{1,2}(?:\.{3})?[\w-]+\]{1,2}|[\w@.+=-])+`

// A `.kay` file a problem names, with its line and column when it gives them, not one inside a URL.
const KAY_POSITION = new RegExp(String.raw`(?<![\w@.+=:/\\)\]-])(?:[A-Za-z]:)?[\\/]?(?:${SEGMENT}[\\/])*${SEGMENT}\.kay(?::\d+(?::\d+)?)?(?!\.?\w)`, 'g')
const OPENED_POSITION = /^(.+\.\w+)(?::(\d+))?(?::(\d+))?$/

type ProblemKind = 'uncaught' | 'kay' | 'policy' | 'a11y' | 'check'

// Each kind of problem under its heading, in the order they show.
const KINDS: Record<ProblemKind, string> = {
  uncaught: 'Uncaught errors',
  kay: 'Recovered by kay',
  policy: 'Blocked by the policy',
  a11y: 'Accessibility',
  check: 'kay check',
}

const STYLE = `
:host { all: initial; --bg: #fff; --surface: #f5f5f7; --fg: #1c1c22; --muted: #6a6a76; --border: #e2e2e8; --accent: #6d28d9; --accent-soft: rgb(109 40 217 / 10%); --on-accent: #fff; --error: #c4262e; --warn: #9a5b00; --ok: #1a7f37; --shadow: 0 8px 28px rgb(0 0 0 / 18%); color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :host { --bg: #1b1b21; --surface: #25252d; --fg: #ececf1; --muted: #a2a2ae; --border: #36363f; --accent: #a78bfa; --accent-soft: rgb(167 139 250 / 16%); --on-accent: #1b1b21; --error: #ff7a7a; --warn: #f2b450; --ok: #5fd68a; --shadow: 0 8px 28px rgb(0 0 0 / 50%); color-scheme: dark; }
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
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.mark { font-weight: 700; color: var(--accent); letter-spacing: .02em; }
.built:empty { padding: 0; }
.built { max-width: min(28rem, calc(100vw - 160px)); padding: 3px 10px 3px 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); transition: opacity ${FADE_MS}ms; }
.built.fading { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .built { transition: none; } }
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
.group + .group { margin-top: 14px; }
.heading { margin: 0 0 6px; font: 600 11px/1.4 system-ui, sans-serif; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
.problem { margin: 0 0 8px; padding: 8px 10px; border-left: 3px solid var(--warn); border-radius: 4px; background: var(--surface); }
.problem pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
.meta { float: right; display: flex; align-items: center; gap: 6px; margin: -4px -6px 0 8px; }
.position { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.position:disabled { color: inherit; text-decoration: none; cursor: text; }
.problem.error { border-left-color: var(--error); }
.problem.error, .problem.warn { color: var(--fg); }
.row { padding: 6px 4px 8px; border-bottom: 1px solid var(--border); }
.row:last-child { border-bottom: 0; }
.link { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.value { white-space: pre-wrap; word-break: break-all; }
.note { color: var(--muted); }
.outline { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid var(--accent); border-radius: 2px; background: var(--accent-soft); }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin: 0; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.facts dd > div + div { margin-top: 2px; }
.ms { margin-left: 8px; color: var(--muted); }
.filter { flex: 1; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; }
.filter:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.route { display: grid; grid-template-columns: 4.5em minmax(0, 1fr) auto; gap: 2px 10px; align-items: baseline; padding: 5px 4px; border-bottom: 1px solid var(--border); }
.route:last-child { border-bottom: 0; }
.route[aria-current] { background: var(--accent-soft); border-radius: 4px; }
.route .method { color: var(--muted); }
.route .path { overflow-wrap: anywhere; }
.route .file { grid-column: 2 / -1; color: var(--muted); }
.secret { color: var(--warn); }
.good { color: var(--ok); }
.poor { color: var(--error); }
.needs { color: var(--warn); }
.image { padding: 6px 4px; border-bottom: 1px solid var(--border); }
.image:last-child { border-bottom: 0; }
.image:hover { background: var(--accent-soft); border-radius: 4px; }
.image .src { overflow-wrap: anywhere; }
.image .facts-line { color: var(--muted); }
.image .flag { color: var(--warn); }
.image:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.snippet { margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.snippet .site { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.snippet .title { margin: 2px 0; color: var(--accent); font-size: 16px; }
.snippet .description { color: var(--muted); }
.card { display: block; max-width: 100%; margin-top: 6px; border: 1px solid var(--border); border-radius: 6px; }
.json { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; }
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

// What `kay dev` says of a restart, or of a stylesheet edit it swapped in without one.
interface Built {
  id: string
  // When it was done, by the clock of the machine `kay dev` runs on, which the browser's often is.
  at: number
  changed: string
  ms: number
  styles?: boolean
}

export interface DevTabOptions {
  id: string
  label: string
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
  // The count beside the tab's name and on the bar, `error` coloring both.
  count: (count: number, tone?: 'error') => void
}

export interface DevTool {
  root: ShadowRoot
  make: <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => HTMLElementTagNameMap[K]
  tab: (options: DevTabOptions) => DevTab
  // A button of its own on the bar.
  button: (text: string, label: string) => HTMLButtonElement
  // Outlines elements of the page, `text` beside the first, until `hideOutline`.
  outline: (targets: Element[], text: string) => void
  hideOutline: () => void
  // Opens `file:line:column` in the editor, giving back why it could not; only once `setOpener` said how, as the inspector does under `kay dev`.
  open: (source: string) => Promise<string | undefined>
  opens: () => boolean
  setOpener: (open: (source: string) => Promise<string | undefined>) => void
  stop: () => void
}

export function startDevTool(doc: Document = document): DevTool {
  const win = doc.defaultView! as Window & { $kayProblems?: DevProblems, $kayBuilt?: string }
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
  const status = make('span', 'sr')
  const built = make('span', 'built')
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
  status.setAttribute('role', 'status')
  built.setAttribute('role', 'status')
  side.type = 'button'
  close.type = 'button'
  head.append(tabList, side, close)
  drawer.append(head)
  bar.append(mark, status, built)
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
    badge.setAttribute('aria-controls', drawer.id)
    badge.onclick = () => state.open && state.tab === options.id ? closeDrawer() : openTab(options.id)
    tabList.append(button)
    drawer.append(panel)
    bar.insertBefore(badge, bar.children[2 + tabs.length] ?? null)
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

        if (options.announce === true)
          status.textContent = value === 0 ? '' : options.summary?.(value) ?? ''
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

  // Arrow keys, Home and End move between the tabs, as a tab list's do.
  tabList.onkeydown = (event) => {
    const index = tabs.findIndex(tab => tab.button === root.activeElement)
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key]

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

  // The buttons kay's error pages carry, which need a script and have no other, and what `kay dev` rebuilt.
  const listening = new AbortController()
  let fading: ReturnType<typeof setTimeout> | undefined
  let hiding: ReturnType<typeof setTimeout> | undefined
  let saying: string | undefined

  // Said for the time left since the build, so the page it reloaded says it too and one opened long after does not; the live region stays, emptied, so a screen reader hears each.
  const sayBuilt = (data: string) => {
    const build = JSON.parse(data) as Built
    const left = Math.min(BUILT_MS, BUILT_MS - (Date.now() - build.at))

    if (left <= 0 || build.id === saying)
      return

    saying = build.id
    clearTimeout(fading)
    clearTimeout(hiding)
    built.textContent = `${build.changed}: ${build.styles === true ? 'stylesheets swapped' : 'restarted'} in ${build.ms} ms`
    built.classList.remove('fading')
    fading = setTimeout(() => built.classList.add('fading'), left)
    hiding = setTimeout(() => {
      built.textContent = ''
      saying = undefined
    }, left + FADE_MS)
  }

  // The live reload script keeps the last one, which may come before this loaded.
  win.addEventListener(BUILT_EVENT, event => sayBuilt((event as CustomEvent<string>).detail), { signal: listening.signal })

  if (win.$kayBuilt !== undefined)
    sayBuilt(win.$kayBuilt)

  const tool: DevTool = {
    root,
    make,
    tab,
    button,
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
      win.removeEventListener('keydown', onKeyDown, true)
      listening.abort()
      clearTimeout(fading)
      clearTimeout(hiding)
      host.remove()
    },
  }

  problems = problemsTab(doc, tool, state, save)
  request = requestTab(doc, tool)
  headTab(doc, tool, listening.signal)
  envTab(doc, tool, listening.signal)
  const vitals = watchVitals(doc.defaultView!, listening.signal)

  imagesTab(doc, tool, vitals, listening.signal)
  performanceTab(doc, tool, vitals, listening.signal)
  routesTab(doc, tool, listening.signal)
  doc.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-kay-open],button[data-kay-copy]') : null

    if (target)
      void answerErrorPage(tool, target)
  }, { signal: listening.signal })

  return tool
}

// What kay logged, what nothing caught, what the policy blocked, what the accessibility check and `kay check` found, grouped by kind, each listed once with how often it came; those the page logged leave with it on a page swap.
function problemsTab(doc: Document, tool: DevTool, state: DevState, save: () => void): { stop: () => void } {
  const win = doc.defaultView! as Window & { $kayProblems?: DevProblems }
  const tab = tool.tab({ id: 'problems', label: 'Problems', summary: count => `${count} problem${count === 1 ? '' : 's'}`, announce: true })
  const actions = tool.make('div', 'actions')
  const clear = tool.make('button', 'tool', 'Dismiss all')
  const empty = tool.make('div', 'empty', 'No problems on this page.')
  const groups = new Map(Object.entries(KINDS).map(([kind, label]) => {
    const section = tool.make('section', 'group')
    const heading = tool.make('h3', 'heading', label)
    const list = tool.make('div', 'mono')

    section.hidden = true
    section.append(heading, list)

    return [kind as ProblemKind, { section, heading, list, label }]
  }))
  const shown = new Map<string, { problem: DevProblem, kind: ProblemKind, element: HTMLElement, times: HTMLElement, count: number }>()
  const dismissed = new Set(state.dismissed)

  clear.type = 'button'
  actions.append(clear)
  tab.panel.append(actions, empty, ...[...groups.values()].map(group => group.section))

  const update = () => {
    const counts = new Map<ProblemKind, number>()
    let errors = false

    for (const { problem, kind } of shown.values()) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
      errors ||= problem.level === 'error'
    }

    tab.count(shown.size, errors ? 'error' : undefined)
    empty.hidden = shown.size > 0
    actions.hidden = shown.size === 0

    for (const [kind, group] of groups) {
      const count = counts.get(kind) ?? 0

      group.section.hidden = count === 0
      group.heading.textContent = `${group.label} (${count})`
    }
  }
  const remove = (text: string) => {
    shown.get(text)?.element.remove()
    shown.delete(text)
  }
  const dismiss = (texts: string[]) => {
    for (const text of texts) {
      dismissed.add(text)
      remove(text)
    }

    state.dismissed = [...dismissed].slice(-MAX_DISMISSED)
    save()
    tool.hideOutline()
    update()
  }
  const add = (logged: DevProblem, check = false) => {
    const problem = { ...logged, text: problemText(logged) }
    const known = shown.get(problem.text)

    // `kay check` is read again after each swap, which is no new occurrence.
    if (known && check)
      return

    if (known) {
      known.count++
      known.times.hidden = false
      known.times.textContent = `${known.count} times`

      return
    }

    if (dismissed.has(problem.text))
      return

    const kind: ProblemKind = check ? 'check' : problem.kind ?? (problem.text.startsWith('a11y ') ? 'a11y' : 'kay')
    const element = tool.make('div', `problem ${problem.level}`)
    const meta = tool.make('div', 'meta')
    const times = tool.make('span', 'note')
    const close = tool.make('button', 'tool', 'Dismiss')
    const text = tool.make('pre', 'mono')

    times.hidden = true
    close.type = 'button'
    close.setAttribute('aria-label', 'Dismiss this problem')
    close.onclick = () => dismiss([problem.text])
    meta.append(times, close)
    text.append(...withPositions(problem.text, tool))
    element.append(meta, text)

    if (kind === 'a11y') {
      element.onpointerenter = () => {
        const targets = a11yTargets(doc, problem.text)
        const colon = problem.text.indexOf(':')

        if (targets.length > 0)
          tool.outline(targets, problem.text.slice(5, colon < 0 ? undefined : colon))
      }
      element.onpointerleave = () => tool.hideOutline()
    }

    shown.set(problem.text, { problem, kind, element, times, count: 1 })
    groups.get(kind)!.list.append(element)
    update()
  }

  clear.onclick = () => dismiss([...shown.keys()])

  // What `kay check` finds now, as the page carries it: a swap brings the block of the code the server runs.
  const readChecks = () => {
    const texts = new Set(JSON.parse(doc.getElementById(CHECK_PROBLEMS)?.textContent ?? '[]') as string[])

    for (const [text, { kind }] of shown) {
      if (kind === 'check' && !texts.has(text))
        remove(text)
    }

    for (const text of texts)
      add({ level: text.startsWith('error') ? 'error' : 'warn', text }, true)

    update()
  }

  readChecks()

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

  // A page swap marks the document busy until the new page is in: the old page's problems go as it starts, and what `kay check` finds is read again once it ends.
  const swaps = new MutationObserver(() => {
    if (!doc.documentElement.hasAttribute('aria-busy')) {
      readChecks()

      return
    }

    for (const [text, { kind }] of shown) {
      if (kind !== 'check')
        remove(text)
    }

    tool.hideOutline()
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

// What served the page: the route it matched, the files that rendered it, its params and status, and how long each load took; read again after each page swap.
function requestTab(doc: Document, tool: DevTool): { stop: () => void } {
  const tab = tool.tab({ id: 'request', label: 'Request' })
  // The block the tab shows now.
  let current: string | undefined
  // What the server recorded of the response: asked for once the page is in view, and dropped if another page's block replaced this one while it was out.
  const showResponse = async (id: string, block: string, fact: (term: string, ...values: (Node | string)[]) => void, lines: (nodes: Node[], none: string) => Node[]) => {
    let recorded: DevResponse | undefined

    try {
      const response = await doc.defaultView!.fetch(`${REQUEST_URL}?id=${encodeURIComponent(id)}`, { headers: { [HEAD_HEADER]: '1' }, cache: 'no-store' })

      recorded = response.ok ? await response.json() as DevResponse : undefined
    }
    catch {
      recorded = undefined
    }

    if (current !== block)
      return

    if (recorded === undefined) {
      fact('Response', tool.make('span', 'note', 'not recorded by the server'))

      return
    }

    const hops = recorded.redirects.map(hop => tool.make('span', 'mono', `${hop.from} (${hop.status}${hop.by === undefined ? '' : `, by ${hop.by}`})`))
    const rank = (name: string) => !FIRST_HEADERS.includes(name) ? FIRST_HEADERS.length : FIRST_HEADERS.indexOf(name)
    const headers = [...recorded.headers].sort(([a], [b]) => rank(a) - rank(b))

    fact('Server time', formatMs(recorded.ms))
    fact('Redirected from', ...lines(hops, 'none'))
    fact('Headers', ...lines(headers.map(([name, value]) => tool.make('span', 'mono', `${name}: ${value}`)), 'none'))
  }
  const read = () => {
    // A swap adds the next page's block before it drops this one's.
    const block = [...doc.querySelectorAll(`script#${REQUEST}`)].at(-1)?.textContent
    const facts = tool.make('dl', 'facts')

    current = block ?? undefined

    if (block === undefined || block === null) {
      tab.panel.replaceChildren(tool.make('div', 'empty', 'kay served no request block with this page.'))

      return
    }

    const request = JSON.parse(block) as DevRequest
    const fact = (term: string, ...values: (Node | string)[]) => {
      const value = tool.make('dd')

      value.append(...values)
      facts.append(tool.make('dt', '', term), value)
    }
    const lines = (nodes: Node[], none: string) => nodes.length === 0
      ? [tool.make('span', 'note', none)]
      : nodes.map((node) => {
        const line = tool.make('div')

        line.append(node)

        return line
      })
    const params = Object.entries(request.params)
    const total = request.loads.reduce((sum, load) => sum + (load.ms ?? 0), 0)

    fact('Route', request.route === undefined ? tool.make('span', 'note', 'none matched') : tool.make('span', 'mono', request.route))
    fact('Status', tool.make('span', request.status >= 400 ? 'error' : '', request.error === undefined ? String(request.status) : `${request.status} ${request.error}`))
    fact('Page', positionButton(tool, request.page))
    fact('Layouts', ...lines(request.layouts.map(file => positionButton(tool, file)), 'none'))
    fact('Params', ...lines(params.map(([name, value]) => tool.make('span', 'mono', `${name} = ${JSON.stringify(value)}`)), 'none'))

    fact('Locale', request.locale)
    // Read off the page once the guards pass, so a request one refused says nothing of it.
    const refusedByGuard = request.guards.some(guard => guard.outcome !== 'passed' && guard.outcome !== 'did not run')

    fact('Rendered', refusedByGuard ? 'not known, a guard refused the request' : request.prerender === undefined ? 'on request' : `on request here, ${PRERENDER[request.prerender]}`)
    fact('Guards', ...lines(request.guards.map((guard) => {
      const line = tool.make('span')

      line.append(positionButton(tool, guard.file), tool.make('span', guard.outcome === 'passed' ? 'ms mono' : guard.outcome === 'did not run' ? 'note' : 'error', guard.outcome))

      return line
    }), 'none'))

    fact(request.loads.length > 1 ? `Loads, ${formatMs(total)}` : 'Loads', ...lines(request.loads.map((load) => {
      const line = tool.make('span')

      line.append(positionButton(tool, load.file), tool.make('span', 'ms mono', load.ms === undefined ? 'not timed' : formatMs(load.ms)))

      return line
    }), 'none'))
    tab.panel.replaceChildren(facts)
    void showResponse(request.id, block, fact, lines)
  }
  // A page swap, or the patch a page without one gets, brings the next page's block.
  const swaps = new MutationObserver((records) => {
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => (node as Element).id === REQUEST)))
      read()
  })

  read()
  swaps.observe(doc.head, { childList: true })

  return { stop: () => swaps.disconnect() }
}

// A tag of the page's head, by its `name` or `property`.
function metaContent(head: HTMLHeadElement, key: string): string | undefined {
  const content = head.querySelector(`meta[name="${key}"],meta[property="${key}"]`)?.getAttribute('content')?.trim()

  return content === '' ? undefined : content
}

// The page's head as it is now: the search result it makes, its title, description, canonical link, alternates and robots tag, its og and twitter tags with the card image, and its JSON-LD blocks, each parsed or with its error; what `kay check` would flag in it comes from the server, which also says whether the sitemap lists the page. Read as the tab shows and again after each page swap.
function headTab(doc: Document, tool: DevTool, signal: AbortSignal): void {
  const win = doc.defaultView!
  let reread: () => void = () => undefined
  const tab = tool.tab({ id: 'head', label: 'Head', shown: () => reread() })
  // A swap while a fetch is out asks again; the latest answer wins.
  let asked = 0
  const read = async () => {
    const ask = ++asked
    // One snapshot of the head, so a swap during the fetch cannot mix two heads in what is shown.
    const head = doc.head.cloneNode(true) as HTMLHeadElement
    const href = win.location.href
    const path = win.location.pathname
    const title = head.querySelector('title')?.textContent?.trim() ?? ''
    const description = metaContent(head, 'description')
    const canonical = head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? undefined
    let server: DevHead | undefined
    let failure: string | undefined

    try {
      const response = await win.fetch(HEAD_URL, { method: 'POST', headers: { 'content-type': 'application/json', [HEAD_HEADER]: '1' }, body: JSON.stringify({ path, head: head.outerHTML }), cache: 'no-store' })

      if (!response.ok)
        throw new Error(`the server answered ${response.status}`)

      server = await response.json() as DevHead
    }
    catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (ask !== asked)
      return

    const limit = server?.descriptionLength
    const children: Node[] = []
    const facts = tool.make('dl', 'facts')
    const fact = (term: string, ...values: (Node | string)[]) => {
      const value = tool.make('dd')

      value.append(...values)
      facts.append(tool.make('dt', '', term), value)
    }
    const none = () => tool.make('span', 'note', 'none')
    const problems = server?.problems ?? []

    tab.count(problems.length, problems.some(problem => problem.severity === 'error') ? 'error' : undefined)

    if (failure !== undefined)
      children.push(tool.make('div', 'empty', `Could not check the head: ${failure}`))

    for (const problem of problems) {
      const element = tool.make('div', `problem ${problem.severity === 'error' ? 'error' : 'warn'}`)

      element.append(tool.make('pre', '', [problem.message, problem.note, problem.help === undefined ? undefined : `help: ${problem.help}`].filter(Boolean).join('\n')))
      children.push(element)
    }

    const snippet = tool.make('div', 'snippet')

    snippet.append(
      tool.make('div', 'site', canonical ?? href),
      tool.make('div', 'title', title === '' ? 'No title' : title),
      tool.make('div', 'description', description === undefined ? 'No description' : limit !== undefined && description.length > limit ? `${description.slice(0, limit).trimEnd()}...` : description),
    )
    children.push(snippet)

    const cut = limit !== undefined && description !== undefined && description.length > limit

    fact('Title', title === '' ? none() : `${title} (${title.length} characters)`)
    fact('Description', description === undefined ? none() : `${description} (${description.length}${limit === undefined ? '' : ` of ${limit}`} characters${cut ? ', cut in results' : ''})`)
    fact('Canonical', canonical ?? none())

    const alternates = [...head.querySelectorAll('link[rel="alternate"][hreflang]')].map(link => `${link.getAttribute('hreflang')}: ${link.getAttribute('href')}`)

    fact('Alternates', ...alternates.length === 0 ? [none()] : alternates.map(line => tool.make('div', 'mono', line)))
    fact('Robots', metaContent(head, 'robots') ?? tool.make('span', 'note', 'no tag, indexable'))

    if (server !== undefined)
      fact('Sitemap', server.sitemap === 'error' ? tool.make('span', 'error', `could not be read: ${server.sitemapError ?? 'unknown error'}`) : server.sitemap === 'none' ? tool.make('span', 'note', 'none, the site has no origin (set site in kay.config.ts or SITE_URL)') : server.sitemap === 'listed' ? 'listed' : 'not listed')

    children.push(facts)

    for (const [heading, prefix] of [['Open Graph', 'og:'], ['Twitter', 'twitter:']] as const) {
      const tags = [...head.querySelectorAll('meta')].flatMap((meta) => {
        const key = meta.getAttribute('property') ?? meta.getAttribute('name') ?? ''

        return key.startsWith(prefix) ? [[key, meta.getAttribute('content') ?? ''] as const] : []
      })
      const section = tool.make('section', 'group')
      const list = tool.make('dl', 'facts')

      for (const [key, content] of tags)
        list.append(tool.make('dt', 'mono', key), tool.make('dd', 'mono', content))

      section.append(tool.make('h3', 'heading', `${heading} (${tags.length})`), tags.length === 0 ? tool.make('div', 'note', 'No tags.') : list)
      children.push(section)
    }

    const image = metaContent(head, 'og:image') ?? metaContent(head, 'twitter:image')

    if (image !== undefined) {
      try {
        const url = new URL(image, href)
        const card = tool.make('img', 'card')

        // The site's own origin is not the dev server's, so the card is read from here.
        card.src = server?.site !== undefined && url.origin === new URL(server.site).origin ? `${win.location.origin}${url.pathname}${url.search}` : url.href
        card.alt = 'The social card image'
        children.push(card)
      }
      catch {
        children.push(tool.make('div', 'error', `The social card image is not a valid URL: ${image}`))
      }
    }

    const blocks = [...head.querySelectorAll('script[type="application/ld+json"]')]
    const ld = tool.make('section', 'group')

    ld.append(tool.make('h3', 'heading', `JSON-LD (${blocks.length})`))

    for (const block of blocks) {
      try {
        ld.append(tool.make('pre', 'json mono', JSON.stringify(JSON.parse(block.textContent ?? ''), null, 2)))
      }
      catch (error) {
        ld.append(tool.make('div', 'error', `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`))
      }
    }

    if (blocks.length === 0)
      ld.append(tool.make('div', 'note', 'None.'))

    children.push(ld)
    tab.panel.replaceChildren(...children)
  }

  reread = () => void read()
  let scheduled = false
  // A page swap patches the head in place, in many small changes: one read follows them.
  const swaps = new MutationObserver(() => {
    if (tab.panel.hidden === true || scheduled)
      return

    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      void read()
    })
  })

  swaps.observe(doc.head, { childList: true, subtree: true, characterData: true, attributes: true })
  signal.addEventListener('abort', () => swaps.disconnect())
}

// Names a variable of a secret goes by, and the shapes of the values of one: a URL carrying a password, a token with a well-known prefix, a long run of random-looking characters.
const SECRET_NAME = /SECRET|PASSW(?:OR)?D|PRIVATE|TOKEN|CREDENTIAL|AUTH_?(?:KEY|TOKEN|SECRET)|(?:^|_)(?:DATABASE|DB|POSTGRES|PG|MYSQL|REDIS|MONGO(?:DB)?)_URL$/i
// A key may be public by design (a map or analytics key), so its name alone only calls for a look.
const KEY_NAME = /(?:^|_)KEY$/i
const PUBLIC_NAME = /PUBLIC|PUBLISHABLE/i
const SECRET_PREFIX = /^(?:sk|rk)_(?:live|test)_|^sk-|^gh[pousr]_|^github_pat_|^glpat-|^npm_|^SG\.|^xox[abprs]-|^AKIA[0-9A-Z]{16}|^eyJ[\w-]+\.[\w-]+\.|^-----BEGIN /
const URL_PASSWORD = /^[a-z][\w+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i
const HEX_SECRET = /^[0-9a-f]{32,}$/i
const RANDOM_LIKE = /^[\w+/=.-]{24,}$/
// Bits per character of a run of random base64 sits near 5; words and paths stay under 4.
const RANDOM_ENTROPY = 4

function entropy(value: string): number {
  const counts = new Map<string, number>()

  for (const character of value)
    counts.set(character, (counts.get(character) ?? 0) + 1)

  return -[...counts.values()].reduce((sum, count) => sum + count / value.length * Math.log2(count / value.length), 0)
}

// Why a public variable looks like a secret, if it does; `maybe` when only its name is a key's, which may be public by design.
function secretReason(name: string, value: unknown): { reason: string, maybe: boolean } | undefined {
  if (SECRET_NAME.test(name))
    return { reason: 'its name looks like a secret', maybe: false }

  if (typeof value === 'string') {
    if (URL_PASSWORD.test(value))
      return { reason: 'its value is a URL with a password', maybe: false }

    if (SECRET_PREFIX.test(value))
      return { reason: 'its value looks like a token', maybe: false }

    if (HEX_SECRET.test(value))
      return { reason: 'its value is a long hexadecimal string, like a token', maybe: false }

    // A path or a URL has slashes in the places a base64 string has none.
    if (RANDOM_LIKE.test(value) && !value.startsWith('/') && !value.includes('://') && entropy(value) >= RANDOM_ENTROPY)
      return { reason: 'its value looks random, like a key', maybe: false }
  }

  return KEY_NAME.test(name) && !PUBLIC_NAME.test(name) ? { reason: 'its name is a key\'s, which is fine if the key is public by design, such as a map\'s', maybe: true } : undefined
}

// The variables `publicEnv` sends every visitor, read from the module the browser loads, so a secret declared public is seen; fetched as the tab shows and again after each restart.
function envTab(doc: Document, tool: DevTool, signal: AbortSignal): void {
  const win = doc.defaultView!
  let reread: () => void = () => undefined
  const tab = tool.tab({ id: 'env', label: 'Env', shown: () => reread() })
  let asked = 0
  const read = async () => {
    const ask = ++asked
    let values: Record<string, unknown> | undefined
    let failure: string | undefined

    try {
      const response = await win.fetch(ENV_URL, { cache: 'no-store' })

      // The route is there only when `publicEnv` is declared; any other answer is a failure to read it.
      if (response.status !== 404) {
        if (!response.ok)
          throw new Error(`the server answered ${response.status}`)

        const text = await response.text()

        if (!(response.headers.get('content-type') ?? '').includes('javascript') || !text.startsWith(MODULE_START))
          throw new Error('the module is not the one kay sends')

        values = JSON.parse(text.slice(MODULE_START.length)) as Record<string, unknown>
      }
    }
    catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (ask !== asked)
      return

    if (failure !== undefined) {
      tab.count(0)
      tab.panel.replaceChildren(tool.make('div', 'empty', `Could not read the public env: ${failure}`))

      return
    }

    if (values === undefined) {
      tab.count(0)
      tab.panel.replaceChildren(tool.make('div', 'empty', 'This app sends no public env to the browser: kay.config.ts declares no `publicEnv`.'))

      return
    }

    const entries = Object.entries(values)
    const facts = tool.make('dl', 'facts')
    let flagged = 0

    for (const [name, value] of entries) {
      const found = secretReason(name, value)
      const shown = tool.make('dd')

      shown.append(tool.make('span', 'mono', typeof value === 'string' ? value : JSON.stringify(value)))

      if (found?.maybe === true) {
        shown.append(tool.make('div', 'note', `Every visitor reads this: ${found.reason}.`))
      }
      else if (found !== undefined) {
        flagged++
        shown.append(tool.make('div', 'secret', `Every visitor reads this, and ${found.reason}. Keep a secret in defineEnv, read on the server alone.`))
      }

      facts.append(tool.make('dt', 'mono', name), shown)
    }

    tab.count(flagged, flagged > 0 ? 'error' : undefined)
    tab.panel.replaceChildren(tool.make('div', 'note', `${entries.length} variable${entries.length === 1 ? '' : 's'} sent to every visitor at ${ENV_URL}.`), entries.length === 0 ? tool.make('div', 'empty', 'The app sends no public env: `publicEnv` declares no variable.') : facts)
  }

  reread = () => void read()
  win.addEventListener(BUILT_EVENT, () => {
    if (tab.panel.hidden === false)
      reread()
  }, { signal })
}

// An image served more than this many times the pixels it is drawn with is flagged: the ladder's widths are at most 2 apart, so a variant picked for the size drawn is under 2 times as wide, 4 times the pixels, even at its worst.
const OVERSIZED = 4
const IMAGE_ROUTE = '/_kay/image'
// The files `kay build` wrote for the variants.
const IMAGE_FILES = '/_kay/images/'
// How many formats are asked of the server at once, and how long one gets.
const IMAGE_REQUESTS = 4
const IMAGE_REQUEST_MS = 3000
const VARIANT_FILE = /-(card|\d+)(?:-(\d+x\d+))?\.(?:webp|avif|jpg)$/
// The accept header browsers send for an image, which the image route picks AVIF or WebP from.
const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'

interface ImageInfo {
  image: HTMLImageElement
  // The URL in use, shortened to its path and the `src` of the image route.
  url: string
  // The address the browser loaded.
  src: string
  variant: string
  natural: string
  drawn: string
  // What is wrong with it, one sentence each.
  flags: string[]
  lcp: boolean
}

function parseUrl(src: string, base: string): URL | undefined {
  try {
    return new URL(src, base)
  }
  catch {
    return undefined
  }
}

// What kay's URL for an image says it is: a width of the ladder, a crop, the share card, a file `kay build` wrote, or an image kay did not resize.
function imageVariant(src: string, origin: string): string {
  const url = parseUrl(src, origin)

  if (url === undefined || url.origin !== origin)
    return 'not resized by kay'

  if (url.pathname === IMAGE_ROUTE) {
    const crop = url.searchParams.get('crop')

    return url.searchParams.has('card') ? 'share card, 1200x630, resized on request' : `${url.searchParams.get('w') ?? 'original'}w${crop === null ? '' : `, cut ${crop}`}, resized on request`
  }

  let path = url.pathname

  try {
    path = decodeURIComponent(path)
  }
  catch {
    // A name that is not valid percent-encoding is read as it is.
  }

  const file = VARIANT_FILE.exec(path)

  if (path.startsWith('/_kay/images/') && file)
    return `${file[1] === 'card' ? 'share card' : `${file[1]}w`}${file[2] === undefined ? '' : `, cut ${file[2]}`}, written by kay build`

  return 'not resized by kay'
}

// Every image of the page with what it is, what it is drawn at and what is wrong with it; `lcp` is the element the browser reported as the largest paint.
function pageImages(doc: Document, lcp: Element | undefined): ImageInfo[] {
  const win = doc.defaultView!
  const density = win.devicePixelRatio || 1

  return [...doc.querySelectorAll('img')].flatMap((image) => {
    const src = image.currentSrc === '' ? image.getAttribute('src') : image.currentSrc

    if (src === null || src === '' || src.startsWith('data:'))
      return []

    const box = image.getBoundingClientRect()
    const flags: string[] = []
    const served = image.naturalWidth * image.naturalHeight
    const needed = box.width * box.height * density * density

    if (served > 0 && needed > 0 && served > needed * OVERSIZED)
      flags.push(`served ${Math.round(served / needed)} times the pixels it is drawn with, give it a smaller width or \`sizes\``)

    if (!image.hasAttribute('width') || !image.hasAttribute('height'))
      flags.push('no width and height, so the page shifts as it loads')

    if (image.loading === 'lazy' && box.bottom > 0 && box.top < win.innerHeight && box.right > 0 && box.left < win.innerWidth)
      flags.push('lazy-loaded but in view, which delays it')

    return [{
      image,
      url: src.replace(win.location.origin, ''),
      src,
      variant: imageVariant(src, win.location.origin),
      natural: image.naturalWidth > 0 ? `${image.naturalWidth}x${image.naturalHeight}` : 'not loaded',
      drawn: `${Math.round(box.width)}x${Math.round(box.height)}${density === 1 ? '' : ` at ${density}x`}`,
      flags,
      lcp: image === lcp,
    }]
  })
}

// The Web Vitals "good" and "poor" limits: a value up to the first is good, past the second poor.
const VITAL_LIMITS = { lcp: [2500, 4000], cls: [0.1, 0.25], inp: [200, 500] } as const
// A new window of layout shifts starts after a gap this long, and one never lasts past the second.
const SHIFT_GAP_MS = 1000
const SHIFT_WINDOW_MS = 5000

type VitalName = keyof typeof VITAL_LIMITS

interface Vitals {
  // The page the browser loaded them for: a link swapping in another page starts no new load.
  path: string
  // The largest paint so far, the element it painted when it is on the page.
  lcp?: { ms: number, element: Element | undefined } | undefined
  cls: number
  inp?: number | undefined
  // Called with the vital that changed.
  changed: ((name: VitalName) => void)[]
}

function rateVital(name: VitalName, value: number): 'good' | 'needs' | 'poor' {
  const [good, poor] = VITAL_LIMITS[name]

  return value <= good ? 'good' : value <= poor ? 'needs' : 'poor'
}

interface ShiftEntry extends PerformanceEntry {
  value: number
  hadRecentInput: boolean
}

interface EventEntry extends PerformanceEntry {
  interactionId?: number
  target?: Node | null
}

// The page's LCP, CLS and INP as the browser reports them from the moment the tool loads, earlier entries included; a browser without an entry type leaves that vital out.
function watchVitals(win: Window & typeof globalThis, signal: AbortSignal): Vitals {
  const vitals: Vitals = { path: win.location.pathname, cls: 0, changed: [] }
  const observe = (type: string, handle: (entries: PerformanceEntry[]) => void, options: PerformanceObserverInit & { durationThreshold?: number } = {}) => {
    try {
      const observer = new win.PerformanceObserver(list => handle(list.getEntries()))

      observer.observe({ type, buffered: true, ...options })
      signal.addEventListener('abort', () => observer.disconnect())
    }
    catch {
      // Not every browser reports every type.
    }
  }
  const announce = (name: VitalName) => {
    for (const listener of vitals.changed)
      listener(name)
  }
  // The layout shifts without a recent input, in windows: the vital is the worst window.
  let windowStart = 0
  let windowEnd = 0
  let windowValue = 0
  // The slowest event of each interaction.
  const interactions = new Map<number, number>()

  observe('largest-contentful-paint', (entries) => {
    const entry = entries.at(-1) as (PerformanceEntry & { element?: Element | null, renderTime: number, loadTime: number }) | undefined

    if (entry) {
      vitals.lcp = { ms: entry.renderTime || entry.loadTime || entry.startTime, element: entry.element ?? undefined }
      announce('lcp')
    }
  })
  observe('layout-shift', (entries) => {
    const before = vitals.cls

    for (const entry of entries as ShiftEntry[]) {
      if (entry.hadRecentInput)
        continue

      if (windowValue > 0 && entry.startTime - windowEnd < SHIFT_GAP_MS && entry.startTime - windowStart < SHIFT_WINDOW_MS) {
        windowValue += entry.value
      }
      else {
        windowStart = entry.startTime
        windowValue = entry.value
      }

      windowEnd = entry.startTime
      vitals.cls = Math.max(vitals.cls, windowValue)
    }

    if (vitals.cls !== before)
      announce('cls')
  })
  observe('event', (entries) => {
    const before = vitals.inp

    for (const entry of entries as EventEntry[]) {
      // The tool's own clicks are not the page's.
      if (entry.target instanceof win.Element && entry.target.closest(HOST) !== null)
        continue

      if (entry.interactionId !== undefined && entry.interactionId > 0)
        interactions.set(entry.interactionId, Math.max(interactions.get(entry.interactionId) ?? 0, entry.duration))
    }

    // The longest interaction, or the 98th percentile of many, as the metric is defined.
    const slowest = [...interactions.values()].sort((a, b) => b - a)

    vitals.inp = slowest[Math.min(slowest.length - 1, Math.floor(slowest.length / 50))]

    if (vitals.inp !== before)
      announce('inp')
  }, { durationThreshold: 16 })

  return vitals
}

// The images of the page: the variant and format each got, the size served against the size drawn, which one is the largest paint, and what is wrong with it; hovering or focusing a row outlines the image, and the list is read again as the tab shows and as the page changes under it.
function imagesTab(doc: Document, tool: DevTool, vitals: Vitals, signal: AbortSignal): void {
  const win = doc.defaultView!
  let asked = 0
  let reread: () => void = () => undefined
  const tab = tool.tab({ id: 'images', label: 'Images', shown: () => reread() })
  // What the server answered an image with, by address, until the next restart; an answer that failed is asked again.
  const answers = new Map<string, Promise<{ text: string, kept: boolean }>>()
  const slots = limiter(IMAGE_REQUESTS)
  let scheduled = false
  const schedule = () => {
    if (tab.panel.hidden === true || scheduled)
      return

    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      reread()
    })
  }

  vitals.changed.push((name) => {
    if (name === 'lcp')
      schedule()
  })

  const read = async () => {
    const ask = ++asked
    const images = pageImages(doc, vitals.lcp?.element?.isConnected === true ? vitals.lcp.element : undefined)
    const body = tool.make('div')
    const formats: HTMLElement[] = []

    tab.count(images.reduce((sum, info) => sum + info.flags.length, 0), images.some(info => info.flags.length > 0) ? 'error' : undefined)
    tool.hideOutline()

    if (images.length === 0) {
      tab.panel.replaceChildren(tool.make('div', 'empty', 'No images on this page.'))

      return
    }

    for (const info of images) {
      const row = tool.make('div', 'image')
      const format = tool.make('span', '', 'format...')
      const detail = tool.make('div', 'facts-line')
      const label = info.lcp ? 'largest paint' : 'image'

      formats.push(format)
      row.tabIndex = 0
      row.setAttribute('role', 'group')
      row.setAttribute('aria-label', info.url)
      row.append(tool.make('div', 'src mono', info.url))
      detail.append(info.variant, ' - ', format, ` - served ${info.natural}, drawn ${info.drawn}`, ...info.lcp ? [' - ', tool.make('strong', '', 'largest contentful paint')] : [])
      row.append(detail)

      for (const flag of info.flags)
        row.append(tool.make('div', 'flag', flag))

      row.onpointerenter = row.onfocus = () => tool.outline([info.image], label)
      row.onpointerleave = row.onblur = () => tool.hideOutline()
      body.append(row)
    }

    tab.panel.replaceChildren(body, tool.make('div', 'note', 'Formats are those the server picks for a browser accepting AVIF and WebP.'))

    // A few at a time, so a page of many images does not ask the server for all of them at once, and one that hangs holds back one slot only.
    await Promise.all(images.map(async (info, index) => {
      let answer = answers.get(info.src)

      if (answer === undefined) {
        answer = slots(async () => imageFormat(win, info.image, info.src))
        answers.set(info.src, answer)
      }

      const { text, kept } = await answer

      if (!kept && answers.get(info.src) === answer)
        answers.delete(info.src)

      if (ask === asked)
        formats[index]!.textContent = text
    }))
  }

  reread = () => void read()
  doc.addEventListener('load', schedule, { capture: true, signal })
  doc.addEventListener('error', schedule, { capture: true, signal })
  win.addEventListener(BUILT_EVENT, () => {
    answers.clear()
    schedule()
  }, { signal })

  const changes = new MutationObserver(schedule)

  changes.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'sizes', 'loading', 'width', 'height'] })
  signal.addEventListener('abort', () => changes.disconnect())
}

// A limit on how many calls of a kind run at once; the rest wait their turn.
function limiter(max: number): <T>(run: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: (() => void)[] = []

  return async (run) => {
    if (running >= max)
      await new Promise<void>(resolve => waiting.push(resolve))

    running++

    try {
      return await run()
    }
    finally {
      running--
      waiting.shift()?.()
    }
  }
}

// The format and size of an image. Only an image of kay's own routes loaded by the page is asked of the server, with a HEAD request: the route's code is kay's, it writes no variant the page did not already draw, and the type is negotiated so the URL does not say it. Any other image could run the app's own handler, so its size comes from the browser's resource timing and its format is not looked up. `kept` is false for an answer worth asking for again.
async function imageFormat(win: Window & typeof globalThis, image: HTMLImageElement, src: string): Promise<{ text: string, kept: boolean }> {
  try {
    // The page's policy lets it ask its own origin only.
    const url = parseUrl(src, win.location.href)

    if (url === undefined)
      return { text: 'format unknown', kept: false }

    if (url.origin !== win.location.origin)
      return { text: 'on another host', kept: true }

    if (url.pathname !== IMAGE_ROUTE && !url.pathname.startsWith(IMAGE_FILES))
      return { text: `format not looked up, as kay does not serve it${transferred(win, url.href)}`, kept: true }

    if (!image.complete || image.naturalWidth === 0)
      return { text: 'not loaded', kept: false }

    const response = await win.fetch(src, { method: 'HEAD', headers: { accept: IMAGE_ACCEPT }, cache: 'no-store', signal: AbortSignal.timeout(IMAGE_REQUEST_MS) })
    const type = response.headers.get('content-type') ?? ''

    if (!response.ok)
      return { text: `the server answered ${response.status}`, kept: false }

    const format = type.startsWith('image/') ? type.slice('image/'.length) : 'not an image'
    const bytes = Number(response.headers.get('content-length'))

    return { text: bytes > 0 ? `${format}, ${formatBytes(bytes)}` : format, kept: true }
  }
  catch {
    return { text: 'format unknown', kept: false }
  }
}

// What the browser says it downloaded for an address, as ` - 12.0 KB`; nothing when it did not report it.
function transferred(win: Window & typeof globalThis, href: string): string {
  const entry = win.performance.getEntriesByName(href, 'resource').at(-1) as PerformanceResourceTiming | undefined

  return entry !== undefined && entry.encodedBodySize > 0 ? `, ${formatBytes(entry.encodedBodySize)}` : ''
}

interface BuiltSizes {
  route: string
  js: number
  css: number
  estimated: boolean
  exported: boolean
  built: number
}

// What the last `kay build` measured for this page's route, which the server reads from the report kept under `.kay`; nothing when no build was made or the route is not in it.
async function builtSizes(win: Window & typeof globalThis): Promise<BuiltSizes | undefined> {
  try {
    const response = await win.fetch(`${SIZES_URL}?path=${encodeURIComponent(win.location.pathname)}`, { headers: { [HEAD_HEADER]: '1' }, cache: 'no-store', signal: AbortSignal.timeout(IMAGE_REQUEST_MS) })

    return response.ok ? ((await response.json()) as { sizes?: BuiltSizes }).sizes : undefined
  }
  catch {
    return undefined
  }
}

// How long ago, in the largest whole unit.
function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)

  if (minutes < 1)
    return 'less than a minute ago'

  if (minutes < 60)
    return `${minutes} min ago`

  if (minutes < 1440)
    return `${Math.floor(minutes / 60)} h ago`

  const days = Math.floor(minutes / 1440)

  return days === 1 ? '1 day ago' : `${days} days ago`
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

// The gzipped size of some text, as a server would send it.
async function gzipSize(text: string): Promise<number> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))

  return (await new Response(stream).arrayBuffer()).byteLength
}

// The page's HTML as the browser holds it, without the dev tool: what the server sent, as live reload and swaps changed it, so the server renders nothing again.
function deliveredHtml(doc: Document): string {
  const copy = doc.documentElement.cloneNode(true) as HTMLElement

  for (const host of copy.querySelectorAll(HOST))
    host.remove()

  return `<!doctype html>${copy.outerHTML}`
}

interface Weight {
  html: number
  css: { url: string, bytes: number }[]
  entry: { url: string, bytes: number }[]
  islands: { url: string, bytes: number }[]
  other: { url: string, bytes: number }[]
}

// A built file's name without its hash, `counter` of `counter-48rr5xzz.js`.
const HASHED_NAME = /^(.*)-[a-z\d]{8}\.(?:js|css)$/

// The page's HTML (the document the browser holds), the stylesheets and scripts it loaded gzipped, as sent in development: not minified, with the dev-only code, so larger than `kay build` makes them. The dev tool's own scripts, the live reload and the public env stay out; a file rebuilt since it first loaded counts once, in its latest form, and a stylesheet only while the page links it.
async function pageWeight(doc: Document): Promise<Weight> {
  const win = doc.defaultView!
  const here = win.location.origin
  const linked = new Set([...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(link => new URL(link.href, here).pathname))
  const latest = new Map<string, string>()
  const components = new Set([...doc.querySelectorAll('[data-component]')].map(element => (element.getAttribute('data-component') ?? '').replace(/^.*\//, '').replace(/\.kay$/, '')))

  for (const entry of win.performance.getEntriesByType('resource')) {
    const url = parseUrl(entry.name, here)

    if (url === undefined || url.origin !== here || !(/\.(?:js|css)$/).test(url.pathname) || url.pathname.startsWith('/_kay/dev/') || url.pathname === '/_kay/env.js')
      continue

    if (url.pathname.endsWith('.css') && !linked.has(url.pathname))
      continue

    const file = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
    const name = HASHED_NAME.exec(file)?.[1]

    // Later entries are later loads: the hash of the entry or an island rebuilt since replaces the one before. Any other file keeps its address, as a name ending in 8 letters, `chart-calendar.js`, may not be hashed at all.
    latest.set(name === undefined || !(name === 'entry' || components.has(name)) ? url.pathname : `${url.pathname.slice(0, url.pathname.length - file.length)}${name}.${file.slice(file.lastIndexOf('.') + 1)}`, url.pathname)
  }

  const sized = async (url: string, accept = '*/*') => {
    const response = await win.fetch(url, { headers: { accept } })

    if (!response.ok)
      throw new Error(`${url} answered ${response.status}`)

    return gzipSize(await response.text())
  }
  const settled = await Promise.allSettled([...latest.values()].map(async url => ({ url, bytes: await sized(url) })))
  const files = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  const isEntry = (url: string) => url.slice(url.lastIndexOf('/') + 1).startsWith('entry-')
  const isIsland = (url: string) => components.has(HASHED_NAME.exec(url.slice(url.lastIndexOf('/') + 1))?.[1] ?? '')
  const scripts = files.filter(file => file.url.endsWith('.js'))

  return {
    html: await gzipSize(deliveredHtml(doc)),
    css: files.filter(file => file.url.endsWith('.css')),
    entry: scripts.filter(file => isEntry(file.url)),
    islands: scripts.filter(file => !isEntry(file.url) && isIsland(file.url)),
    other: scripts.filter(file => !isEntry(file.url) && !isIsland(file.url)),
  }
}

// The page's weight and Web Vitals: LCP, CLS and INP each against its good limit as the page is used, and the HTML, CSS and JS gzipped, the island chunks split from the entry.
function performanceTab(doc: Document, tool: DevTool, vitals: Vitals, signal: AbortSignal): void {
  let scheduled = false
  let reread: () => void = () => undefined
  const tab = tool.tab({ id: 'performance', label: 'Performance', shown: () => reread() })
  const vitalsPanel = tool.make('dl', 'facts')
  const weightPanel = tool.make('div')
  const loadNote = tool.make('div', 'note')
  let asked = 0
  const vital = (name: VitalName, label: string, value: number | undefined, format: (value: number) => string, detail?: string) => {
    const [good, poor] = VITAL_LIMITS[name]
    const shown = tool.make('dd')

    if (value === undefined) {
      shown.append(tool.make('span', 'note', name === 'inp' ? 'no interaction yet' : 'not reported yet'))
    }
    else {
      const rating = rateVital(name, value)

      shown.append(tool.make('span', rating, `${format(value)} - ${rating === 'needs' ? 'needs improvement' : rating}`), tool.make('span', 'note', ` (good up to ${format(good)}, poor past ${format(poor)})`))

      if (detail !== undefined)
        shown.append(tool.make('div', 'note', detail))
    }

    vitalsPanel.append(tool.make('dt', '', label), shown)
  }
  const renderVitals = () => {
    const element = vitals.lcp?.element
    const painted = element === undefined ? undefined : `${element.localName}${element.id === '' ? '' : `#${element.id}`}`
    const rated = [vitals.lcp?.ms === undefined ? undefined : rateVital('lcp', vitals.lcp.ms), vitals.inp === undefined ? undefined : rateVital('inp', vitals.inp), rateVital('cls', vitals.cls)]
    const bad = rated.filter(rating => rating !== undefined && rating !== 'good').length

    loadNote.textContent = doc.defaultView!.location.pathname === vitals.path ? `Measured on the load of ${vitals.path}.` : `Measured on the load of ${vitals.path}, not on this page: a link swapped it in without a load.`
    vitalsPanel.replaceChildren()
    vital('lcp', 'LCP', vitals.lcp?.ms, ms => `${Math.round(ms)} ms`, painted === undefined ? undefined : `painted: ${painted}`)
    vital('cls', 'CLS', vitals.cls, value => value.toFixed(3))
    vital('inp', 'INP', vitals.inp, ms => `${Math.round(ms)} ms`)
    tab.count(bad, bad > 0 ? 'error' : undefined)
  }
  const reload = async () => {
    const ask = ++asked

    renderVitals()
    weightPanel.replaceChildren(tool.make('div', 'note', 'Measuring the weight...'))

    let weight: Weight

    try {
      weight = await pageWeight(doc)
    }
    catch (error) {
      if (ask === asked)
        weightPanel.replaceChildren(tool.make('div', 'empty', `Could not measure the weight: ${error instanceof Error ? error.message : String(error)}`))

      return
    }

    if (ask !== asked)
      return

    const facts = tool.make('dl', 'facts')
    const total = (files: { bytes: number }[]) => files.reduce((sum, file) => sum + file.bytes, 0)
    const row = (term: string, text: string, files: { url: string, bytes: number }[] = []) => {
      const value = tool.make('dd')

      value.append(text)

      for (const file of files)
        value.append(tool.make('div', 'note mono', `${file.url} ${formatBytes(file.bytes)}`))

      facts.append(tool.make('dt', '', term), value)
    }

    row('HTML', formatBytes(weight.html))
    row('CSS', formatBytes(total(weight.css)), weight.css)
    row('JS', formatBytes(total(weight.entry) + total(weight.islands) + total(weight.other)))
    row('Entry', formatBytes(total(weight.entry)), weight.entry)
    row('Island chunks', weight.islands.length === 0 ? 'none loaded' : formatBytes(total(weight.islands)), weight.islands)
    row('Other chunks', weight.other.length === 0 ? 'none loaded' : formatBytes(total(weight.other)), weight.other)
    weightPanel.replaceChildren(tool.make('h3', 'heading', 'Weight, gzipped'), facts, tool.make('div', 'note', 'Dev sizes: not minified and with the dev-only code, so `kay build` makes them smaller.'))

    const built = await builtSizes(doc.defaultView!)

    if (ask !== asked || built === undefined)
      return

    const production = tool.make('dl', 'facts')
    const mark = built.estimated ? '~' : ''

    production.append(tool.make('dt', '', 'JS'), tool.make('dd', '', `${mark}${formatBytes(built.js)}`), tool.make('dt', '', 'CSS'), tool.make('dd', '', formatBytes(built.css)))
    weightPanel.append(tool.make('h3', 'heading', 'Last kay build'), production, tool.make('div', 'note', `Route ${built.route}, ${built.exported ? 'static export' : 'server build'} made ${ago(Date.now() - built.built)}, gzipped, minified and without the dev-only code${built.estimated ? '; ~ marks an estimate, as no page of the route was prerendered, the scripts being what its components can load' : ''}. Build again for sizes of the code as it is now.`))
  }

  reread = () => void reload()
  vitals.changed.push(renderVitals)

  // A page swap brings other HTML, styles and islands: the weight is measured again.
  const swaps = new MutationObserver(() => {
    if (tab.panel.hidden === false && !scheduled) {
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        reread()
      })
    }
  })

  swaps.observe(doc.head, { childList: true })
  signal.addEventListener('abort', () => swaps.disconnect())
  tab.panel.append(tool.make('h3', 'heading', 'Web Vitals of the page load'), loadNote, vitalsPanel, weightPanel)
  renderVitals()
}

const ROUTE_KINDS: Record<DevRoute['kind'], string> = { page: 'Pages', endpoint: 'Endpoints', api: 'API', kay: 'Served by kay' }

// Every route the server serves, filtered as typed, each opening its file, the GET paths no request fills in linking to themselves; fetched as the tab shows and again after each restart, so it lists what the running server serves.
function routesTab(doc: Document, tool: DevTool, signal: AbortSignal): void {
  const win = doc.defaultView!
  const actions = tool.make('div', 'actions')
  const filter = tool.make('input', 'filter')
  const body = tool.make('div')
  let routes: DevRoute[] = []
  let notes: string[] = []
  // A restart while a fetch is out asks again; the latest answer wins.
  let asked = 0
  const render = () => {
    const typed = filter.value.trim().toLowerCase()
    const shown = routes.filter(route => typed === '' || route.path.toLowerCase().includes(typed) || route.file.toLowerCase().includes(typed) || (route.owner ?? '').toLowerCase().includes(typed))
    const sections = Object.entries(ROUTE_KINDS).flatMap(([kind, label]) => {
      const ofKind = shown.filter(route => route.kind === kind)

      if (ofKind.length === 0)
        return []

      const section = tool.make('section', 'group')
      const list = tool.make('div', 'mono')

      list.append(...ofKind.map(route => routeRow(tool, route, win.location.pathname)))
      section.append(tool.make('h3', 'heading', `${label} (${ofKind.length})`), list)

      return [section]
    })

    body.replaceChildren(...sections.length > 0 ? sections : [tool.make('div', 'empty', routes.length === 0 ? 'No routes.' : 'No route matches the filter.')], ...notes.map(note => tool.make('div', 'note', note)))
  }
  const list = async () => {
    const ask = ++asked

    try {
      const response = await win.fetch(ROUTES_URL, { cache: 'no-store' })

      if (ask !== asked)
        return

      if (!response.ok)
        throw new Error(`the server answered ${response.status}`)

      const listed = await response.json() as DevRoutes

      if (ask !== asked)
        return

      routes = listed.routes
      notes = listed.notes
      render()
    }
    catch (error) {
      if (ask !== asked)
        return

      body.replaceChildren(tool.make('div', 'empty', `Could not list the routes: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  const tab = tool.tab({ id: 'routes', label: 'Routes', shown: () => void list() })

  filter.type = 'search'
  filter.placeholder = 'Filter by path or file'
  filter.setAttribute('aria-label', 'Filter the routes by path or file')
  filter.oninput = render
  actions.append(filter)
  tab.panel.append(actions, body)
  win.addEventListener(BUILT_EVENT, () => {
    if (tab.panel.hidden === false)
      void list()
  }, { signal })
}

function routeRow(tool: DevTool, route: DevRoute, current: string): HTMLElement {
  const row = tool.make('div', 'route')
  const link = tool.make('a', 'path link', route.path)
  const file = tool.make('div', 'file')

  if (route.href === current)
    row.setAttribute('aria-current', 'page')

  if (route.href !== undefined)
    link.href = route.href

  if (route.owner === undefined)
    file.append(positionButton(tool, route.file))
  else
    file.textContent = route.owner

  row.append(tool.make('span', 'method', route.method), route.href === undefined ? tool.make('span', 'path', route.path) : link, tool.make('span', 'note', route.locale ?? ''), file)

  return row
}

function formatMs(ms: number): string {
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`
}

// A file, or a position in one, as a button opening it in the editor once the inspector says how; a file named alone opens at its first line.
function positionButton(tool: DevTool, source: string): HTMLButtonElement {
  const position = tool.make('button', 'position', source)

  position.type = 'button'
  position.disabled = !tool.opens()
  position.onclick = async () => {
    const failed = await tool.open(withLine(source))
    const note = position.nextElementSibling?.classList.contains('note') === true ? position.nextElementSibling : undefined

    note?.remove()

    if (failed !== undefined)
      position.after(tool.make('span', 'note', ` (${failed})`))
  }

  return position
}

const copyResets = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>()

// Opens the position an error page's button names, saying why it could not, or copies the error, saying so a moment.
async function answerErrorPage(tool: DevTool, target: HTMLButtonElement): Promise<void> {
  const { kayOpen: source, kayCopy: copied } = target.dataset

  if (source !== undefined) {
    const failed = await tool.open(withLine(source))

    target.textContent = failed === undefined ? source : `${source} (${failed})`

    return
  }

  try {
    await target.ownerDocument.defaultView!.navigator.clipboard.writeText(target.ownerDocument.getElementById(copied!)?.textContent ?? '')
    target.textContent = 'Copied'
  }
  catch {
    target.textContent = 'Copy failed'
  }

  clearTimeout(copyResets.get(target))
  copyResets.set(target, setTimeout(() => {
    target.textContent = 'Copy'
  }, COPIED_MS))
}

// A file named alone or by its line opens at its first line or column.
function withLine(source: string): string {
  const [, file, line = '1', column = '1'] = OPENED_POSITION.exec(source) ?? []

  return file === undefined ? source : `${file}:${line}:${column}`
}

// An error's stack, headed by its name and message where the browser leaves them out, or the text logged with it; the island kay caught it in first.
function problemText({ text, error, island }: DevProblem): string {
  const { name, message, stack } = (typeof error === 'object' && error !== null ? error : {}) as { name?: unknown, message?: unknown, stack?: unknown }
  const head = `${String(name)}: ${String(message)}`
  const shown = typeof stack !== 'string' || stack === '' ? text : stack.startsWith(String(name)) ? stack : `${head}\n${stack}`
  const where = island === undefined ? '' : `in island ${island}: `

  return `${where}${text.startsWith('Uncaught (in promise) ') && shown !== text ? `Uncaught (in promise) ${shown}` : shown}`
}

// The text with each `.kay` file it names, with or without a position, as a button opening it once the inspector says how.
function withPositions(text: string, tool: DevTool): Node[] {
  const nodes: Node[] = []
  let last = 0

  for (const match of text.matchAll(KAY_POSITION)) {
    const [source] = match

    nodes.push(textNode(text.slice(last, match.index)), positionButton(tool, source))
    last = match.index + source.length
  }

  nodes.push(textNode(text.slice(last)))

  return nodes

  function textNode(part: string): Node {
    return tool.root.ownerDocument.createTextNode(part)
  }
}

// The elements an accessibility problem names, one selector a line under its first, those inside a shadow root left out.
function a11yTargets(doc: Document, text: string): Element[] {
  const elements: Element[] = []

  for (const line of text.split('\n').slice(1)) {
    const selector = line.startsWith('  ') ? line.trim() : ''

    if (selector === '' || selector.includes(' >>> ') || selector.startsWith('and '))
      continue

    try {
      elements.push(...doc.querySelectorAll(selector))
    }
    catch {}
  }

  return elements
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
