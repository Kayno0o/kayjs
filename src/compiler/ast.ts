// Offsets index into the whole .kay source, so every node maps back to the file the user wrote.
export interface Span {
  start: number
  end: number
}

export interface Diagnostic extends Span {
  // What is wrong, short; what to do about it goes in `help`.
  message: string
  // Printed under the span, when the message alone does not say what this part of the line is.
  label?: string
  // The other places the problem involves, each labelled with its part in it.
  related?: Labelled[]
  // Why it is a problem, when the message does not say.
  note?: string
  // What to write instead.
  help?: string
  // A lint's name, which `kay.config.ts` and a `// kay-allow` comment set the level of; a compile error has none.
  code?: string
  // A lint at the `warn` level is a warning, reported without failing; anything else is an error.
  severity?: 'error' | 'warning'
  // What the editor offers to fix it with.
  fixes?: Fix[]
  // Reported by type checking only: the code generated around it is whole, so the file's type errors still count.
  checkOnly?: boolean
}

export interface Labelled extends Span {
  label: string
}

// What a diagnostic says besides its message and span.
export type Details = Pick<Diagnostic, 'label' | 'related' | 'note' | 'help' | 'fixes'>

// Edits to the `.kay` source, by offset into it.
export interface Fix {
  title: string
  edits: (Span & { text: string })[]
  // It changes nothing the code means besides the problem it fixes, so `kay check --fix` applies it unasked.
  safe?: boolean
}

export type Attribute
  = | { kind: 'static', name: Span, value: Span, text: string }
    | { kind: 'expression', name: Span, expression: Span }
    | { kind: 'boolean', name: Span }
    | { kind: 'spread', expression: Span }

export interface ElementNode extends Span {
  kind: 'element'
  tag: Span
  name: string
  component: boolean
  classes: Span[]
  id?: Span
  attributes: Attribute[]
  // The `(...)` holding the attributes, brackets included.
  parens?: Span
  children: Node[]
}

export interface TextChunk extends Span {
  kind: 'chunk'
  text: string
}

export interface TextExpression extends Span {
  kind: 'expression'
  expression: Span
}

export interface TextNode extends Span {
  kind: 'text'
  parts: (TextChunk | TextExpression | ElementNode)[]
}

export interface IfBranch extends Span {
  test?: Span
  alias?: Span
  children: Node[]
}

export interface IfNode extends Span {
  kind: 'if'
  branches: IfBranch[]
}

export interface ForNode extends Span {
  kind: 'for'
  item: Span
  index?: Span
  each: Span
  // Without one, rows are matched by the item's `id`, else by the item itself.
  key?: Span
  children: Node[]
  fallback?: Node[]
}

export interface SlotNode extends Span {
  kind: 'slot'
  name: Span
  // Inside the brackets of `@row(todo)`: the block is then a function of these parameters.
  params?: Span
  children: Node[]
}

export interface AwaitBranch extends Span {
  alias?: Span
  children: Node[]
}

// `await value`, its pending block, then `then name` and `catch error` at the same indentation; `await value then name` has no pending block.
export interface AwaitNode extends Span {
  kind: 'await'
  value: Span
  pending: Node[]
  resolved?: AwaitBranch
  rejected?: AwaitBranch
}

// `try` and its block, then `catch error` at the same indentation: what renders instead once the block throws.
export interface TryNode extends Span {
  kind: 'try'
  children: Node[]
  rejected?: AwaitBranch
}

export type Node = ElementNode | TextNode | IfNode | ForNode | AwaitNode | TryNode | SlotNode

// An attribute written with a name, which a spread is not.
export type NamedAttribute = Exclude<Attribute, { kind: 'spread' }>

// `form(action={add})`: the attribute naming the action a form posts to.
export function actionOf(element: ElementNode, source: string): Extract<Attribute, { kind: 'expression' }> | undefined {
  if (element.component || element.name !== 'form')
    return undefined

  const attribute = element.attributes.find(candidate => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === 'action')

  return attribute?.kind === 'expression' ? attribute : undefined
}

