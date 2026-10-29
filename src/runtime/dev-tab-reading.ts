import type { DevKit, DevTab, DevTool } from './dev-tool'

// The Screen reader tab's code, fetched at once as its badge counts what a screen reader would trip on, with the tool's shared helpers from `tool.kit`.
// Waiting for the page to stop changing before it is read again.
const READING_WAIT = 250
// How many times a read takes the page may be left alone for before it is read again.
const READING_SLACK = 10
const SPACES_RUN = /\s+/g
const HEADING_TAG = /^h([1-6])$/
// What a screen reader announces as a stop of its own: the elements that may have a role of a landmark, heading, link, control or field.
const READABLE = 'a[href], area[href], button, summary, input, select, textarea, h1, h2, h3, h4, h5, h6, nav, main, aside, header, footer, section, form, search, [role]'
const LANDMARKS = new Set(['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search'])
const CONTROLS = new Set(['button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio'])
const FIELDS = new Set(['textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'spinbutton', 'switch'])
// The roles whose name comes from their content.
const NAMED_BY_CONTENT = new Set(['button', 'link', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio', 'switch', 'cell', 'gridcell', 'columnheader', 'rowheader', 'treeitem', 'tooltip'])
// The roles whose value is their name inside another element's label.
const VALUED = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton'])
const BUTTON_DEFAULTS: Record<string, string> = { submit: 'Submit', reset: 'Reset' }
const BUTTON_INPUTS = new Set(['button', 'submit', 'reset', 'image', 'file', 'color'])
const TEXT_INPUTS = new Set(['', 'text', 'email', 'tel', 'url', 'password'])
const SECTIONING = 'article, aside, main, nav, section, [role=article], [role=complementary], [role=main], [role=navigation], [role=region]'
const LABELABLE = new Set(['input', 'select', 'textarea', 'button', 'meter', 'output', 'progress'])
const READING_OBSERVED = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-description', 'aria-required', 'aria-level', 'aria-hidden', 'role', 'alt', 'title', 'href', 'for', 'id', 'required', 'value', 'placeholder', 'type', 'multiple', 'size', 'list', 'open', 'inert', 'hidden', 'class', 'style', 'aria-busy'] }

export type ReadingKind = 'landmark' | 'heading' | 'link' | 'control' | 'field'

// One stop of a screen reader's walk through the page.
export interface ReadingItem {
  element: Element
  kind: ReadingKind
  role: string
  name: string
  // A heading's level.
  level?: number
  // Where a link goes, as the browser resolves it.
  target?: string
  description?: string
  required?: boolean
}

// What is wrong with the page as a whole, and the elements to outline for it.
export interface ReadingPageIssue {
  text: string
  elements: Element[]
}

export interface ReadingFlags {
  page: ReadingPageIssue[]
  items: Map<ReadingItem, string[]>
}

const NO_NAME = 'No accessible name'

// What is wrong with the items read: a heading level skipped, no main landmark or several, a link, control or field with no name, and links of one name going to different places. Pure, so it needs no page.
export function readingFlags(items: ReadingItem[]): ReadingFlags {
  const flags = new Map<ReadingItem, string[]>()
  const page: ReadingPageIssue[] = []
  const flag = (item: ReadingItem, text: string) => flags.set(item, [...flags.get(item) ?? [], text])
  const links = new Map<string, ReadingItem[]>()
  let level = 0

  for (const item of items) {
    if (item.kind === 'heading') {
      const own = item.level ?? 2

      if (level === 0 && own > 1)
        flag(item, `Starts at h${own}, with no h1 before it`)
      else if (own > level + 1)
        flag(item, `Skips from h${level} to h${own}`)

      level = own
    }

    if (item.kind !== 'landmark' && item.name === '')
      flag(item, NO_NAME)

    if (item.kind === 'link' && item.name !== '') {
      const key = item.name.toLowerCase()

      links.set(key, [...links.get(key) ?? [], item])
    }
  }

  for (const same of links.values()) {
    for (const item of same) {
      const elsewhere = same.filter(other => other.target !== item.target).length

      if (elsewhere > 0)
        flag(item, elsewhere === 1 ? 'Same name as 1 other link that goes elsewhere' : `Same name as ${elsewhere} other links that go elsewhere`)
    }
  }

  const mains = items.filter(item => item.role === 'main')

  if (mains.length === 0)
    page.push({ text: 'No main landmark, so a screen reader user cannot jump to the content', elements: [] })

  if (mains.length > 1) {
    page.push({ text: `A page has one main landmark, this one has ${mains.length}`, elements: mains.map(main => main.element) })

    for (const main of mains)
      flag(main, `One of ${mains.length} main landmarks`)
  }

  return { page, items: flags }
}

// Whether a screen reader would skip the element: not rendered, or `inert`, or `aria-hidden`.
function hiddenFromReader(element: Element): boolean {
  return element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('inert') || !isRendered(element)
}

// The element around another, across a shadow root's edge.
function parentOf(node: Element): Element | null {
  const root = node.getRootNode()

  return node.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
}

// Rendered, a `display: contents` element counting as rendered when the element around it is, as it has no box and still reads.
function isRendered(element: Element): boolean {
  if (typeof element.checkVisibility !== 'function' || element.checkVisibility({ visibilityProperty: true }))
    return true

  const parent = parentOf(element)

  // An image map's area has no box of its own.
  if (element instanceof HTMLAreaElement)
    return parent !== null && isRendered(parent)

  return getComputedStyle(element).display === 'contents' && parent !== null && isRendered(parent)
}

// The element's role: the first word of `role`, else what its tag stands for. A `header` or `footer` inside a section is no landmark, and a `section` or `form` is one only with a name, which `named: false` does not look for, as the name's own steps ask for the role.
function roleOf(element: Element, named = true): string {
  const explicit = element.getAttribute('role')?.trim().split(SPACES_RUN)[0]

  if (explicit !== undefined && explicit !== '')
    return explicit

  const tag = element.localName
  const heading = HEADING_TAG.test(tag)
  const input = element instanceof HTMLInputElement ? element : undefined

  if (heading)
    return 'heading'

  if (input !== undefined)
    return inputRole(input)

  switch (tag) {
    case 'a':
    case 'area':
      return element.hasAttribute('href') ? 'link' : ''
    case 'button':
    case 'summary':
      return 'button'
    case 'nav':
      return 'navigation'
    case 'main':
      return 'main'
    case 'aside':
      return 'complementary'
    case 'search':
      return 'search'
    case 'header':
      return element.closest(SECTIONING) === null ? 'banner' : ''
    case 'footer':
      return element.closest(SECTIONING) === null ? 'contentinfo' : ''
    case 'section':
      return named && accessibleName(element) !== '' ? 'region' : ''
    case 'form':
      return named && accessibleName(element) !== '' ? 'form' : ''
    case 'textarea':
      return 'textbox'
    case 'select':
      return (element as HTMLSelectElement).multiple || (element as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox'
    default:
      return ''
  }
}

function inputRole(input: HTMLInputElement): string {
  const type = input.type

  if (type === 'hidden')
    return ''

  if (BUTTON_INPUTS.has(type))
    return 'button'

  if (type === 'checkbox' || type === 'radio')
    return type

  if (type === 'range')
    return 'slider'

  if (type === 'number')
    return 'spinbutton'

  if (type === 'search')
    return input.list === null ? 'searchbox' : 'combobox'

  return TEXT_INPUTS.has(type) && input.list !== null ? 'combobox' : 'textbox'
}

function kindOf(role: string): ReadingKind | undefined {
  if (LANDMARKS.has(role))
    return 'landmark'

  if (role === 'heading')
    return 'heading'

  if (role === 'link')
    return 'link'

  if (CONTROLS.has(role))
    return 'control'

  return FIELDS.has(role) ? 'field' : undefined
}

// How a name is being worked out: from a node `aria-labelledby` or `aria-describedby` names (`labelled`, whose own `aria-labelledby` is not followed again, and `direct` for the node itself, read even when hidden), or from within another node's content (`nested`); `seen` holds the elements being read, so a loop ends.
interface NameContext {
  labelled: boolean
  direct: boolean
  nested: boolean
  seen: Set<Element>
}

function squeezed(text: string): string {
  return text.replace(SPACES_RUN, ' ').trim()
}

function referenced(element: Element, attribute: string): Element[] {
  const root = element.getRootNode() as Document | ShadowRoot

  return (element.getAttribute(attribute)?.split(SPACES_RUN) ?? []).flatMap(id => id === '' ? [] : root.getElementById(id) ?? [])
}

// The element's accessible name, by the steps of the accessible name computation: `aria-labelledby`, `aria-label`, what the element is (`alt`, a `label`, a button's `value`), its content when its role is named by it, and `title`. It approximates the browser's: the text a CSS `::before` or `::after` adds is not read.
function accessibleName(element: Element): string {
  return squeezed(nameFrom(element, { labelled: false, direct: false, nested: false, seen: new Set() }))
}

function nameFrom(element: Element, context: NameContext): string {
  if (context.seen.has(element) || (!context.direct && hiddenFromReader(element)))
    return ''

  context.seen.add(element)

  try {
    if (!context.labelled) {
      // An element naming itself gives its own `aria-label` and content.
      const alone = new Set(context.seen)

      alone.delete(element)

      const named = referenced(element, 'aria-labelledby').map(other => squeezed(nameFrom(other, { labelled: true, direct: true, nested: false, seen: other === element ? alone : context.seen }))).join(' ').trim()

      if (named !== '')
        return named
    }

    const label = squeezed(element.getAttribute('aria-label') ?? '')

    if (label !== '')
      return label

    // A field inside another's label gives its value.
    if (context.nested && VALUED.has(roleOf(element, false))) {
      if (element instanceof HTMLSelectElement)
        return [...element.selectedOptions].map(option => option.text).join(' ')

      return (element as HTMLInputElement).value ?? ''
    }

    const native = nativeName(element, context)

    if (native !== undefined && native.trim() !== '')
      return native

    if (context.direct || context.nested || NAMED_BY_CONTENT.has(roleOf(element, false))) {
      const content = squeezed(contentOf(element, context))

      if (content !== '')
        return content
    }

    const title = element.getAttribute('title') ?? ''

    return title === '' ? placeholderOf(element) : title
  }
  finally {
    context.seen.delete(element)
  }
}

function placeholderOf(element: Element): string {
  return (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) ? element.placeholder : ''
}

// What the element is called by its kind: an image's `alt`, a button input's `value`, the `label` elements of a field.
function nativeName(element: Element, context: NameContext): string | undefined {
  if (element instanceof HTMLImageElement || element instanceof HTMLAreaElement)
    return element.getAttribute('alt') ?? undefined

  if (element instanceof HTMLInputElement && BUTTON_INPUTS.has(element.type)) {
    const fallback = BUTTON_DEFAULTS[element.type] ?? ''

    return element.type === 'image' ? element.alt || element.value : element.value || fallback
  }

  // Inside another label, a field is read for its own content, as its own label would hold the text around it again.
  if (context.nested || !LABELABLE.has(element.localName) || !('labels' in element))
    return undefined

  const labels = [...(element.labels as NodeListOf<HTMLLabelElement> | null) ?? []]

  return labels.map(label => contentOf(label, { ...context, direct: false, nested: true })).join(' ')
}

// The text of an element's content, an image's `alt` and an element's own name counting, a box laid out as a block set apart by spaces.
function contentOf(element: Element, context: NameContext): string {
  const nodes: Node[] = []

  if (element.shadowRoot !== null)
    nodes.push(...element.shadowRoot.childNodes)
  else if (element instanceof HTMLSlotElement)
    nodes.push(...element.assignedNodes({ flatten: true }).length > 0 ? element.assignedNodes({ flatten: true }) : element.childNodes)
  else
    nodes.push(...element.childNodes)

  return nodes.map((node) => {
    if (node.nodeType === Node.TEXT_NODE)
      return node.textContent ?? ''

    if (!(node instanceof Element))
      return ''

    const text = nameFrom(node, { ...context, direct: false, nested: true })
    const gap = getComputedStyle(node).display.startsWith('inline') ? '' : ' '

    return `${gap}${text}${gap}`
  }).join('')
}

// What describes a field beyond its name: the elements `aria-describedby` names, else `aria-description`, else the `title` when it did not name the field.
function descriptionOf(element: Element, name: string): string {
  const described = referenced(element, 'aria-describedby')

  if (described.length > 0)
    return squeezed(described.map(other => nameFrom(other, { labelled: true, direct: true, nested: false, seen: new Set() })).join(' '))

  const own = squeezed(element.getAttribute('aria-description') ?? '')

  if (own !== '')
    return own

  const title = squeezed(element.getAttribute('title') ?? '')

  return title === name ? '' : title
}

function isRequired(element: Element): boolean {
  if (element.getAttribute('aria-required') === 'true')
    return true

  return (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) && element.required
}

function levelOf(element: Element): number {
  const tag = HEADING_TAG.exec(element.localName)?.[1]
  const level = Number.parseInt(tag ?? element.getAttribute('aria-level') ?? '', 10)

  return level > 0 ? level : 2
}

function readingItem(element: Element): ReadingItem | undefined {
  const role = roleOf(element)
  const kind = kindOf(role)

  if (kind === undefined || hiddenFromReader(element))
    return undefined

  const name = accessibleName(element)
  const item: ReadingItem = { element, kind, role, name }

  if (kind === 'heading')
    item.level = levelOf(element)

  if (kind === 'link')
    item.target = typeof (element as Partial<HTMLAnchorElement>).href === 'string' ? (element as HTMLAnchorElement).href : element.getAttribute('href') ?? ''

  if (kind === 'field') {
    item.required = isRequired(element)
    item.description = descriptionOf(element, name)
  }

  return item
}

// Every stop of the page a screen reader reads, in the order it reads them, and the open shadow roots met on the way.
function readPage(doc: Document, walkComposed: DevKit['walkComposed'], host: string): { items: ReadingItem[], roots: ShadowRoot[] } {
  const items: ReadingItem[] = []
  const roots = walkComposed(doc, (element) => {
    if (element.localName === host || element.localName === 'head' || element.hasAttribute('hidden') || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true')
      return false

    const item = element.matches(READABLE) ? readingItem(element) : undefined

    if (item !== undefined)
      items.push(item)

    return true
  })

  return { items, roots }
}

// The `.kay` position of the element, or of the nearest element around it that has one.
function sourceOf(element: Element): string | undefined {
  for (let node: Element | null = element; node !== null; node = parentOf(node)) {
    const source = node.getAttribute('data-kay-src')

    if (source !== null)
      return source
  }

  return undefined
}

function roleText(item: ReadingItem): string {
  return item.kind === 'heading' ? `heading ${item.level}` : item.role
}

// A link's address as the page would show it: the path of one on this site, else the whole address.
function targetText(target: string, here: Location): string {
  try {
    const url = new URL(target, here.href)

    return url.origin === here.origin ? `${url.pathname}${url.search}${url.hash}` : url.href
  }
  catch {
    return target
  }
}

// The page as a screen reader reads it, in its order: landmarks, headings, links, controls and form fields each with the name a screen reader would speak, what is wrong flagged, and a hover or focus outlines the element and names the `.kay` file that wrote it. It reads the page again after it changes, a page swap and an island included, and counts what it flags on its tab.
export default function readingTab(tool: DevTool, tab: DevTab): () => void {
  const { entry, filterable, pill, positionButton, signal, toolbar, walkComposed } = tool.kit
  const doc = tool.root.ownerDocument
  const win = doc.defaultView!
  const content = tool.make('div', 'stack')
  const bar = toolbar('Filter by role, name or problem', () => bar.apply(content), true)
  let read: { items: ReadingItem[], flags: ReadingFlags, key: string } | undefined
  // Whether the rows show what was read last.
  let drawn = false
  let timer = 0
  // A page that changes all the time is read at most this often, slower the longer a read takes.
  let wait = READING_WAIT
  const busy = () => doc.documentElement.hasAttribute('aria-busy')
  const changes = new MutationObserver(schedule)

  tab.panel.append(bar.element, content)
  signal.addEventListener('abort', () => {
    win.clearTimeout(timer)
    changes.disconnect()
  })
  changes.observe(doc.documentElement, READING_OBSERVED)
  schedule()

  return draw

  // The first change waits, the rest until the read it ordered, so a page that never stops changing is still read.
  function schedule(): void {
    if (timer === 0)
      timer = win.setTimeout(scan, wait)
  }

  function scan(): void {
    timer = 0

    // The end of a page swap changes the page again.
    if (busy())
      return

    const started = win.performance.now()
    const page = readPage(doc, walkComposed, tool.root.host.localName)

    // Changes inside an open shadow root are not seen from the page's.
    for (const root of page.roots)
      changes.observe(root, READING_OBSERVED)

    changes.takeRecords()

    const flags = readingFlags(page.items)
    const flagged = flags.page.length + flags.items.size

    const key = JSON.stringify([flags.page.map(issue => issue.text), page.items.map(item => [item.role, item.name, item.level, item.target, item.required, item.description, flags.items.get(item), sourceOf(item.element)])])
    const same = read !== undefined && read.key === key && read.items.every((item, index) => item.element === page.items[index]!.element)

    tab.count(flagged, flagged > 0 ? 'warn' : undefined)

    // Rows rebuilt for nothing would drop the focus and the outline a person is on.
    if (!same) {
      read = { items: page.items, flags, key }
      drawn = false
    }

    draw()
    wait = Math.max(READING_WAIT, (win.performance.now() - started) * READING_SLACK)
  }

  function outlineOf(item: ReadingItem): string {
    const source = sourceOf(item.element)

    return source === undefined ? item.element.localName : `${item.element.localName}  ${source}`
  }

  // Scrolled into view, since a row selected by a click may be of an element out of sight.
  function reveal(element: Element, text: string): void {
    element.scrollIntoView({ block: 'center' })
    win.requestAnimationFrame(() => tool.outline([element], text))
  }

  function highlight(row: HTMLElement, elements: Element[], text: string): void {
    row.tabIndex = 0
    row.setAttribute('role', 'group')
    row.onpointerenter = row.onfocus = () => tool.outline(elements, text)
    row.onpointerleave = row.onblur = () => tool.hideOutline()
    row.onclick = (event) => {
      if (elements[0] !== undefined && !(event.target as Element).closest('button'))
        reveal(elements[0], text)
    }
    row.onkeydown = (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === row && elements[0] !== undefined) {
        event.preventDefault()
        reveal(elements[0], text)
      }
    }
  }

  function draw(): void {
    if (read === undefined || drawn || tab.panel.hidden === true)
      return

    drawn = true

    tool.hideOutline()

    const rows: HTMLElement[] = []

    for (const issue of read.flags.page) {
      const label = pill('page')
      const row = entry('reading', { name: label, issues: [{ text: issue.text, tone: 'warn' }] })

      label.classList.add('role')
      row.setAttribute('aria-label', issue.text)

      if (issue.elements.length > 0)
        highlight(row, issue.elements, issue.elements[0]!.localName)

      rows.push(filterable(row, `page ${issue.text}`, true))
    }

    for (const item of read.items) {
      const flags = read.flags.items.get(item) ?? []
      const role = pill(roleText(item))
      const source = sourceOf(item.element)
      const chips = [
        ...item.target === undefined ? [] : [targetText(item.target, win.location)],
        ...item.required === true ? ['required'] : [],
        ...item.description === undefined || item.description === '' ? [] : [`described by: ${item.description}`],
      ]
      const label = tool.make('span', item.name === '' && item.kind !== 'landmark' ? 'accname none' : 'accname', item.name === '' ? 'no name' : item.name)
      const row = entry('reading', {
        name: role,
        after: [...item.name === '' && item.kind === 'landmark' ? [] : [label], ...source === undefined ? [] : [positionButton(source)]],
        chips,
        issues: flags.map(text => ({ text, tone: 'warn' as const })),
      })

      role.classList.add('role')
      row.dataset.kind = item.kind
      row.setAttribute('aria-label', `${roleText(item)}${item.name === '' ? '' : `, ${item.name}`}`)
      highlight(row, [item.element], outlineOf(item))
      rows.push(filterable(row, [roleText(item), item.name, ...chips, ...flags].join(' '), flags.length > 0))
    }

    bar.element.hidden = rows.length === 0
    content.replaceChildren(
      ...rows.length === 0 ? [tool.make('div', 'empty', 'Nothing here for a screen reader to stop at.')] : rows,
      bar.empty,
      tool.make('div', 'note', 'Names are worked out from the page by the steps of the accessible name computation and may differ in small ways from the browser\'s own: text a stylesheet adds with ::before or ::after is not read.'),
    )
    bar.apply(content)
  }
}
