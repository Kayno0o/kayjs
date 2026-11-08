import type { DevTool } from './dev-tool'
import type { DevIconName } from './dev-tool-icons'
import { DEV_PATH, HEAD_HEADER, STACK_URL } from './dev-tool-constants'
import { setIcon, TONE_ICONS } from './dev-tool-icons'

// What the tabs of the dev tool build their rows and toolbars from. Split from dev-tool.ts, which the dev server serves with the modules it imports.

// The addresses the dev tool fetched itself, which the Network tab leaves out.
export const OWN_FETCHES = new Set<string>()

// How long a copy button says it copied, or could not.
const COPIED_MS = 1500
// The pending reset of each button saying it copied.
const copyResets = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>()
// A path segment, kay's `(group)`, `[param]`, `[[optional]]` and `[...rest]` names included.
const SEGMENT = String.raw`(?:\([\w@.+=-]+\)|\[{1,2}(?:\.{3})?[\w-]+\]{1,2}|[\w@.+=-])+`
const SOURCE_EXTENSION = String.raw`(?:[cm]?[jt]sx?|css)`

// A source file a problem names, with its line and column when it gives them, not one inside a URL nor a URL of kay's own: a `.kay` file named alone, a script or stylesheet once a folder or a line tells it from a word like Node.js, and an absolute one, as a URL path reads, only with a line, as a stack trace gives.
const SOURCE_POSITION = new RegExp(String.raw`(?<![\w@.+=:/\\)\]-])(?![\\/]_kay[\\/])(?:(?:[A-Za-z]:)?[\\/]?(?:${SEGMENT}[\\/])*${SEGMENT}\.kay|(?:${SEGMENT}[\\/])+${SEGMENT}\.${SOURCE_EXTENSION}|(?:[A-Za-z]:)?[\\/]?(?:${SEGMENT}[\\/])*${SEGMENT}\.${SOURCE_EXTENSION}(?=:\d))(?::\d+(?::\d+)?)?(?!\.?\w)`, 'g')
const OPENED_POSITION = /^(.+\.\w+)(?::(\d+))?(?::(\d+))?$/

// A small rounded label, tinted by what it counts or says, with an icon before it when given.
export function pill(tool: Pick<DevTool, 'make' | 'icon'>, text: string, tone?: 'error' | 'warn' | 'ok' | 'accent', icon?: DevIconName): HTMLElement {
  const element = tool.make('span', tone === undefined ? 'pill' : `pill ${tone}`)

  if (icon !== undefined)
    element.append(tool.icon(icon))

  element.append(text)

  return element
}

export interface EntryParts {
  // Before the rest, as an image's thumbnail.
  lead?: HTMLElement | undefined
  name: HTMLElement | string
  // What follows the name on its line: pills, a value, a copy button.
  after?: Node[] | undefined
  // Short facts, a string drawn as a chip.
  chips?: (HTMLElement | string)[] | undefined
  // What is wrong, one line each.
  issues?: { text: string, tone: 'error' | 'warn', icon?: DevIconName }[] | undefined
  note?: string | undefined
}

// A row of a list tab, the same in each: its name and what follows it on one line, short facts as chips, what is wrong one line each, then a muted note.
export function entry(tool: DevTool, kind: string, parts: EntryParts): HTMLElement {
  const row = tool.make('div', `entry ${kind}`)
  const body = tool.make('div', 'body')
  const line = tool.make('div', 'line')

  line.append(typeof parts.name === 'string' ? tool.make('span', 'name', parts.name) : parts.name, ...parts.after ?? [])
  body.append(line)

  if (parts.chips !== undefined && parts.chips.length > 0) {
    const chips = tool.make('div', 'chips')

    chips.append(...parts.chips.map(chip => typeof chip === 'string' ? tool.make('span', 'chip', chip) : chip))
    body.append(chips)
  }

  for (const issue of parts.issues ?? []) {
    const element = tool.make('div', `issue ${issue.tone}`)

    element.append(tool.icon(issue.icon ?? TONE_ICONS[issue.tone]), tool.make('span', '', issue.text))
    body.append(element)
  }

  if (parts.note !== undefined)
    body.append(tool.make('div', 'note', parts.note))

  if (parts.lead !== undefined)
    row.append(parts.lead)

  row.append(body)

  return row
}