// A field of a form posting to an action: what a refused post fills back in, and whether it can be marked invalid.
export interface FormField {
  name: string
  fill?: 'value' | 'checked' | 'content' | 'selected'
  invalid: boolean
}

const FIELD_ELEMENTS = new Set(['input', 'textarea', 'select'])
// A password or a file is never sent back; the others post no text the visitor typed.
const UNFILLED_TYPES = new Set(['password', 'file', 'hidden', 'submit', 'button', 'reset', 'image'])
const UNCHECKED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image'])

// Only an element whose name and type are written out: the compiler then knows which field it is and how it shows its value.
export function formFieldOf(element: ElementNode, source: string): FormField | undefined {
  if (element.component || !FIELD_ELEMENTS.has(element.name) || element.attributes.some(attribute => attribute.kind === 'spread'))
    return undefined

  const attributes = new Map((element.attributes as NamedAttribute[]).map(attribute => [source.slice(attribute.name.start, attribute.name.end), attribute]))
  const name = attributes.get('name')
  const type = attributes.get('type')

  if (name?.kind !== 'static' || (type !== undefined && type.kind !== 'static'))
    return undefined

  const bound = [...attributes.keys()].some(attribute => attribute.startsWith('bind:'))
  const inputType = type?.text.toLowerCase() ?? 'text'
  const field: FormField = { name: name.text, invalid: !attributes.has('aria-invalid') && (element.name !== 'input' || !UNCHECKED_TYPES.has(inputType)) }

  // A disabled field posts nothing, so it would come back empty or unticked.
  if (bound || attributes.has('disabled'))
    return field

  if (element.name === 'textarea')
    field.fill = 'content'
  else if (element.name === 'select')
    field.fill = attributes.has('multiple') ? undefined : 'selected'
  else if (inputType === 'checkbox' || inputType === 'radio')
    field.fill = 'checked'
  else if (!UNFILLED_TYPES.has(inputType))
    field.fill = 'value'

  return field
}

// The elements showing an action's errors, and the id each field, or the form for its own message, is described by while refused.
export interface ErrorMessages {
  // Generated ids, for elements with none of their own.
  ids: Map<ElementNode, string>
  // Keyed by `errorKey`.
  describing: Map<string, string>
}

