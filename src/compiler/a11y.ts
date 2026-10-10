import type { Diagnostic, ElementNode, KayFile, NamedAttribute, Node } from './ast'
import { ABSTRACT_ROLES, ARIA_ATTRIBUTES, closest, REQUIRED_STATES, ROLES, validAutocomplete } from './aria'
import { awaitBlocks, tryBlocks } from './ast'

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
const REDUNDANT_ALT = /\b(?:image|picture|photo)\b/i
const FILENAME_ALT = /^[\w-]+\.(?:png|jpe?g|gif|webp|avif|svg)$/i
const WHITESPACE = /\s+/

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
  // The link or button holding the element, which may not hold another control.
  control?: ElementNode | undefined
  // Which alternative of each block the element renders in, `if` branches and `await` blocks being one page each.
  branches: ReadonlyMap<number, number>
  // Inside a `for`'s rows, so rendered once per row.
  repeated: boolean
}

interface IdUse {
  id: string
  element: ElementNode
  branches: ReadonlyMap<number, number>
  repeated: boolean
}

// What a page needs to be used without seeing it, read off the markup alone: a control with no label, a button or link with nothing to announce, a heading skipping a level.
export function accessibilityLints(file: KayFile): Diagnostic[] {
  const { source } = file
  const found: Diagnostic[] = []
  const labelled = new Set<string>()
  const labels: { element: ElementNode, target: string }[] = []
  const controls: ElementNode[] = []
  const ids: IdUse[] = []
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
      ids.push({ id, element, branches: context.branches, repeated: context.repeated })
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
    const missing = element.name === 'input' || applied === undefined ? [] : (REQUIRED_STATES.get(applied) ?? []).filter(state => !has(element, state))

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

    // A placeholder names a field too when nothing else does, as browsers and axe take it, though it is gone once the field holds text.
    if (LABELLED.has(element.name) && !(element.name === 'input' && type !== undefined && UNLABELLED_TYPES.has(type)) && !context.label && !context.component && ![...NAMING, 'placeholder'].some(name => has(element, name)))
      controls.push(element)

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
      lint(attribute(element, 'autocomplete')!.name, 'invalid-autocomplete', `\`${autocomplete}\` is no \`autocomplete\` value`, { note: 'browsers and password managers fill a field from its `autocomplete`, and ignore one they do not know', help: element.name === 'form' ? 'a form takes `on` or `off`' : 'use one of HTML\'s autofill names, such as `email`, `given-name`, `current-password` or `postal-code`' })
  }

  const inside = (element: ElementNode, context: Context): Context => ({
    label: context.label || element.name === 'label',
    component: context.component || element.component,
    hidden: context.hidden || hidden(element),
    removed: context.removed || has(element, 'hidden') || has(element, 'inert'),
    ariaHidden: (context.ariaHidden || staticValue(element, 'aria-hidden') === 'true') && !context.removed && !has(element, 'hidden') && !has(element, 'inert'),
    dialog: context.dialog || element.name === 'dialog',
    control: context.control ?? (!element.component && (element.name === 'button' || (element.name === 'a' && has(element, 'href'))) ? element : undefined),
    branches: context.branches,
    repeated: context.repeated,
  })
  // Each alternative of a block renders on its own, so what one holds never meets what another does.
  const alternatives = (context: Context, count: number, visitOne: (index: number, branch: Context) => void) => {
    const block = blocks++

    for (let index = 0; index < count; index++)
      visitOne(index, { ...context, branches: new Map([...context.branches, [block, index]]) })
  }
  const visit = (nodes: Node[], context: Context) => {
    for (const node of nodes) {
      switch (node.kind) {
        case 'element':
          checkElement(node, context)
          visit(node.children, inside(node, context))

          break
        case 'text':
          for (const part of node.parts) {
            if (part.kind === 'element') {
              checkElement(part, context)
              visit(part.children, inside(part, context))
            }
          }

          break
        case 'slot':
          visit(node.children, { ...context, component: true })

          break
        case 'if': {
          // Each branch is another page: the heading before the block leads each, not the branch shown before it.
          const before = heading

          alternatives(context, node.branches.length, (index, branch) => {
            heading = before
            visit(node.branches[index]!.children, branch)
          })

          break
        }
        case 'for':
          alternatives(context, 2, (index, branch) => visit(index === 0 ? node.children : node.fallback ?? [], { ...branch, repeated: branch.repeated || index === 0 }))

          break
        case 'await': {
          const parts = awaitBlocks(node)

          alternatives(context, parts.length, (index, branch) => visit(parts[index]!, branch))

          break
        }
        case 'try': {
          const parts = tryBlocks(node)

          alternatives(context, parts.length, (index, branch) => visit(parts[index]!, branch))

          break
        }
      }
    }
  }

  visit(file.template, { label: false, component: false, hidden: false, removed: false, ariaHidden: false, dialog: false, branches: new Map(), repeated: false })

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

  checkIds(ids)

  return found

  function checkIds(uses: IdUse[]) {
    const first = new Map<string, IdUse[]>()

    for (const use of uses) {
      if (use.element.component)
        continue

      if (use.repeated) {
        lint(use.element, 'duplicate-id', `The id \`${use.id}\` repeats on every row of its \`for\``, { note: 'an id names one element of the page: a label, a link or a script reaching it gets only the first row\'s', help: `make it unique per row, \`id={\`${use.id}-\${...}\`}\`` })

        continue
      }

      const before = first.get(use.id) ?? []
      const clash = before.find(other => !exclusive(other.branches, use.branches))

      if (clash)
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
