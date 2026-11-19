import type { AwaitNode, ConstNode, ElementNode, ErrorNode, ForNode, IfNode, MatchNode, Node, PendingNode, SnippetNode, Span, TextExpression, TryNode } from './ast'
import type { CodeBuilder } from './mapping'
import type { Sites } from './rewrite-types'
import { isHead, isSlot, keyedByPosition } from './ast'
import { PROPS } from './names'
import { parsedBindingNames } from './pattern-names'

// The children of an element or a block as the markup holds them: runs of static text, plain elements, and dynamic parts.
// Server markup and browser code both walk this list, so hydration finds a dynamic part where the browser expects it.
export type Item
  = | { kind: 'text', text: string }
    | { kind: 'element', node: ElementNode }
    | { kind: 'expression', node: TextExpression, line: Node }
    | { kind: 'component', node: ElementNode }
    | { kind: 'slot', node: ElementNode }
    | { kind: 'if', node: IfNode }
    | { kind: 'match', node: MatchNode }
    | { kind: 'for', node: ForNode }
    | { kind: 'await', node: AwaitNode }
    | { kind: 'try', node: TryNode }
    | { kind: 'const', node: ConstNode }
    | { kind: 'snippet', node: SnippetNode }
    | { kind: 'error', node: ErrorNode }

export type Declaration = Extract<Item, { kind: 'const' | 'snippet' }>

export type DynamicItem = Exclude<Item, { kind: 'text' | 'element' } | Declaration>

// A `const` or a `snippet`, which renders nothing and names a value for the items after it.
export function isDeclaration(item: Item): item is Declaration {
  return item.kind === 'const' || item.kind === 'snippet'
}

export function isDynamic(item: Item): item is DynamicItem {
  return item.kind !== 'text' && item.kind !== 'element' && !isDeclaration(item)
}

const pendingElements = new WeakMap<PendingNode, ElementNode>()

// What a `pending` block renders: a `slot` laying out as its contents do, hidden until the runtime shows it while the form around it posts or its action has a call in flight. No style rule is involved, so a strict `style-src` leaves it working, and the runtime announces its text from outside the form, whose `aria-busy` may hold back a region inside it.
function pendingElement(node: PendingNode): ElementNode {
  let found = pendingElements.get(node)

  if (!found) {
    const at = { start: node.start, end: node.end }
    const tag = { start: node.start, end: node.start + 'pending'.length }

    found = { kind: 'element', ...at, tag, name: 'slot', component: false, classes: [], attributes: [], children: node.children, fixed: ' data-kay-pending hidden', pendingOf: node }
    pendingElements.set(node, found)
  }

  return found
}

// Consecutive text lines join with a line break; a `head` block and `@slot` blocks render elsewhere, so they hold no place here.
export function childItems(nodes: Node[]): Item[] {
  const items: Item[] = []
  let previous: Node | undefined

  const text = (value: string) => {
    const last = items.at(-1)

    if (last?.kind === 'text')
      last.text += value
    else
      items.push({ kind: 'text', text: value })
  }

  const element = (node: ElementNode) => {
    if (isHead(node))
      return

    if (isSlot(node))
      items.push({ kind: 'slot', node })
    else if (node.component)
      items.push({ kind: 'component', node })
    else
      items.push({ kind: 'element', node })
  }

  for (const node of nodes) {
    switch (node.kind) {
      case 'element':
        element(node)

        break
      case 'text':
        if (previous?.kind === 'text')
          text('\n')

        for (const part of node.parts) {
          if (part.kind === 'element')
            element(part)
          else if (part.kind === 'expression')
            items.push({ kind: 'expression', node: part, line: node })
          else if (part.text !== '')
            text(part.text)
        }

        break
      case 'if':
      case 'match':
      case 'for':
      case 'await':
      case 'try':
      case 'error':
        items.push({ kind: node.kind, node } as Item)

        break
      case 'pending':
        items.push({ kind: 'element', node: pendingElement(node) })

        break
      case 'const':
        items.push({ kind: 'const', node })

        continue
      case 'snippet':
        items.push({ kind: 'snippet', node })

        continue
      case 'slot':
        continue
    }

    previous = node
  }

  return items
}

