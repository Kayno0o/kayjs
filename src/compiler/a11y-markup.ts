import type { Diagnostic, ElementNode, KayFile, NamedAttribute, Node } from './ast'
import type { Lint } from './lints'
import { ARIA_ATTRIBUTES, ROLES } from './aria'
import { childBlocks } from './ast'

// What names an element besides its content.
const NAMING = ['aria-label', 'aria-labelledby', 'title']
// What gives an element content a screen reader reads, besides text.
const CONTENT_ATTRIBUTES = ['innerHTML', 'textContent', 'innerText']
const HEADING = /^h[1-6]$/
const WHITESPACE = /\s+/
const EVENT = /^on[A-Z]/
const KEY_EVENTS = ['onkeydown', 'onkeyup', 'onkeypress']

// The lints of this file, with the other lints in `LINTS`.
export const MARKUP_LINTS = {
  'redundant-alt': {
    level: 'warn',
    group: 'a11y',
    summary: 'Alt text saying it is an image, `image of`, `picture of` or `photo of`, or a filename: a screen reader already announces an image as one, and a filename says nothing of what it shows.',
    wrong: 'img(src="/team.jpg" alt="Photo of the team")',
    right: 'img(src="/team.jpg" alt="The team at the 2025 offsite")',
  },
  'empty-heading': {
    level: 'warn',
    group: 'a11y',
    summary: 'An `h1` to `h6` holding nothing a screen reader reads: no text, no value, no `aria-label`, an icon alone. Screen reader users list a page by its headings, and an empty one is a blank entry. One holding a component, a slot, a block or an expression is left alone.',
    wrong: 'h2\n  svg(viewBox="0 0 24 24" aria-hidden="true")',
    right: 'h2 Plans',
  },
  'anchor-is-valid': {
    level: 'warn',
    group: 'a11y',
    summary: 'An `a` with no `href`, or one whose `href` is empty, `#` or a `javascript:` URL, and no click handler (`link-as-button` reports that one): it goes nowhere, takes no keyboard, and a screen reader does not list it among the links. An `a` with a `role`, a `name`, a handler or a spread is left alone.',
    wrong: 'a Read more',
    right: 'a(href="/blog") Read more',
  },
  'redundant-role': {
    level: 'warn',
    group: 'a11y',
    summary: 'A `role` an element already has, `button(role="button")` or `nav(role="navigation")`: a screen reader announces it the same without. `role="list"` on a `ul` or `ol` stays, as it keeps the list in Safari once `list-style: none` is set.',
    wrong: 'nav(role="navigation" aria-label="Main")',
    right: 'nav(aria-label="Main")',
  },
  'unsupported-aria': {
    level: 'warn',
    group: 'a11y',
    summary: 'An `aria-*` attribute the element\'s role does not take, `aria-checked` on a `button` or `aria-expanded` on an `h2`: a screen reader ignores it. The role is the `role` written, or the one the tag has; a role or an element ARIA\'s tables leave open is not checked, nor is a global attribute such as `aria-label` or `aria-hidden`.',
    wrong: 'button(aria-checked={on} onClick={toggle}) Bold',
    right: 'button(aria-pressed={on} onClick={toggle}) Bold',
  },
  'multiple-h1': {
    level: 'warn',
    group: 'a11y',
    summary: 'A second `h1` in one template: the `h1` names the page, so screen reader users jumping to it find two answers. The branches of an `if` or a `match` are pages of their own, and an `h1` in a `for` or a `snippet` is left alone.',
    wrong: 'h1 Plans\nh1 Pricing',
    right: 'h1 Plans\nh2 Pricing',
  },
  'no-access-key': {
    level: 'warn',
    group: 'a11y',
    summary: 'An `accesskey`: the key it takes differs between browsers and systems and clashes with the shortcuts of screen readers, which people rely on.',
    wrong: 'button(accesskey="s") Save',
    right: 'button Save',
  },
  'click-without-key': {
    level: 'warn',
    group: 'a11y',
    summary: 'An element with `onClick` that the keyboard reaches through a `tabindex` of 0 or more, but with no `onKeyDown`, `onKeyUp` or `onKeyPress`: Enter and Space do nothing on it. A `button`, a link or a field is native, and a `dialog` or `aria-modal` backdrop is left alone.',
    wrong: 'div(role="button" tabindex="0" onClick={save}) Save',
    right: 'button(onClick={save}) Save',
  },
  'interactive-tabindex': {
    level: 'warn',
    group: 'a11y',
    summary: 'A `tabindex="0"` on an element that is read, not operated: a `p`, a heading, a list, an `img`, a table part. A keyboard user stops on it and nothing happens. One with a `role` or an event handler is left alone, and so is a `div` or a `section`, which a scrollable region may need it on.',
    wrong: 'p(tabindex="0") Terms apply',
    right: 'p Terms apply',
  },
} as const satisfies Record<string, Lint>

