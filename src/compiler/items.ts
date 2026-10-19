import type * as t from '@babel/types'
import type { AwaitNode, ConstNode, ElementNode, ErrorNode, ForNode, IfNode, MatchNode, Node, PendingNode, TextExpression, TryNode } from './ast'
import type { CodeBuilder } from './mapping'
import { parseExpression } from '@babel/parser'
import { isHead, isSlot } from './ast'
import { PROPS } from './names'

// The children of an element or a block as the markup holds them: runs of static text, plain elements, and dynamic parts.
// Server markup and browser code both walk this list, so hydration finds a dynamic part where the browser expects it.
export type Item
  = | { kind: 'text', text: string }
    | { kind: 'element', node: ElementNode }
    | { kind: 'expression', node: TextExpression }
    | { kind: 'component', node: ElementNode }
    | { kind: 'slot', node: ElementNode }
    | { kind: 'if', node: IfNode }
    | { kind: 'match', node: MatchNode }
    | { kind: 'for', node: ForNode }
    | { kind: 'await', node: AwaitNode }
    | { kind: 'try', node: TryNode }
    | { kind: 'const', node: ConstNode }
    | { kind: 'error', node: ErrorNode }

export type DynamicItem = Exclude<Item, { kind: 'text' | 'element' | 'const' }>

export function isDynamic(item: Item): item is DynamicItem {
  return item.kind !== 'text' && item.kind !== 'element' && item.kind !== 'const'
}

const pendingElements = new WeakMap<PendingNode, ElementNode>()

// What a `pending` block renders: a status region always in the page, holding the block hidden until the form around it is `aria-busy`, which the runtime sets while it posts. An announcement is made of what shows in a region that was there already, and a blocked stylesheet leaves the block hidden.
function pendingElement(node: PendingNode): ElementNode {
  let found = pendingElements.get(node)

  if (!found) {
    const at = { start: node.start, end: node.end }
    const tag = { start: node.start, end: node.start + 'pending'.length }
    const element = (name: string, children: Node[], fixed?: string): ElementNode => ({ kind: 'element', ...at, tag, name, component: false, classes: [], attributes: [], children, fixed })
    const css = 'form[aria-busy] [data-kay-pending]{display:block}'
    const style = element('style', [{ kind: 'text', ...at, parts: [{ kind: 'chunk', ...at, text: css }] }])

    found = element('div', [element('div', node.children, ' data-kay-pending hidden'), style], ' role="status"')
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
            items.push({ kind: 'expression', node: part })
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
      case 'slot':
        continue
    }

    previous = node
  }

  return items
}

// A template `const` as a statement. `memo`, the helper's name in code that runs again as what it reads changes, makes each name a memo, read by calling it.
export function constDeclaration(b: CodeBuilder, node: ConstNode, src: string, memo: string | undefined): void {
  const names = memo === undefined ? [] : patternNames(src.slice(node.pattern.start, node.pattern.end))

  if (memo === undefined) {
    b.add('const ').addSource(node.pattern).add(' = (').addSource(node.value).add('); ')
  }
  else if (names.length === 1 && src.slice(node.pattern.start, node.pattern.end) === names[0]) {
    b.add('const ').addSource(node.pattern).add(` = ${memo}(() => (`).addSource(node.value).add(')); ')
  }
  else {
    // A destructured value is one memo, each name reading its part.
    const shared = `KayC${node.start}`

    b.add(`const ${shared} = ${memo}(() => { const `).addSource(node.pattern).add(' = (').addSource(node.value).add(`); return [${names.join(', ')}] })`)

    for (const [index, name] of names.entries())
      b.add(`, ${name} = () => ${shared}()[${index}]`)

    b.add('; ')
  }
}

// The names a destructuring pattern declares, in order.
function patternNames(pattern: string): string[] {
  const names: string[] = []
  const visit = (node: t.Node | null) => {
    if (node?.type === 'Identifier') {
      names.push(node.name)
    }
    else if (node?.type === 'ObjectPattern') {
      for (const property of node.properties)
        visit(property.type === 'RestElement' ? property.argument : property.value)
    }
    else if (node?.type === 'ArrayPattern') {
      for (const element of node.elements)
        visit(element)
    }
    else if (node?.type === 'AssignmentPattern') {
      visit(node.left)
    }
    else if (node?.type === 'RestElement') {
      visit(node.argument)
    }
  }

  try {
    const fn = parseExpression(`(${pattern}) => 0`, { plugins: ['typescript'] })

    if (fn.type === 'ArrowFunctionExpression')
      visit(fn.params[0]!)
  }
  catch {}

  return names
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
  const rendered = items.filter(item => item.kind !== 'const')

  return rendered.length === 1 && isDynamic(rendered[0]!)
}
