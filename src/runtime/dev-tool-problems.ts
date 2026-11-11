import type { DevProblem, DevProblems } from './dev-boot'
import type { DevTool } from './dev-tool'
import type { DevState } from './dev-tool-layout'
import { CHECK_PROBLEMS, CHUNK_FRAME, TYPE_PROBLEMS, TYPES_EVENT } from './dev-tool-constants'
import { setIcon } from './dev-tool-icons'
import { copyText, onKayLines, pill, withPositions } from './dev-tool-parts'

// The dev tool's Problems tab: what kay logged, what nothing caught, what the policy blocked and what the checks found. Split from dev-tool.ts, which the dev server serves with the modules it imports.

// The most problem texts a tab remembers as dismissed.
const MAX_DISMISSED = 200

type ProblemKind = 'uncaught' | 'kay' | 'policy' | 'a11y' | 'check'

// Each kind of problem under its heading, in the order they show.
const KINDS: Record<ProblemKind, string> = {
  uncaught: 'Uncaught errors',
  kay: 'Recovered by kay',
  policy: 'Blocked by the policy',
  a11y: 'Accessibility',
  check: 'kay check',
}

// What kay logged, what nothing caught, what the policy blocked, what the accessibility check and `kay check` found, grouped by kind, each listed once with how often it came; those the page logged leave with it on a page swap.
export function problemsTab(doc: Document, tool: DevTool, state: DevState, save: () => void, missing: MissingMessages): { stop: () => void } {
  const win = doc.defaultView! as Window & { $kayProblems?: DevProblems }
  const tab = tool.tab({ id: 'problems', label: 'Problems', icon: 'triangle-alert', summary: count => `${count} problem${count === 1 ? '' : 's'}`, announce: true })
  const actions = tool.make('div', 'actions')
  const tally = tool.make('span', 'actions')
  const clear = tool.make('button', 'tool', 'Dismiss all')
  const copy = tool.make('button', 'tool')
  const empty = tool.make('div', 'empty', 'No problems on this page.')
  const groups = new Map(Object.entries(KINDS).map(([kind, label]) => {
    const section = tool.make('section', 'group')
    const heading = tool.make('h3', 'heading', label)
    const total = tool.make('span', 'pill')
    const list = tool.make('div', 'list')

    section.hidden = true
    heading.append(total)
    section.append(heading, list)

    return [kind as ProblemKind, { section, total, list }]
  }))
  const shown = new Map<string, { problem: DevProblem, kind: ProblemKind, element: HTMLElement, times: HTMLElement, count: number }>()
  const dismissed = new Set(state.dismissed)

  clear.type = 'button'
  copy.type = 'button'
  copy.title = 'Copy every problem as plain text, to paste into an LLM'
  copy.append(tool.icon('copy'), tool.make('span', '', 'Copy'))
  actions.append(tally, tool.make('span', 'grow'), copy, clear)
  tab.panel.append(actions, empty, ...[...groups.values()].map(group => group.section))

  const update = () => {
    const counts = new Map<ProblemKind, number>()
    let errors = 0

    for (const { problem, kind } of shown.values()) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1)

      if (problem.level === 'error')
        errors++
    }

    const warnings = shown.size - errors

    tab.count(shown.size, errors > 0 ? 'error' : 'warn')
    tally.replaceChildren(
      ...errors > 0 ? [pill(tool, `${errors} error${errors === 1 ? '' : 's'}`, 'error', 'circle-x')] : [],
      ...warnings > 0 ? [pill(tool, `${warnings} warning${warnings === 1 ? '' : 's'}`, 'warn', 'triangle-alert')] : [],
    )
    empty.hidden = shown.size > 0
    actions.hidden = shown.size === 0

    for (const [kind, group] of groups) {
      const count = counts.get(kind) ?? 0

      group.section.hidden = count === 0
      group.total.textContent = String(count)
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
    missing.note(logged)

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
    const times = tool.make('span', 'pill')
    const close = tool.make('button', 'icon dismiss')
    const text = tool.make('pre', 'mono')

    times.hidden = true
    close.type = 'button'
    setIcon(close, 'Dismiss this problem', 'x')
    const key = problem.text

    close.onclick = () => dismiss([key])
    text.append(...withPositions(problem.text, tool))

    if (CHUNK_FRAME.test(problem.text)) {
      void (async () => {
        const mapped = await onKayLines(doc.defaultView!, problem.text)

        if (mapped !== undefined) {
          problem.text = mapped
          text.replaceChildren(...withPositions(mapped, tool))
        }
      })()
    }

    element.append(tool.icon(problem.level === 'error' ? 'circle-x' : 'triangle-alert'), text, close, times)

    if (kind === 'a11y') {
      element.onpointerenter = () => {
        const targets = a11yTargets(doc, problem.text)
        const colon = problem.text.indexOf(':')

        if (targets.length > 0)
          tool.outline(targets, problem.text.slice(5, colon < 0 ? undefined : colon))
      }
      element.onpointerleave = () => tool.hideOutline()
    }

    shown.set(key, { problem, kind, element, times, count: 1 })
    groups.get(kind)!.list.append(element)
    update()
  }

  clear.onclick = () => dismiss([...shown.keys()])
  copy.onclick = async () => copyText(copy, copiedProblems(win.location.href, [...shown.values()]))

  // What `kay check` finds now, as the page carries it: a swap brings the block of the code the server runs.
  const readChecks = () => {
    const texts = new Set([CHECK_PROBLEMS, TYPE_PROBLEMS].flatMap(id => JSON.parse(doc.getElementById(id)?.textContent ?? '[]') as string[]))

    for (const [text, { kind }] of shown) {
      if (kind === 'check' && !texts.has(text))
        remove(text)
    }

    for (const text of texts)
      add({ level: text.startsWith('error') ? 'error' : 'warn', text }, true)

    update()
  }

  readChecks()

  // The type check beside the server ended: its block is rewritten, so a page swapped in later reads the same, and the tab shows it without a reload.
  const typed = (event: Event) => {
    const block = doc.getElementById(TYPE_PROBLEMS) ?? doc.head.appendChild(Object.assign(doc.createElement('script'), { id: TYPE_PROBLEMS, type: 'application/json' }))

    block.textContent = JSON.stringify((event as CustomEvent<{ problems: string[] }>).detail.problems)
    readChecks()
  }

  doc.addEventListener(TYPES_EVENT, typed)

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
      doc.removeEventListener(TYPES_EVENT, typed)
      // Problems logged from now on wait for the next tool.
      win.$kayProblems = [] as DevProblem[]
    },
  }
}