// How a template's attributes are read: by name whatever the case, a value only when it is written as text.
export interface Reader {
  text: (span: { start: number, end: number }) => string
  named: (element: ElementNode) => NamedAttribute[]
  attribute: (element: ElementNode, name: string) => NamedAttribute | undefined
  has: (element: ElementNode, name: string) => boolean
  staticValue: (element: ElementNode, name: string) => string | undefined
  spread: (element: ElementNode) => boolean
}

export function reader(source: string): Reader {
  const text = (span: { start: number, end: number }) => source.slice(span.start, span.end)
  const named = (element: ElementNode) => element.attributes.filter((attribute): attribute is NamedAttribute => attribute.kind !== 'spread')
  const attribute = (element: ElementNode, name: string) => named(element).find(candidate => text(candidate.name).toLowerCase() === name.toLowerCase())
  const staticValue = (element: ElementNode, name: string) => {
    const found = attribute(element, name)

    return found?.kind === 'static' ? found.text : undefined
  }

  return { text, named, attribute, has: (element, name) => attribute(element, name) !== undefined, staticValue, spread: element => element.attributes.some(candidate => candidate.kind === 'spread') }
}

// Whether what an element holds gives a screen reader something to read: text, a value, or something that may render either.
function hasContent(nodes: Node[], read: Reader): boolean {
  return nodes.some((node) => {
    if (node.kind === 'text')
      return node.parts.some(part => part.kind === 'expression' || (part.kind === 'chunk' ? part.text.trim() !== '' : elementHasContent(part, read)))

    if (node.kind === 'element')
      return elementHasContent(node, read)

    // A block may render anything.
    return true
  })
}

export function elementHasContent(element: ElementNode, read: Reader): boolean {
  if (element.component || element.name === 'slot' || NAMING.some(name => read.has(element, name)) || CONTENT_ATTRIBUTES.some(name => read.has(element, name)))
    return true

  if (element.name === 'img')
    return read.has(element, 'alt') && read.staticValue(element, 'alt') !== ''

  return hasContent(element.children, read)
}

// ARIA 1.2's attributes any role takes, the deprecated ones included.
const GLOBAL_ARIA = new Set(['aria-atomic', 'aria-braillelabel', 'aria-brailleroledescription', 'aria-busy', 'aria-controls', 'aria-current', 'aria-describedby', 'aria-description', 'aria-details', 'aria-disabled', 'aria-dropeffect', 'aria-errormessage', 'aria-flowto', 'aria-grabbed', 'aria-haspopup', 'aria-hidden', 'aria-invalid', 'aria-keyshortcuts', 'aria-label', 'aria-labelledby', 'aria-live', 'aria-owns', 'aria-relevant', 'aria-roledescription'])

const CHECKBOX_STATES = ['checked', 'expanded', 'readonly', 'required']
const NONE: string[] = []

// What each role takes besides the global attributes, written without the `aria-` prefix, for the roles whose list is settled: a role left out is not checked.
const SUPPORTED_ARIA: ReadonlyMap<string, readonly string[]> = new Map(Object.entries({
  alertdialog: ['modal'],
  banner: NONE,
  button: ['expanded', 'pressed'],
  checkbox: CHECKBOX_STATES,
  combobox: ['activedescendant', 'autocomplete', 'expanded', 'orientation', 'readonly', 'required'],
  complementary: NONE,
  contentinfo: NONE,
  dialog: ['modal'],
  heading: ['level'],
  img: NONE,
  link: ['expanded'],
  list: NONE,
  listitem: ['level', 'posinset', 'setsize'],
  main: NONE,
  navigation: NONE,
  option: ['checked', 'posinset', 'selected', 'setsize'],
  progressbar: ['valuemax', 'valuemin', 'valuenow', 'valuetext'],
  radio: ['checked', 'posinset', 'setsize'],
  slider: ['orientation', 'readonly', 'valuemax', 'valuemin', 'valuenow', 'valuetext'],
  switch: CHECKBOX_STATES,
  tab: ['expanded', 'posinset', 'selected', 'setsize'],
  tablist: ['level', 'multiselectable', 'orientation'],
  tabpanel: NONE,
  textbox: ['activedescendant', 'autocomplete', 'multiline', 'placeholder', 'readonly', 'required'],
}).map(([role, states]) => [role, states.map(state => `aria-${state}`)]))