// The value a `const` names: its expression, or the row of the loop whose destructured item it declares, which a browser's loop and an island's server render hand over as an accessor (the `memo` of a block that follows what it reads).
export function addConstValue(b: CodeBuilder, node: ConstNode, accessor = false): void {
  if (node.row === undefined)
    b.addSource(node.value)
  else
    b.add(accessor ? `${node.row}()` : node.row)
}

// A template `const` as a statement. `memo`, the helper's name in code that runs again as what it reads changes, makes each name a memo, read by calling it.
export function constDeclaration(b: CodeBuilder, node: ConstNode, src: string, memo: string | undefined): void {
  const names = memo === undefined ? [] : parameterNames(src.slice(node.pattern.start, node.pattern.end))

  if (memo === undefined) {
    b.add('const ').addSource(node.pattern).add(' = (')
    addConstValue(b, node, memo !== undefined)
    b.add('); ')
  }
  else if (names.length === 1 && src.slice(node.pattern.start, node.pattern.end) === names[0]) {
    b.add('const ').addSource(node.pattern).add(` = ${memo}(() => (`)
    addConstValue(b, node, memo !== undefined)
    b.add(')); ')
  }
  else {
    // A destructured value is one memo, each name reading its part.
    const shared = `KayC${node.start}`

    b.add(`const ${shared} = ${memo}(() => { const `).addSource(node.pattern).add(' = (')
    addConstValue(b, node, memo !== undefined)
    b.add(`); return [${names.join(', ')}] })`)

    for (const [index, name] of names.entries())
      b.add(`, ${name} = () => ${shared}()[${index}]`)

    b.add('; ')
  }
}

// The names a destructuring pattern or a parameter list declares, in order.
export function parameterNames(pattern: string): string[] {
  return parsedBindingNames(pattern) ?? []
}

const PLAIN_PARAMETER = /^([\p{ID_Start}$_][\p{ID_Continue}$]*)(?:\s*\?)?\s*(?::|$)/u
const OPENING = '([{<'
const CLOSING = ')]}>'
const QUOTES = '"\'`'

function skipString(text: string, from: number): number {
  const quote = text[from]!
  let index = from + 1

  while (index < text.length && text[index] !== quote)
    index += text[index] === '\\' ? 2 : 1

  return index
}

// The parameters of a block or a snippet that are plain names, typed or not, with their place in the list, which one of a component that renders again reads through an accessor, so a caller handing it what a `followed` draw follows gets the current value read each time. A pattern, a rest or a default stays as written. None when the list has no such name.
export function accessorParameters(params: string): { name: string, position: number }[] | undefined {
  const names: { name: string, position: number }[] = []
  let depth = 0
  let from = 0
  let defaulted = false
  let position = 0

  const close = (to: number) => {
    const name = defaulted ? undefined : PLAIN_PARAMETER.exec(params.slice(from, to).trim())?.[1]

    if (name !== undefined)
      names.push({ name, position })

    position++

    from = to + 1
    defaulted = false
  }

  for (let index = 0; index < params.length; index++) {
    const char = params[index]!

    if (char === '=' && params[index + 1] === '>') {
      index++
    }
    else if (QUOTES.includes(char)) {
      // A string in a type or a default, whose commas and brackets are no part of the list.
      index = skipString(params, index)
    }
    else if (OPENING.includes(char)) {
      depth++
    }
    else if (CLOSING.includes(char)) {
      depth--
    }
    else if (char === ',' && depth === 0) {
      close(index)
    }
    else if (char === '=' && depth === 0) {
      defaulted = true
    }
  }

  close(params.length)

  return depth === 0 && names.length > 0 ? names : undefined
}

const CHAIN = String.raw`[\p{ID_Start}$_][\p{ID_Continue}$]*(?:\.[\p{ID_Start}$_][\p{ID_Continue}$]*)*`
const CHAINS = new RegExp(String.raw`^\s*${CHAIN}(?:\s*,\s*${CHAIN})*\s*$`, 'u')
const COMMA = /,/g