const MISSING_MESSAGE = /no locale has the message ("(?:[^"\\]|\\.)*")/

// The message keys the page asked for that no locale has, read off the problems kay logs, which `changed` hears of.
export interface MissingMessages {
  keys: Set<string>
  changed: () => void
  note: (problem: DevProblem) => void
  clear: () => void
}

export function missingMessages(): MissingMessages {
  const missing: MissingMessages = {
    keys: new Set(),
    changed: () => undefined,
    note: ({ text }) => {
      const quoted = MISSING_MESSAGE.exec(text)?.[1]
      const key = quoted === undefined ? undefined : JSON.parse(quoted) as string

      if (key !== undefined && !missing.keys.has(key)) {
        missing.keys.add(key)
        missing.changed()
      }
    },
    clear: () => {
      if (missing.keys.size > 0) {
        missing.keys.clear()
        missing.changed()
      }
    },
  }

  return missing
}

// An error's stack, headed by its name and message where the browser leaves them out, or the text logged with it; the island kay caught it in first.
function problemText({ text, error, island }: DevProblem): string {
  const { name, message, stack } = (typeof error === 'object' && error !== null ? error : {}) as { name?: unknown, message?: unknown, stack?: unknown }
  const head = `${String(name)}: ${String(message)}`
  let shown = text

  if (typeof stack === 'string' && stack !== '')
    shown = stack.startsWith(String(name)) ? stack : `${head}\n${stack}`

  const where = island === undefined ? '' : `in island ${island}: `

  return `${where}${text.startsWith('Uncaught (in promise) ') && shown !== text ? `Uncaught (in promise) ${shown}` : shown}`
}

// Every listed problem as plain text for a reader without the page, such as an LLM: the page, then a block per problem in the tab's order, with its kind, level and how often it came, and the message as listed, which names its file and line where it knows them.
function copiedProblems(url: string, listed: { problem: DevProblem & { text: string }, kind: ProblemKind, count: number }[]): string {
  const order = Object.keys(KINDS)
  const blocks = listed.toSorted((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).map(({ problem, kind, count }) => `[${KINDS[kind]}] ${problem.level}${count > 1 ? ` (${count} times)` : ''}\n${problem.text}`)

  return [`kay dev problems on ${url}`, ...blocks].join('\n\n')
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
