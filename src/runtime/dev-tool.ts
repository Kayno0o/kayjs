// Loaded by every page a dev server serves: a bar in a corner of the page opens a drawer whose tabs show what kay knows of the page, its problems first; under `kay dev` the inspector adds its own tab and buttons.
// It runs in the browser from its own route, so it imports types only; its elements live in a shadow root on the root element, which a page swap keeps, styled by an adopted stylesheet, which a policy without inline styles allows.
import type { DevProblem, DevProblems } from './dev-boot'

const HOST = 'kay-dev'
const STATE_KEY = 'kay-dev'
const CHECK_PROBLEMS = 'kay-check-problems'
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
const OPENED_POSITION = /^(.+\.kay)(?::(\d+))?(?::(\d+))?$/

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
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.mark { font-weight: 700; color: var(--accent); letter-spacing: .02em; }
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
  // The last build this browser tab heard of, and when, so a page the build reloads says it again.
  built?: { id: string, at: number } | undefined
}

// What `kay dev` says of a restart, or of a stylesheet edit it swapped in without one.
interface Built {
  id: string
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
  built.hidden = true
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

  // Said once in each browser tab: again on the page it reloaded, never on a page opened long after.
  const sayBuilt = (data: string) => {
    const build = JSON.parse(data) as Built
    const now = Date.now()
    const shown = state.built === undefined ? undefined : build.id === state.built.id ? state.built.at : now
    const left = shown === undefined ? 0 : BUILT_MS - (now - shown)

    if (state.built?.id !== build.id) {
      state.built = { id: build.id, at: state.built === undefined ? 0 : now }
      save()
    }

    if (left <= 0)
      return

    clearTimeout(fading)
    clearTimeout(hiding)
    built.textContent = `${build.changed}: ${build.styles === true ? 'stylesheets swapped' : 'restarted'} in ${build.ms} ms`
    built.hidden = false
    built.classList.remove('fading')
    fading = setTimeout(() => built.classList.add('fading'), left)
    hiding = setTimeout(() => {
      built.hidden = true
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
      win.removeEventListener('keydown', onKeyDown, true)
      listening.abort()
      clearTimeout(fading)
      clearTimeout(hiding)
      host.remove()
    },
  }

  problems = problemsTab(doc, tool, state, save)
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

// A `.kay` file named alone or by its line opens at its first line or column.
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
    nodes.push(textNode(text.slice(last, match.index)), position)
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