// The spans of the arguments of a `slot` call when each is a name or a path of names, which the runtime reads one by one: the first as the item the block follows, the others where they change. None for any other argument.
function simpleArguments(src: string, args: Span): Span[] | undefined {
  const text = src.slice(args.start, args.end)

  if (!CHAINS.test(text))
    return undefined

  const spans: Span[] = []
  let from = 0

  for (const cut of [...[...text.matchAll(COMMA)].map(match => match.index), text.length]) {
    const piece = text.slice(from, cut)
    const lead = piece.length - piece.trimStart().length

    spans.push({ start: args.start + from + lead, end: args.start + from + piece.trimEnd().length })
    from = cut + 1
  }

  return spans
}

// A `slot` called with names or paths, which draws its block once for the item under its key, so a replacement leaves its nodes and their focus. False, and nothing written, for any other call.
export function addSlotCall(b: CodeBuilder, src: string, slot: ElementNode, helper: string): boolean {
  const spans = slot.outlet?.args && simpleArguments(src, slot.outlet.args)

  if (!slot.outlet || !spans)
    return false

  b.add(`${helper}(${PROPS}.`).addSource(slot.outlet.name)

  for (const span of spans)
    b.add(', () => ').addSource(span)

  b.add(')')

  return true
}

// The parameters of a block or a snippet about to be written, which the rewrite reads through accessors where a component renders again.
export function markBlock(sites: Sites, b: CodeBuilder, src: string, params: Span, staticLoops?: boolean): void {
  if (!staticLoops && accessorParameters(src.slice(params.start, params.end)))
    sites.blocks.add(b.code.length)
}

const BARE_PARAMETER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u

// A block's parameters and its arrow: one plain name is written bare, so a rule about the parentheses around it, which kay would otherwise be the one to write, has none to report.
export function addBlockParameters(sites: Sites, b: CodeBuilder, src: string, params: Span, staticLoops?: boolean): void {
  const bare = BARE_PARAMETER.test(src.slice(params.start, params.end))

  b.add(bare ? '' : '(')
  markBlock(sites, b, src, params, staticLoops)
  b.addSource(params).add(bare ? ' => ' : ') => ')
}

// What a block or a snippet renders, its plain parameters read where they are used (`param` is the helper), so one a `followed` draw follows gives the current item.
export function addParameterReads(b: CodeBuilder, names: { name: string, position: number }[] | undefined, param: string, render: () => void): void {
  if (names)
    b.add(`(${names.map(({ name, position }) => `${name} = ${param}(${name}${position === 0 ? '' : `, ${position}`}), `).join('')}`)

  render()

  if (names)
    b.add(')')
}

// What a `slot` renders: the component's children, or the block prop it names, called with its arguments when it has some.
export function slotValue(b: CodeBuilder, slot: ElementNode): void {
  if (!slot.outlet) {
    b.add(`${PROPS}.children`)

    return
  }

  b.add(`${PROPS}.`).addSource(slot.outlet.name)

  if (slot.outlet.args)
    b.add('?.(').addSource(slot.outlet.args).add(')')
}

// The arguments of the `errorParagraph` an `error` line renders, past the message: its id, none in a loop, and its classes.
export function errorParagraphArguments(node: ErrorNode, src: string, id: string | undefined): string {
  return `${JSON.stringify(id ?? '')}, ${JSON.stringify(['error', ...node.classes.map(span => src.slice(span.start, span.end))].join(' '))}`
}

// A lone dynamic part of an element owns all of its content, so it needs no markers around it.
export function soleDynamic(items: Item[]): boolean {
  const rendered = items.filter(item => !isDeclaration(item))

  return rendered.length === 1 && isDynamic(rendered[0]!)
}

// How a loop matches its rows to their elements, decided once for every target: by position when its `key` names the index, by the `key` expression, else by the row itself (the browser's `rowKey`, a type check's constant).
export type RowKeying
  = | { kind: 'positional', key: Span }
    | { kind: 'expression', key: Span }
    | { kind: 'implicit' }

