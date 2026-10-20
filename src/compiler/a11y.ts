import type { Diagnostic, ElementNode, KayFile, NamedAttribute, Node, SnippetNode } from './ast'
import { ABSTRACT_ROLES, ARIA_ATTRIBUTES, closest, REQUIRED_STATES, ROLES, validAutocomplete } from './aria'
import { childBlocks, nodeExpressions, visitNodes } from './ast'

// Controls a person fills in, which a screen reader announces by their label.
const LABELLED = new Set(['input', 'select', 'textarea'])
// Inputs with no label of their own: hidden ones, and buttons named by their value.
const UNLABELLED_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image'])
// What names an element besides its content.
const NAMING = ['aria-label', 'aria-labelledby', 'title']
const HEADING = /^h([1-6])$/
// What gives an element content a screen reader reads, besides text.
const CONTENT_ATTRIBUTES = ['innerHTML', 'textContent', 'innerText']
// Elements the keyboard reaches unless disabled, besides a link with an `href` and an input that is not hidden.
const FOCUSABLE = new Set(['button', 'select', 'textarea', 'summary', 'iframe'])
// What HTML forbids inside a link or a button, besides a link and an input that is not hidden.
const INTERACTIVE = new Set(['button', 'select', 'textarea', 'details', 'iframe', 'embed'])
// Words a screen reader already says of an image, which its alt text then repeats.
const REDUNDANT_ALT = /\b(?:image|picture|photo)\s+of\b/i
const FILENAME_ALT = /^[\w-]+\.(?:png|jpe?g|gif|webp|avif|svg)$/i
const WHITESPACE = /\s+/
const NOT_LINE_BREAK = /[^\n]/g
// What a screen reader reads a tooltip's text from on an element the keyboard never reaches.
const DESCRIBING = ['aria-label', 'aria-labelledby', 'aria-describedby']
// The roles that leave an element as bare as having none.
const ROLELESS = /^\s*(?:none|presentation|generic)\s*$/i
// Elements with no role of their own, which ARIA 1.2 forbids naming: a screen reader ignores an `aria-label` on one.
const UNNAMEABLE = new Set(['span', 'div', 'p', 'b', 'i', 'u', 's', 'em', 'strong', 'small', 'mark', 'code', 'sub', 'sup', 'del', 'ins', 'abbr', 'kbd', 'q', 'cite', 'samp', 'var'])
// Attributes pointing at other elements by their ids.
const REFERENCES = ['aria-labelledby', 'aria-describedby']
// Roles named by a label, as a field is, besides the native fields.
const NAMED_ROLES = new Set(['slider', 'meter'])
// Roles grouping radios under a name, as a `fieldset` does.
const GROUP_ROLES = new Set(['group', 'radiogroup'])
const REFRESH_DELAY = /^\s*(\d+)/

interface Context {
  // Inside a `label`, which names the control it holds.
  label: boolean
  // Inside a component's children, which it may wrap in a label of its own.
  component: boolean
  // Inside an element hidden from screen readers, as a honeypot field is.
  hidden: boolean
  // Inside `hidden` or `inert`, so nothing there takes the keyboard.
  removed: boolean
  // Inside `aria-hidden="true"` and not removed: still on the page, so what takes the keyboard there goes unannounced.
  ariaHidden: boolean
  // Inside a `dialog`, where `autofocus` is how the spec says to pick what gets focus on opening.
  dialog: boolean
  // Inside a `fieldset` or a group, whose name the radios it holds are read under.
  grouped: boolean
  // The link or button holding the element, which may not hold another control.
  control?: ElementNode | undefined
  // Which alternative of each block the element renders in, `if` branches and `await` blocks being one page each.
  branches: ReadonlyMap<number, number>
  // Inside a `for`'s rows, so rendered once per row.
  repeated: boolean
  // The innermost `snippet` declaring the element, rendered wherever it is called.
  snippet?: SnippetNode | undefined
}