const ERROR_READ = /^([\w$.]+)\.error\((?:(['"])([^'"]*)\2)?\)$/
const WHITESPACE = /\s+/g
const ID_UNSAFE = /[^\w-]+/g

function errorKey(action: string, field: string): string {
  return `${action.replace(WHITESPACE, '')}\n${field}`
}

// `if add.error('title') as message` and `p {add.error('title')}`: the element shown holds the message, outside a `for`, which would repeat its id, for an action a form of the file posts to.
export function errorMessages(nodes: Node[], source: string): ErrorMessages {
  const found: ErrorMessages = { ids: new Map(), describing: new Map() }
  const posted = new Set<string>()
  const shown: { element: ElementNode, action: string, field: string }[] = []
  const text = (span: Span) => source.slice(span.start, span.end)

  const shows = (element: ElementNode | undefined, span: Span, loop: boolean) => {
    const match = ERROR_READ.exec(text(span).replace(WHITESPACE, ''))

    if (element && match && !loop && !element.component && !element.attributes.some(attribute => attribute.kind === 'spread'))
      shown.push({ element, action: match[1]!, field: match[3] ?? '' })
  }

  const visit = (children: Node[], loop: boolean) => {
    for (const node of children) {
      switch (node.kind) {
        case 'element': {
          const action = actionOf(node, source)

          if (action)
            posted.add(text(action.expression).replace(WHITESPACE, ''))

          for (const child of node.children) {
            if (child.kind === 'text') {
              for (const part of child.parts) {
                if (part.kind === 'expression')
                  shows(node, part.expression, loop)
              }
            }
          }

          visit(node.children, loop)

          break
        }
        case 'if':
          for (const branch of node.branches) {
            if (branch.test)
              shows(branch.children.find((child): child is ElementNode => child.kind === 'element'), branch.test, loop)

            visit(branch.children, loop)
          }

          break
        case 'for':
          visit([...node.children, ...node.fallback ?? []], true)

          break
        case 'await':
          for (const block of awaitBlocks(node))
            visit(block, loop)

          break
        case 'try':
          for (const block of tryBlocks(node))
            visit(block, loop)

          break
        case 'slot':
          visit(node.children, loop)

          break
        case 'text':
          break
      }
    }
  }

  visit(nodes, false)

  for (const { element, action, field } of shown) {
    const key = errorKey(action, field)
    const own = element.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && text(attribute.name) === 'id')

    if (!posted.has(action) || found.describing.has(key) || (own !== undefined && own.kind !== 'static'))
      continue

    let id = element.id ? text(element.id) : own?.text

    if (id === undefined) {
      id = `${action.replaceAll('.', '-')}-${field ? `${field.replace(ID_UNSAFE, '-')}-` : ''}error`
      found.ids.set(element, id)
    }

    found.describing.set(key, id)
  }

  return found
}

// What `aria-describedby` reads while a field, or the form for `''`, is refused, and what it reads otherwise: the error's id after the template's own static value, which then renders through this alone; nothing for a value the template binds.
export function describedByOf(element: ElementNode, source: string, errors: ErrorMessages | undefined, action: Span, field: string): { refused: string, own?: string } | undefined {
  const id = errors?.describing.get(errorKey(source.slice(action.start, action.end), field))
  const own = element.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === 'aria-describedby')

  if (id === undefined || (own !== undefined && own.kind !== 'static'))
    return undefined

  return own ? { refused: `${own.text} ${id}`, own: own.text } : { refused: id }
}

export function isHead(node: Node): node is ElementNode & { name: 'head' } {
  return node.kind === 'element' && !node.component && node.name === 'head'
}

// `slot` renders the children a layout or wrapper component receives, like Astro's `<slot />`.
export function isChildrenSlot(node: Node): boolean {
  return node.kind === 'element' && node.name === 'slot' && !node.component
}

// The pending, resolved and failed blocks, in source order.
export function awaitBlocks(node: AwaitNode): Node[][] {
  return [node.pending, node.resolved?.children ?? [], node.rejected?.children ?? []]
}

// The block and its `catch` block, in source order.
export function tryBlocks(node: TryNode): Node[][] {
  return [node.children, node.rejected?.children ?? []]
}

export interface KayFile {
  source: string
  script?: Span
  server?: Span
  // Inside the angle brackets of `--- <T extends Row>`: the component function's type parameters.
  typeParameters?: Span
  // The `client` of `--- client`: the component renders in the browser only.
  client?: Span
  // Where the template begins, past the fences.
  templateStart: number
  template: Node[]
  diagnostics: Diagnostic[]
}

// `Home.size-5`, with `Home` an icon `~icons/...` imports: the `svg` spreading it, as `svg({...Home} class="size-5")` would be written.
export function drawIcons(nodes: Node[], icons: ReadonlySet<string>): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'element':
        if (node.component && icons.has(node.name)) {
          node.attributes.unshift({ kind: 'spread', expression: node.tag })
          node.name = 'svg'
          node.component = false
          node.tag = { start: node.tag.start, end: node.tag.start }
        }

        drawIcons(node.children, icons)

        break
      case 'text':
        drawIcons(node.parts.filter(part => part.kind === 'element'), icons)

        break
      case 'slot':
        drawIcons(node.children, icons)

        break
      case 'if':
        drawIcons(node.branches.flatMap(branch => branch.children), icons)

        break
      case 'for':
        drawIcons([...node.children, ...node.fallback ?? []], icons)

        break
      case 'await':
        drawIcons(awaitBlocks(node).flat(), icons)

        break
      case 'try':
        drawIcons(tryBlocks(node).flat(), icons)

        break
    }
  }
}