// The role an element has with none written, for the tags and input types where it never depends on context.
const IMPLICIT_ROLES: ReadonlyMap<string, string> = new Map([
  ['article', 'article'],
  ['aside', 'complementary'],
  ['button', 'button'],
  ['dialog', 'dialog'],
  ['h1', 'heading'],
  ['h2', 'heading'],
  ['h3', 'heading'],
  ['h4', 'heading'],
  ['h5', 'heading'],
  ['h6', 'heading'],
  ['hr', 'separator'],
  ['main', 'main'],
  ['nav', 'navigation'],
  ['ol', 'list'],
  ['li', 'listitem'],
  ['table', 'table'],
  ['textarea', 'textbox'],
  ['ul', 'list'],
])
const INPUT_ROLES: ReadonlyMap<string, string> = new Map([['checkbox', 'checkbox'], ['radio', 'radio'], ['range', 'slider'], ['button', 'button'], ['submit', 'button'], ['reset', 'button'], ['image', 'button']])
// Roles worth writing out anyway: `list-style: none` makes Safari drop a list's role, which `role="list"` brings back.
const ROLE_RESTORING = new Set(['list', 'listitem'])
// What a person reads or looks at, not operates: a `tabindex="0"` on one adds a stop to the keyboard that does nothing.
const STATIC_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'img', 'blockquote', 'figure', 'table', 'tr', 'td', 'th', 'dl', 'dt', 'dd', 'hr'])
// What the browser makes a target of the keyboard and the click of a handler, with no `tabindex` or `role`.
const NATIVE_CLICK = new Set(['button', 'input', 'select', 'textarea', 'summary', 'option', 'details', 'label', 'form', 'video', 'audio'])
const BACKDROPS = new Set(['dialog', 'alertdialog'])

function branchesApart(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
  for (const [block, index] of a) {
    if (b.has(block) && b.get(block) !== index)
      return true
  }

  return false
}

interface Walk {
  // Which alternative of each block the element renders in.
  branches: ReadonlyMap<number, number>
  // Rendered once per row of a `for`, or wherever a `snippet` is called: more than once whatever the markup says.
  repeated: boolean
  // Inside an element with a key handler, which keys pressed on a descendant reach as they bubble: a tree or a listbox handles its rows' keys on its own element.
  keys: boolean
}