interface IdUse {
  id: string
  element: ElementNode
  branches: ReadonlyMap<number, number>
  repeated: boolean
  snippet?: SnippetNode | undefined
  // Repeated only because the snippet holding it is rendered more than once.
  byCalls?: boolean
}

// Where a snippet is called: in which alternatives, whether once per row of a `for`, and from which snippet.
interface CallSite {
  name: string
  branches: ReadonlyMap<number, number>
  repeated: boolean
  snippet: SnippetNode | undefined
}

// One render of a snippet's lines on the page.
interface Render {
  branches: ReadonlyMap<number, number>
  repeated: boolean
}

// How the checks walk into each kind of node: the blocks of an `if`, `match`, `for`, `await` or `try` are alternatives, each rendering on its own.
const WALKS: Record<Node['kind'], 'element' | 'within' | 'alternatives' | 'none'> = { element: 'element', text: 'within', slot: 'within', if: 'alternatives', match: 'alternatives', for: 'alternatives', await: 'alternatives', try: 'alternatives', pending: 'within', snippet: 'within', const: 'none', error: 'none' }

// The code with the inside of its strings, template text and comments blanked, as a name in one is no call; a `${ }` of a template stays code.
function maskLiterals(code: string): string {
  const blank = (part: string) => part.replace(NOT_LINE_BREAK, ' ')
  // The brace depth each open `${ }` was entered at, to know which `}` closes it.
  const holes: number[] = []
  let result = ''
  let depth = 0
  let template = false

  for (let at = 0; at < code.length; at++) {
    const char = code[at]!
    const next = code[at + 1]

    if (template) {
      if (char === '\\') {
        result += blank(code.slice(at, at + 2))
        at++
      }
      else if (char === '$' && next === '{') {
        result += '${'
        at++
        holes.push(depth++)
        template = false
      }
      else {
        result += char === '`' ? char : blank(char)
        template = char !== '`'
      }
    }
    else if (char === '`') {
      result += char
      template = true
    }
    else if (char === '"' || char === '\'') {
      let end = at + 1

      for (; end < code.length && code[end] !== char && code[end] !== '\n'; end++) {
        if (code[end] === '\\')
          end++
      }

      result += char + blank(code.slice(at + 1, end)) + (code[end] === char ? char : '')
      at = end
    }
    else if (char === '/' && (next === '/' || next === '*')) {
      const line = next === '/'
      const found = line ? code.indexOf('\n', at) : code.indexOf('*/', at + 2)
      let end = code.length

      if (found !== -1)
        end = line ? found : found + 2

      result += blank(code.slice(at, end))
      at = end - 1
    }
    else {
      if (char === '{') {
        depth++
      }
      else if (char === '}') {
        depth--

        if (holes.at(-1) === depth) {
          holes.pop()
          template = true
        }
      }

      result += char
    }
  }

  return result
}