export function rowKeying(node: ForNode, src: string): RowKeying {
  if (keyedByPosition(node, src))
    return { kind: 'positional', key: node.key }

  return node.key ? { kind: 'expression', key: node.key } : { kind: 'implicit' }
}

// An element's content: its children but the slots, which fill a component's blocks and are no markup of the element.
export function contentOf(element: ElementNode): Node[] {
  return element.children.filter(child => child.kind !== 'slot')
}

// The parameters of a loop's key function: the item as the block takes it, then the index when the key reads it, which the browser's key function is handed as the row's place in the list. An index the key leaves alone is no parameter, so none is reported unread.
export function addKeyParameters(b: CodeBuilder, node: ForNode, src: string): void {
  b.add('(').addSource(node.item)

  if (node.index && node.key && readsName(src.slice(node.key.start, node.key.end), src.slice(node.index.start, node.index.end)))
    b.add(', ').addSource(node.index)

  b.add(')')
}

// What follows the fallback in the server's `loop` call: how an island's rows read their item, or, in a page or a static component, the key of a keyed loop (`rowKey` when it names none), which an island in a row with no `key` or `id` of its own takes its identity from.
export function addLoopTail(b: CodeBuilder, node: ForNode, src: string, accessorLoops: boolean, rowKey: string): void {
  const keying = rowKeying(node, src)
  const keyed = !accessorLoops && keying.kind !== 'positional'

  if (!node.fallback && (accessorLoops || keyed))
    b.add(', undefined')

  if (accessorLoops)
    b.add(keying.kind === 'positional' ? ', "positional"' : ', "keyed"')
  else if (keyed)
    b.add(', undefined')

  if (!keyed)
    return

  b.add(', ')

  if (keying.kind === 'expression') {
    addKeyParameters(b, node, src)
    b.add(' => (').addSource(keying.key).add(')')
  }
  else {
    b.add(rowKey)
  }
}

// Whether an expression names `name` as a variable: not as a property after a dot, nor inside a longer name.
function readsName(expression: string, name: string): boolean {
  return new RegExp(`(?<![\\w$.])${name.replaceAll('$', '\\$')}(?![\\w$])`).test(expression)
}

// The parameter a loop's block takes for its row: the item as written, or the row's own name when the item is a pattern.
export function addRowItem(b: CodeBuilder, node: ForNode): void {
  if (node.row === undefined)
    b.addSource(node.item)
  else
    b.add(node.row)
}

// The attributes the compiler fixes on an element, its scope's among them, as a props object of no values to follow a spread's sources, so none can drop them; empty when there are none.
export function fixedSource(element: ElementNode): string {
  const names = (element.fixed ?? '').split(' ').filter(name => name !== '')

  return names.length === 0 ? '' : `, { ${names.map(name => `${JSON.stringify(name)}: ""`).join(', ')} }`
}

// What an `error` or `pending` line outside every form of its file reads: the form it renders in, and the message the action gave a field; in the browser a snippet called in a form is built in that form's scope; the import drops a repeat.
export function ambientHelpers(facts: { ambientForm: boolean, snippet: boolean, forms: ReadonlyMap<unknown, unknown> }, mode: string): ('formHere' | 'formError' | 'issueScope')[] {
  return [...facts.ambientForm ? ['formHere' as const, 'formError' as const] : [], ...mode === 'dom' && facts.snippet && facts.forms.size > 0 ? ['issueScope' as const] : []]
}

const BOUND = /^bind:/

// The props a use writes, as the object type `KayFunctionProp` takes after the component; none for a use with a spread, which may carry any.
export function usedProps(element: ElementNode, text: (span: Span) => string): string {
  if (element.attributes.some(attribute => attribute.kind === 'spread'))
    return ''

  const names = [...element.attributes.flatMap(attribute => attribute.kind === 'spread' ? [] : [attribute.name]), ...element.children.flatMap(child => child.kind === 'slot' ? [child.name] : [])]

  return `, { ${names.map(name => `${JSON.stringify(text(name).replace(BOUND, ''))}: 0`).join(', ')} }`
}