// What the markup alone says of a heading, a link, a role, an `aria-*` attribute, `accesskey` or a click, read off the elements it is sure of: none inside `aria-hidden`, none with a spread, none a component.
export function markupLints(file: KayFile): Diagnostic[] {
  const { source } = file
  const read = reader(source)
  const { text, named, attribute, has, staticValue, spread } = read
  const found: Diagnostic[] = []
  const h1s: { element: ElementNode, branches: ReadonlyMap<number, number> }[] = []
  let blocks = 0
  const at = (element: ElementNode) => element.tag.end > element.tag.start ? element.tag : element
  const lint = (span: { start: number, end: number }, code: string, message: string, details: Pick<Diagnostic, 'note' | 'help' | 'related'>) => {
    found.push({ ...span, code, message, ...details, checkOnly: true })
  }
  const roleTokens = (element: ElementNode) => staticValue(element, 'role')?.trim().toLowerCase().split(WHITESPACE).filter(Boolean) ?? []
  const implicitRole = (element: ElementNode): string | undefined => {
    if (element.name === 'a')
      return has(element, 'href') ? 'link' : undefined

    if (element.name === 'img')
      return staticValue(element, 'alt') === '' ? undefined : 'img'

    if (element.name === 'input') {
      const type = staticValue(element, 'type')?.toLowerCase()

      return type === undefined ? undefined : INPUT_ROLES.get(type)
    }

    return IMPLICIT_ROLES.get(element.name)
  }

  const checkRole = (element: ElementNode) => {
    const role = attribute(element, 'role')
    const implicit = implicitRole(element)

    if (role !== undefined && role.kind !== 'static')
      return

    const applied = roleTokens(element).find(token => ROLES.has(token))

    if (role !== undefined && implicit !== undefined && implicit === roleTokens(element)[0] && !ROLE_RESTORING.has(implicit))
      lint(role.name, 'redundant-role', `\`role="${implicit}"\` is what a \`${element.name}\` already has`, { note: 'a screen reader announces the element the same with or without it', help: 'remove the `role`' })

    const supported = SUPPORTED_ARIA.get(role === undefined ? implicit ?? '' : applied ?? '')

    if (!supported)
      return

    for (const candidate of named(element)) {
      const name = text(candidate.name).toLowerCase()

      if (ARIA_ATTRIBUTES.has(name) && !GLOBAL_ARIA.has(name) && !supported.includes(name))
        lint(candidate.name, 'unsupported-aria', `\`${name}\` is not supported by the \`${role === undefined ? implicit : applied}\` role of this \`${element.name}\``, { note: 'a screen reader ignores a state or property its role does not take', help: role === undefined ? 'give the element a role that takes it, or remove it' : 'use a role that takes it, or remove it' })
    }
  }

  const checkClick = (element: ElementNode, walk: Walk) => {
    const click = attribute(element, 'onClick')
    const index = staticValue(element, 'tabindex')
    const focusable = index !== undefined && Number.parseInt(index, 10) >= 0

    if (!click || NATIVE_CLICK.has(element.name) || (element.name === 'a' && has(element, 'href')) || !focusable)
      return

    if (roleTokens(element).some(token => BACKDROPS.has(token)) || (has(element, 'aria-modal') && staticValue(element, 'aria-modal') !== 'false') || walk.keys || KEY_EVENTS.some(name => has(element, name)))
      return

    lint(click.name, 'click-without-key', `This \`${element.name}\` reacts to \`onClick\` and has no key handler`, { note: 'the keyboard reaches it, but Enter and Space do nothing there: only a pointer can press it', help: 'make it a `button`, or add `onKeyDown` handling Enter and Space' })
  }

  const check = (element: ElementNode, walk: Walk) => {
    if (HEADING.test(element.name) && !elementHasContent(element, read))
      lint(at(element), 'empty-heading', `This \`${element.name}\` has no content`, { note: 'a screen reader lists it among the page\'s headings and reads nothing for it', help: 'give it text, or remove it' })

    if (element.name === 'h1' && !walk.repeated)
      h1s.push({ element, branches: walk.branches })

    if (element.name === 'a' && !has(element, 'role') && !named(element).some(candidate => EVENT.test(text(candidate.name)))) {
      const target = attribute(element, 'href')

      if (!target && !has(element, 'name'))
        lint(at(element), 'anchor-is-valid', 'This `a` has no `href`', { note: 'a link with no destination takes no keyboard and a screen reader does not list it among the links', help: 'give it the `href` it goes to, or make it a `button` when it acts' })
      else if (target?.kind === 'static' && !href(target.text))
        lint(target.value, 'anchor-is-valid', `\`href="${target.text}"\` goes nowhere`, { note: 'a link to nowhere moves the page to its top or does nothing, and tells a screen reader a destination exists', help: 'give it the page it goes to, or make it a `button` when it acts' })
    }

    const key = attribute(element, 'accesskey')

    if (key)
      lint(key.name, 'no-access-key', '`accesskey` clashes with the shortcuts of screen readers and browsers', { note: 'the key it takes differs between browsers and operating systems and may override a shortcut a person relies on', help: 'remove it' })

    const index = staticValue(element, 'tabindex')

    if (index !== undefined && STATIC_TAGS.has(element.name) && Number.parseInt(index, 10) === 0 && !has(element, 'role') && !named(element).some(candidate => EVENT.test(text(candidate.name))))
      lint(attribute(element, 'tabindex')!.name, 'interactive-tabindex', `\`tabindex="0"\` puts this \`${element.name}\` in the tab order but it does nothing`, { note: 'a keyboard user stops on it and nothing happens, and a screen reader announces it as the element it is', help: 'remove it, or use a `button` or a link when it acts; `tabindex="-1"` still lets a script focus it' })

    checkRole(element)
    checkClick(element, walk)
  }

  const visit = (nodes: Node[], walk: Walk) => {
    for (const node of nodes) {
      if (node.kind === 'element') {
        if (has(node, 'hidden') || staticValue(node, 'aria-hidden') === 'true')
          continue

        if (!node.component && !spread(node))
          check(node, walk)

        visit(node.children, KEY_EVENTS.some(name => has(node, name)) ? { ...walk, keys: true } : walk)

        continue
      }

      const alternatives = node.kind === 'if' || node.kind === 'match' || node.kind === 'await' || node.kind === 'try' || node.kind === 'for'
      const block = alternatives ? blocks++ : 0

      for (const [index, children] of childBlocks(node).entries()) {
        if (!alternatives)
          visit(children, node.kind === 'snippet' ? { ...walk, repeated: true } : walk)
        else
          visit(children, { ...walk, branches: new Map([...walk.branches, [block, index]]), repeated: walk.repeated || (node.kind === 'for' && index === 0) })
      }
    }
  }

  visit(file.template, { branches: new Map(), repeated: false, keys: false })

  for (const [index, { element, branches }] of h1s.entries()) {
    const first = h1s.slice(0, index).find(other => !branchesApart(other.branches, branches))

    if (first)
      lint(at(element), 'multiple-h1', 'This page has a second `h1`', { related: [{ ...at(first.element), label: 'the first one' }], note: 'the `h1` names the page, and a screen reader user jumping to it finds two answers', help: 'make this one an `h2`, styled as it should look' })
  }

  return found
}

// Whether an `href` goes somewhere: not empty, `#` alone, nor a `javascript:` one.
function href(value: string): boolean {
  const target = value.trim().toLowerCase()

  return target !== '' && target !== '#' && !target.startsWith('javascript:')
}