export interface Toolbar {
  element: HTMLElement
  input: HTMLInputElement
  // Shown when the filter hides every row.
  empty: HTMLElement
  // Hides what the filter or the toggle leave out under `within`, and a group left with no row.
  apply: (within: Element) => void
}

// What a filter matches on a row, and whether the "Problems only" toggle keeps it.
export function filterable<T extends HTMLElement>(element: T, text: string, problem = false): T {
  element.dataset.filter = text.toLowerCase()

  if (problem)
    element.dataset.problem = ''

  return element
}

// An icon button copying `text`, saying for a moment whether it could.
export function copyButton(tool: DevTool, what: string, text: string): HTMLButtonElement {
  const button = tool.make('button', 'copy')
  const label = `Copy ${what}`

  button.type = 'button'
  setIcon(button, label, 'copy')
  button.onclick = async () => copied(button, text, label, 'copy')

  return button
}

// Copies `text` from an icon button, its icon and name saying for a moment whether it worked, without a dialog.
export async function copied(button: HTMLButtonElement, text: string, label: string, icon: DevIconName): Promise<void> {
  const worked = await toClipboard(button, text)

  setIcon(button, worked ? 'Copied' : 'Copy failed', worked ? 'check' : 'x')
  announce(button, worked ? 'Copied' : 'Copy failed')
  clearTimeout(copyResets.get(button))
  copyResets.set(button, setTimeout(setIcon, COPIED_MS, button, label, icon))
}

// Says a copy's outcome to a screen reader, which a button's changed name alone does not: the drawer's live region takes it, and empties again for the next copy to be heard.
export function announce(button: HTMLElement, text: string): void {
  const region = (button.getRootNode() as ParentNode).querySelector('.copies')

  if (region === null)
    return

  region.textContent = ''
  setTimeout(() => {
    region.textContent = text
  }, 0)
}