// What a page needs to be used without seeing it, read off the markup alone: a control with no label, a button or link with nothing to announce, a heading skipping a level.
export function accessibilityLints(file: KayFile): Diagnostic[] {
  const { source } = file
  const found: Diagnostic[] = []
  const labelled = new Set<string>()
  const labels: { element: ElementNode, target: string }[] = []
  const controls: ElementNode[] = []
  const references: { attribute: NamedAttribute, id: string }[] = []
  const radios = new Map<string, ElementNode[]>()
  const ids: IdUse[] = []
  // Each `snippet` of the template, and the places calling one by name.
  const snippets = new Map<string, SnippetNode>()
  const calls: CallSite[] = []
  // A spread or an id written as an expression may hold any id, so no label pointing at one is reported.
  let dynamicIds = false
  let blocks = 0
  let heading: { level: number, name: string } | undefined
  const text = (span: { start: number, end: number }) => source.slice(span.start, span.end)
  const named = (element: ElementNode) => element.attributes.filter((attribute): attribute is NamedAttribute => attribute.kind !== 'spread')
  const attribute = (element: ElementNode, name: string) => named(element).find(candidate => text(candidate.name).toLowerCase() === name.toLowerCase())
  const has = (element: ElementNode, name: string) => attribute(element, name) !== undefined
  const staticValue = (element: ElementNode, name: string) => {
    const found = attribute(element, name)

    return found?.kind === 'static' ? found.text : undefined
  }
  const spread = (element: ElementNode) => element.attributes.some(attribute => attribute.kind === 'spread')
  const hidden = (element: ElementNode) => has(element, 'hidden') || staticValue(element, 'aria-hidden') === 'true'
  const at = (element: ElementNode) => element.tag.end > element.tag.start ? element.tag : element
  const lint = (element: ElementNode | { start: number, end: number }, code: string, message: string, details: Omit<Diagnostic, 'start' | 'end' | 'message' | 'code'>) => {
    found.push({ ...('kind' in element ? at(element) : element), code, message, ...details, checkOnly: true })
  }
  const tabindex = (element: ElementNode) => {
    const value = staticValue(element, 'tabindex')

    return value === undefined ? undefined : Number.parseInt(value, 10)
  }

  // Whether the keyboard reaches an element, as far as its markup says.
  const focusable = (element: ElementNode) => {
    if (has(element, 'tabindex'))
      return (tabindex(element) ?? -1) >= 0

    if (has(element, 'disabled'))
      return false

    if (element.name === 'a')
      return has(element, 'href')

    if (element.name === 'input')
      return staticValue(element, 'type')?.toLowerCase() !== 'hidden'

    return FOCUSABLE.has(element.name)
  }
  // Whether an `aria-label` is ignored on an element: it has no role, or a role that takes no name.
  const isUnnameable = (element: ElementNode) => {
    if (!UNNAMEABLE.has(element.name))
      return false

    const role = attribute(element, 'role')

    return role === undefined || (role.kind === 'static' && ROLELESS.test(role.text))
  }
  // Whether an element's markup gives a screen reader the tooltip's text without the keyboard: a name or a description, or the text itself as its only child.
  const speaksForTooltip = (element: ElementNode) => {
    if (DESCRIBING.some(name => has(element, name) && !(name === 'aria-label' && isUnnameable(element))))
      return true

    const tooltip = attribute(element, 'data-tooltip')
    const [only, ...rest] = element.children

    if (!tooltip || tooltip.kind === 'boolean' || only?.kind !== 'text' || rest.length > 0)
      return false

    const parts = only.parts.filter(part => part.kind !== 'chunk' || part.text.trim() !== '')

    if (parts.length !== 1)
      return false

    const [part] = parts

    if (tooltip.kind === 'expression')
      return part!.kind === 'expression' && text(part!.expression).trim() === text(tooltip.expression).trim()

    return tooltip.kind === 'static' && part!.kind === 'chunk' && part!.text.trim() === tooltip.text.trim()
  }
  const interactive = (element: ElementNode) => (element.name === 'a' && has(element, 'href'))
    || (element.name === 'input' && staticValue(element, 'type')?.toLowerCase() !== 'hidden')
    || INTERACTIVE.has(element.name)
    || (tabindex(element) ?? -1) >= 0

  // Whether what an element holds gives a screen reader something to read: text, a value, or something that may render either.
  function hasContent(nodes: Node[]): boolean {
    return nodes.some((node) => {
      if (node.kind === 'text')
        return node.parts.some(part => part.kind === 'expression' || (part.kind === 'chunk' ? part.text.trim() !== '' : elementHasContent(part)))

      if (node.kind === 'element')
        return elementHasContent(node)

      // A block may render anything.
      return true
    })
  }

  function elementHasContent(element: ElementNode): boolean {
    if (element.component || element.name === 'slot' || NAMING.some(name => has(element, name)) || CONTENT_ATTRIBUTES.some(name => has(element, name)))
      return true

    if (element.name === 'img')
      return has(element, 'alt') && staticValue(element, 'alt') !== ''

    return hasContent(element.children)
  }

  // Whether a `video` holds a captions track, or something that may render one.
  function hasCaptions(nodes: Node[]): boolean {
    return nodes.some((node) => {
      if (node.kind === 'text')
        return false

      if (node.kind !== 'element' || node.component || node.name === 'slot')
        return true

      if (node.name === 'track')
        return has(node, 'kind') && (staticValue(node, 'kind') === undefined || staticValue(node, 'kind')?.toLowerCase() === 'captions')

      return hasCaptions(node.children)
    })
  }

  const collectId = (element: ElementNode, context: Context) => {
    const id = element.id ? text(element.id) : staticValue(element, 'id')

    if (spread(element) || named(element).some(attribute => attribute.kind === 'expression' && text(attribute.name) === 'id'))
      dynamicIds = true

    if (id !== undefined)
      ids.push({ id, element, branches: context.branches, repeated: context.repeated, snippet: context.snippet })
  }

  const checkAria = (element: ElementNode) => {
    for (const attribute of named(element)) {
      const name = text(attribute.name).toLowerCase()

      if (name.startsWith('aria-') && !ARIA_ATTRIBUTES.has(name)) {
        const meant = closest(name, ARIA_ATTRIBUTES)

        lint(attribute.name, 'unknown-aria', `\`${text(attribute.name)}\` is no ARIA attribute`, {
          note: 'browsers and screen readers ignore an attribute ARIA does not define',
          help: meant !== undefined ? `write \`${meant}\`` : 'see the WAI-ARIA spec for the attributes there are',
          fixes: meant !== undefined ? [{ title: `Write \`${meant}\``, edits: [{ ...attribute.name, text: meant }] }] : undefined,
        })
      }
    }

    const role = attribute(element, 'role')

    if (role?.kind !== 'static')
      return

    let applied: string | undefined

    for (const token of role.text.trim().toLowerCase().split(WHITESPACE).filter(Boolean)) {
      if (ABSTRACT_ROLES.has(token)) {
        lint(role.value, 'unknown-role', `\`${token}\` is an abstract role, which no element may take`, { note: 'ARIA defines it only for other roles to build on, so screen readers ignore it', help: 'pick the concrete role it stands for, such as `button` for `command`' })
      }
      else if (!ROLES.has(token)) {
        const meant = closest(token, ROLES)

        lint(role.value, 'unknown-role', `\`${token}\` is no ARIA role`, { note: 'screen readers ignore a role ARIA does not define', help: meant !== undefined ? `write \`${meant}\`` : 'see the WAI-ARIA spec for the roles there are' })
      }
      else {
        applied ??= token
      }
    }

    // A native input announces its own state, as `input(type="checkbox" role="switch")` does whether it is checked.
    const missing = element.name === 'input' || HEADING.test(element.name) || applied === undefined ? [] : (REQUIRED_STATES.get(applied) ?? []).filter(state => !has(element, state))

    if (missing.length > 0)
      lint(role.value, 'missing-state', `A \`${applied}\` needs ${missing.map(state => `\`${state}\``).join(' and ')}`, { note: `a screen reader cannot say what state a \`${applied}\` is in without it`, help: `add \`${missing[0]}={...}\`, kept current, or use the native element` })
  }

  const checkElement = (element: ElementNode, context: Context) => {
    collectId(element, context)

    if (element.component || spread(element))
      return

    if (!context.hidden && !context.removed && staticValue(element, 'aria-hidden') === 'true' && !has(element, 'hidden') && !has(element, 'inert') && focusable(element))
      lint(element, 'hidden-focusable', `This \`${element.name}\` is hidden from screen readers but still takes the keyboard`, { note: 'a keyboard user lands on it while a screen reader says nothing of it', help: 'drop `aria-hidden`, or take it out of the tab order with `tabindex="-1"`' })
    else if (context.ariaHidden && focusable(element))
      lint(element, 'hidden-focusable', `This \`${element.name}\` sits inside \`aria-hidden="true"\` but still takes the keyboard`, { note: 'a keyboard user lands on it while a screen reader says nothing of it', help: 'drop `aria-hidden` from around it, or give it `tabindex="-1"`' })

    if (context.hidden || hidden(element))
      return

    if (element.name === 'label') {
      const target = staticValue(element, 'for')

      if (target !== undefined) {
        labelled.add(target)
        labels.push({ element, target })
      }
    }

    const level = HEADING.exec(element.name)

    if (level) {
      const current = Number(level[1])

      if (heading && current > heading.level + 1)
        lint(element, 'skipped-heading', `This \`${element.name}\` follows an \`${heading.name}\`, skipping a level`, { note: 'screen reader users move through a page by its headings, and a skipped level reads as a missing section', help: `make it an \`h${heading.level + 1}\`, styled as it should look` })

      heading = { level: current, name: element.name }
    }

    const type = staticValue(element, 'type')?.toLowerCase()

    const roles = staticValue(element, 'role')?.trim().toLowerCase().split(WHITESPACE) ?? []
    // A placeholder is no label: it is gone once the field holds text, and RGAA does not take it as one.
    const field = (LABELLED.has(element.name) && !(element.name === 'input' && type !== undefined && UNLABELLED_TYPES.has(type))) || element.name === 'meter' || roles.some(role => NAMED_ROLES.has(role))

    if (field && !context.label && !context.component && !NAMING.some(name => has(element, name)))
      controls.push(element)

    const radioName = element.name === 'input' && type === 'radio' && !context.grouped && !context.component ? staticValue(element, 'name') : undefined

    if (radioName !== undefined)
      radios.set(radioName, [...radios.get(radioName) ?? [], element])

    for (const name of REFERENCES) {
      const reference = attribute(element, name)

      if (reference?.kind === 'static') {
        for (const id of reference.text.trim().split(WHITESPACE).filter(Boolean))
          references.push({ attribute: reference, id })
      }
    }

    if (has(element, 'data-tooltip') && !focusable(element) && attribute(element, 'tabindex')?.kind !== 'expression' && !speaksForTooltip(element)) {
      const generic = isUnnameable(element)
      const base = 'a tooltip shows as the pointer or the focus lands on its element, and the keyboard never lands on this one'
      const note = generic && has(element, 'aria-label') ? `${base}, and a screen reader ignores an \`aria-label\` on a role-less element` : base
      const help = `put it on a \`button\` or a link, give the element \`tabindex="0"\`, or say the same in ${generic ? '' : '`aria-label` or '}visible text`

      lint(attribute(element, 'data-tooltip')!.name, 'unreachable-tooltip', `This \`${element.name}\`'s tooltip shows only under the pointer`, { note, help })
    }

    if ((element.name === 'video' || element.name === 'audio') && has(element, 'autoplay') && !has(element, 'controls'))
      lint(attribute(element, 'autoplay')!.name, 'uncontrolled-autoplay', `This \`${element.name}\` plays by itself with no controls`, { note: 'a visitor who did not start it has no way to pause or stop it', help: 'add `controls`, or a pause button of its own beside it' })

    const delay = element.name === 'meta' && staticValue(element, 'http-equiv')?.trim().toLowerCase() === 'refresh' ? REFRESH_DELAY.exec(staticValue(element, 'content') ?? '') : null

    if (delay && Number(delay[1]) > 0)
      lint(element, 'meta-refresh', 'This `meta` reloads or leaves the page after a delay', { note: 'the page changes under a visitor still reading it, with no way to stop it', help: 'redirect on the server, or let the visitor follow a link' })

    if ((element.name === 'button' || (element.name === 'a' && has(element, 'href'))) && !elementHasContent(element))
      lint(element, 'empty-control', `This \`${element.name}\` has nothing for a screen reader to announce`, { note: 'an icon alone is hidden from screen readers, so the control reads as nameless', help: 'give it text, or name it with `aria-label`' })

    checkAria(element)

    if ((tabindex(element) ?? 0) > 0)
      lint(attribute(element, 'tabindex')!.name, 'positive-tabindex', 'A `tabindex` above 0 moves this element ahead of the page\'s order', { note: 'the keyboard then jumps here first, out of the order the page reads in', help: 'use `tabindex="0"`, and order the markup as it should be reached' })

    const autofocus = attribute(element, 'autofocus')

    // An element only a script or `autofocus` focuses, `tabindex="-1"`, is where a page moves focus on purpose, such as the message a form post renders.
    if (autofocus && autofocus.kind !== 'expression' && !context.dialog && (tabindex(element) ?? 0) >= 0)
      lint(autofocus.name, 'autofocus', '`autofocus` moves the focus as the page loads', { note: 'a screen reader starts reading there, skipping what comes before, and a phone may open its keyboard over the page', help: 'let the visitor choose where to start; inside a `dialog`, `autofocus` is fine' })

    if (element.name === 'a' && has(element, 'onClick') && !has(element, 'role')) {
      const href = staticValue(element, 'href')?.trim().toLowerCase()

      if (!has(element, 'href') || href === '#' || href?.startsWith('javascript:'))
        lint(element, 'link-as-button', 'This `a` acts as a button', { note: 'a screen reader announces it as a link, and a link with no `href` takes no keyboard', help: 'make it a `button`, or give it the `href` it goes to' })
    }

    if (context.control && interactive(element))
      lint(element, 'nested-control', `This \`${element.name}\` sits inside ${context.control.name === 'a' ? 'an' : 'a'} \`${context.control.name}\``, { related: [{ ...at(context.control), label: 'the control around it' }], note: 'HTML forbids a control inside a link or a button: a click or a screen reader reaches only one of them', help: 'move it out, beside the other' })

    if (element.name === 'video' && !has(element, 'muted') && !hasCaptions(element.children))
      lint(element, 'missing-captions', 'This `video` has no captions', { note: 'a deaf visitor gets nothing of what is said', help: 'add `track(kind="captions" src="..." srclang="en")` inside it, or `muted` for a video with no sound worth hearing' })

    const alt = element.name === 'img' ? staticValue(element, 'alt')?.trim() : undefined

    if (alt !== undefined && alt !== '' && (REDUNDANT_ALT.test(alt) || FILENAME_ALT.test(alt)))
      lint(attribute(element, 'alt')!.name, 'redundant-alt', FILENAME_ALT.test(alt) ? 'This alt text is a filename' : 'This alt text says it is an image', { note: 'a screen reader already announces an image as one, and a filename says nothing of what it shows', help: 'say what the image shows, as you would to someone who cannot see it' })

    const autocomplete = staticValue(element, 'autocomplete')

    if (autocomplete !== undefined && (element.name === 'form' ? !['on', 'off'].includes(autocomplete.trim().toLowerCase()) : LABELLED.has(element.name) && !validAutocomplete(autocomplete)))
      lint(attribute(element, 'autocomplete')!.name, 'invalid-autocomplete', autocomplete.trim() === '' ? 'An empty `autocomplete` names no value' : `\`${autocomplete}\` is no \`autocomplete\` value`, { note: 'browsers and password managers fill a field from its `autocomplete`, and ignore one they do not know', help: element.name === 'form' ? 'a form takes `on` or `off`' : 'use one of HTML\'s autofill names, such as `email`, `given-name`, `current-password` or `postal-code`' })
  }

  const inside = (element: ElementNode, context: Context): Context => ({
    label: context.label || element.name === 'label',
    component: context.component || element.component,
    hidden: context.hidden || hidden(element),
    removed: context.removed || has(element, 'hidden') || has(element, 'inert'),
    ariaHidden: (context.ariaHidden || staticValue(element, 'aria-hidden') === 'true') && !context.removed && !has(element, 'hidden') && !has(element, 'inert'),
    dialog: context.dialog || element.name === 'dialog',
    grouped: context.grouped || element.name === 'fieldset' || (staticValue(element, 'role')?.trim().toLowerCase().split(WHITESPACE).some(role => GROUP_ROLES.has(role)) ?? false),
    control: context.control ?? (!element.component && (element.name === 'button' || (element.name === 'a' && has(element, 'href'))) ? element : undefined),
    branches: context.branches,
    repeated: context.repeated,
    snippet: context.snippet,
  })
  // Each alternative of a block renders on its own, so what one holds never meets what another does.
  const alternatives = (context: Context, count: number, visitOne: (index: number, branch: Context) => void) => {
    const block = blocks++

    for (let index = 0; index < count; index++)
      visitOne(index, { ...context, branches: new Map([...context.branches, [block, index]]) })
  }

  visitNodes(file.template, (node) => {
    if (node.kind === 'snippet')
      snippets.set(text(node.name), node)
  })

  // A snippet is called as `name(`, which a member of an object of the same name is not.
  const callable = snippets.size > 0 ? new RegExp(`(?<![\\w$.])(${[...snippets.keys()].map(name => RegExp.escape(name)).join('|')})\\s*\\(`, 'g') : undefined
  const collectCalls = (node: Node, context: Context) => {
    for (const span of nodeExpressions(node)) {
      for (const match of maskLiterals(text(span)).matchAll(callable!))
        calls.push({ name: match[1]!, branches: context.branches, repeated: context.repeated, snippet: context.snippet })
    }
  }

  const visit = (nodes: Node[], context: Context) => {
    for (const node of nodes) {
      const walk = WALKS[node.kind]

      if (callable)
        collectCalls(node, context)

      if (node.kind === 'element') {
        checkElement(node, context)
        visit(node.children, inside(node, context))
      }
      else if (walk === 'within') {
        for (const block of childBlocks(node))
          visit(block, node.kind === 'slot' || node.kind === 'snippet' ? { ...context, component: true, snippet: node.kind === 'snippet' ? node : context.snippet } : context)
      }
      else if (walk === 'alternatives') {
        const children = childBlocks(node)
        const before = heading

        alternatives(context, children.length, (index, branch) => {
          // Each branch is another page: the heading before the block leads each, not the branch shown before it.
          if (node.kind === 'if' || node.kind === 'match')
            heading = before

          visit(children[index]!, { ...branch, repeated: branch.repeated || (node.kind === 'for' && index === 0) })
        })
      }
    }
  }

  visit(file.template, { label: false, component: false, hidden: false, removed: false, ariaHidden: false, dialog: false, grouped: false, branches: new Map(), repeated: false })

  // A call made by the script block runs wherever the component does, which no alternative or row narrows.
  if (callable && file.script) {
    for (const match of maskLiterals(text(file.script)).matchAll(callable))
      calls.push({ name: match[1]!, branches: new Map(), repeated: false, snippet: undefined })
  }

  for (const control of controls) {
    const id = control.id ? text(control.id) : staticValue(control, 'id')
    const dynamicId = !control.id && named(control).some(attribute => attribute.kind === 'expression' && text(attribute.name) === 'id')

    // An id written as an expression may be the one a label points at.
    if (dynamicId || (id !== undefined && labelled.has(id)))
      continue

    lint(control, 'missing-label', `This \`${control.name}\` has no label`, { note: 'a screen reader announces a field by its label, and says nothing of what to type in one without', help: id === undefined ? 'wrap it in a `label`, or give it an id a `label(for="...")` points at' : `add \`label(for="${id}")\`, or name it with \`aria-label\`` })
  }

  const known = new Set(ids.map(use => use.id))

  for (const { element, target } of dynamicIds ? [] : labels) {
    if (!known.has(target))
      lint(attribute(element, 'for')!.name, 'dangling-label', `This \`label\` points at \`#${target}\`, which nothing here has`, { note: 'a label names the field whose id it gives, so this one names none', help: `give the field \`id="${target}"\`, or wrap the field in the label` })
  }

  for (const { attribute: reference, id } of dynamicIds ? [] : references) {
    if (!known.has(id))
      lint(reference.name, 'dangling-aria', `\`${text(reference.name)}\` points at \`#${id}\`, which nothing here has`, { note: 'a screen reader reads the elements whose ids it lists, so this one reads nothing', help: `give the element \`id="${id}"\`, or drop the id from the list` })
  }

  for (const [name, group] of radios) {
    if (group.length > 1)
      lint(group[0]!, 'ungrouped-radios', `The radios named \`${name}\` sit in no \`fieldset\``, { note: 'a screen reader reads each radio by its own label, never the question they answer', help: 'wrap them in a `fieldset` whose `legend` asks it, or an element with `role="radiogroup"` and `aria-label`' })
  }

  checkIds(rendered(ids))

  return found

  // The ids of the page, a snippet's once for each place rendering it.
  function rendered(uses: IdUse[]): IdUse[] {
    const memo = new Map<SnippetNode, Render[]>()
    const pending = new Set<SnippetNode>()
    // The pending snippets a list under construction was cut short at: it is complete only once none is left.
    let cuts = new Set<SnippetNode>()
    const rendersOf = (snippet: SnippetNode): Render[] => {
      const known = memo.get(snippet)

      if (known)
        return known

      // A snippet calling itself renders once more for each level it goes down.
      if (pending.has(snippet)) {
        cuts.add(snippet)

        return [{ branches: new Map(), repeated: true }]
      }

      pending.add(snippet)

      const outer = cuts

      cuts = new Set()

      const renders = calls.filter(call => snippets.get(call.name) === snippet).flatMap((call): Render[] => call.snippet ? rendersOf(call.snippet).map(render => ({ branches: new Map([...call.branches, ...render.branches]), repeated: call.repeated || render.repeated })) : [call])

      pending.delete(snippet)
      cuts.delete(snippet)

      // A list cut short at a snippet still pending would differ from the one met first, so it is worked out again where it is needed.
      if (cuts.size === 0)
        memo.set(snippet, renders)

      for (const cut of cuts)
        outer.add(cut)

      cuts = outer

      return renders
    }

    return uses.flatMap((use) => {
      const renders = use.snippet ? rendersOf(use.snippet) : []

      // A snippet never called, or only passed to a component, renders where its component says.
      if (renders.length === 0)
        return [use]

      return renders.map(render => ({ ...use, branches: new Map([...render.branches, ...use.branches]), repeated: use.repeated || render.repeated, byCalls: !use.repeated && render.repeated }))
    })
  }

  function checkIds(uses: IdUse[]) {
    const first = new Map<string, IdUse[]>()
    const reported = new Set<ElementNode>()
    const perCall = (use: IdUse) => {
      reported.add(use.element)
      lint(use.element, 'duplicate-id', `The id \`${use.id}\` repeats on every call of its snippet \`${text(use.snippet!.name)}\``, { note: 'an id names one element of the page: a label, a link or a script reaching it gets only the first call\'s', help: `make it unique per call, built from a parameter: \`id={\`${use.id}-\${...}\`}\`` })
    }

    for (const use of uses) {
      if (use.element.component || reported.has(use.element))
        continue

      if (use.byCalls) {
        perCall(use)

        continue
      }

      if (use.repeated) {
        lint(use.element, 'duplicate-id', `The id \`${use.id}\` repeats on every row of its \`for\``, { note: 'an id names one element of the page: a label, a link or a script reaching it gets only the first row\'s', help: `make it unique per row, \`id={\`${use.id}-\${...}\`}\`` })

        continue
      }

      const before = first.get(use.id) ?? []
      const clash = before.find(other => !exclusive(other.branches, use.branches))

      if (clash?.element === use.element)
        perCall(use)
      else if (clash)
        lint(use.element, 'duplicate-id', `The id \`${use.id}\` is already used`, { related: [{ ...at(clash.element), label: 'first used here' }], note: 'an id names one element of the page: a label, a link or a script reaching it gets only the first', help: 'give each element an id of its own' })

      first.set(use.id, [...before, use])
    }
  }
}

// Whether two elements are in different alternatives of one block, so never on the page together.
function exclusive(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
  for (const [block, index] of a) {
    if (b.has(block) && b.get(block) !== index)
      return true
  }

  return false
}