// A tab's filter box, and a "Problems only" toggle when `problems` is given, its help text naming what it matches; it applies to the rows marked by `filterable` under the element passed to `apply`, run again on each keystroke and press.
export function toolbar(tool: DevTool, help: string, rerun: () => void, problems = false): Toolbar {
  const element = tool.make('div', 'toolbar')
  const search = tool.make('label', 'search')
  const input = tool.make('input', 'filter')
  const toggle = tool.make('button', 'tool', 'Problems only')
  const empty = tool.make('div', 'empty', 'Nothing matches the filter.')

  input.type = 'search'
  input.placeholder = help
  input.setAttribute('aria-label', help)
  input.oninput = rerun
  search.append(tool.icon('search'), input)
  element.append(search)
  empty.hidden = true
  empty.setAttribute('aria-live', 'polite')

  if (problems) {
    toggle.type = 'button'
    toggle.setAttribute('aria-pressed', 'false')
    toggle.onclick = () => {
      toggle.setAttribute('aria-pressed', String(toggle.getAttribute('aria-pressed') !== 'true'))
      rerun()
    }
    element.append(toggle)
  }

  return {
    element,
    input,
    empty,
    apply: (within) => {
      const typed = input.value.trim().toLowerCase()
      const only = toggle.getAttribute('aria-pressed') === 'true'
      const rows = [...within.querySelectorAll<HTMLElement>('[data-filter]')]

      for (const row of rows)
        row.hidden = !row.dataset.filter!.includes(typed) || (only && row.dataset.problem === undefined)

      for (const section of within.querySelectorAll<HTMLElement>('[data-plain]'))
        section.hidden = only

      // A group with no row to match, such as a timing chart, goes while a filter is on; marked rather than hidden, as its tab may hide it for its own reasons.
      for (const group of within.querySelectorAll<HTMLElement>('.group')) {
        const own = [...group.querySelectorAll<HTMLElement>('[data-filter]')]

        if (own.length > 0) {
          group.hidden = own.every(row => row.hidden === true)

          // The heading's count follows the rows shown, and goes back to the whole when nothing filters.
          for (const count of group.querySelectorAll<HTMLElement>(':scope > .heading > .pill')) {
            count.dataset.total ??= count.textContent
            count.textContent = typed === '' && !only ? count.dataset.total : String(own.filter(row => row.hidden === false).length)
          }
        }
        else {
          group.toggleAttribute('data-filtered', typed !== '' || only)
        }
      }

      empty.textContent = only && typed === '' ? 'No problems.' : 'Nothing matches the filter.'
      empty.hidden = rows.length === 0 || rows.some(row => row.hidden === false)
    },
  }
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

export function formatMs(ms: number): string {
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`
}

// A file, or a position in one, as a button opening it in the editor once the inspector says how; a file named alone opens at its first line.
export function positionButton(tool: DevTool, source: string): HTMLButtonElement {
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

// A fetch of the dev tool's own, which the Network tab leaves out.
export async function ownFetch(win: Window, url: string, init?: RequestInit): Promise<Response> {
  // Its own routes are left out by their path already.
  if (!DEV_PATH.test(url))
    OWN_FETCHES.add(new URL(url, win.location.href).href)

  return win.fetch(url, init)
}

// Whether the text reached the clipboard of the button's window.
async function toClipboard(button: HTMLButtonElement, text: string): Promise<boolean> {
  try {
    await button.ownerDocument.defaultView!.navigator.clipboard.writeText(text)

    return true
  }
  catch {
    return false
  }
}

// Opens the position an error page's button names, saying why it could not, or copies the error, saying so a moment.
export async function answerErrorPage(tool: DevTool, target: HTMLButtonElement): Promise<void> {
  const { kayOpen: source, kayCopy: copiedId } = target.dataset

  if (source !== undefined) {
    const failed = await tool.open(withLine(source))

    target.textContent = failed === undefined ? source : `${source} (${failed})`

    return
  }

  await copyText(target, target.ownerDocument.getElementById(copiedId!)?.textContent ?? '')
}

// Writes the text to the clipboard and says so on the button for a moment, or that it failed, without a dialog; the text sits in the button's own span when it has one, beside its icon.
export async function copyText(button: HTMLButtonElement, text: string): Promise<void> {
  const label = button.querySelector('span') ?? button

  const worked = await toClipboard(button, text)

  label.textContent = worked ? 'Copied' : 'Copy failed'
  announce(button, label.textContent)

  clearTimeout(copyResets.get(button))
  copyResets.set(button, setTimeout(() => {
    label.textContent = 'Copy'
  }, COPIED_MS))
}

// The stack with its chunk frames on `.kay` lines as the server maps them; none when it cannot.
export async function onKayLines(win: Window, stack: string): Promise<string | undefined> {
  try {
    const response = await ownFetch(win, STACK_URL, { method: 'POST', headers: { 'content-type': 'application/json', [HEAD_HEADER]: '1' }, body: JSON.stringify({ stack }), cache: 'no-store' })

    return response.ok ? (await response.json() as { stack: string }).stack : undefined
  }
  catch {
    return undefined
  }
}

// A file named alone or by its line opens at its first line or column.
function withLine(source: string): string {
  const [, file, line = '1', column = '1'] = OPENED_POSITION.exec(source) ?? []

  return file === undefined ? source : `${file}:${line}:${column}`
}

// The text with each source file it names, with or without a position, as a button opening it once the inspector says how.
export function withPositions(text: string, tool: DevTool): Node[] {
  const nodes: Node[] = []
  let last = 0

  for (const match of text.matchAll(SOURCE_POSITION)) {
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

// An island's slot lays out as its contents, so its box is theirs.
export function boundsOf(target: Element): DOMRect {
  const rect = target.getBoundingClientRect()

  if (rect.width > 0 || rect.height > 0 || target.children.length === 0)
    return rect

  const boxes = [...target.children].map(child => boundsOf(child))
  const left = Math.min(...boxes.map(box => box.left))
  const top = Math.min(...boxes.map(box => box.top))

  return new DOMRect(left, top, Math.max(...boxes.map(box => box.right)) - left, Math.max(...boxes.map(box => box.bottom)) - top)
}
