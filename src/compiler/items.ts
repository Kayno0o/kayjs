import type { AwaitNode, ElementNode, ForNode, IfNode, Node, TextExpression, TryNode } from './ast'
import type { CodeBuilder } from './mapping'
import { isHead, isSlot } from './ast'

// The children of an element or a block as the markup holds them: runs of static text, plain elements, and dynamic parts.
// Server markup and browser code both walk this list, so hydration finds a dynamic part where the browser expects it.
export type Item
  = | { kind: 'text', text: string }
    | { kind: 'element', node: ElementNode }
    | { kind: 'expression', node: TextExpression }
    | { kind: 'component', node: ElementNode }
    | { kind: 'slot', node: ElementNode }
    | { kind: 'if', node: IfNode }
    | { kind: 'for', node: ForNode }
    | { kind: 'await', node: AwaitNode }
    | { kind: 'try', node: TryNode }

export type DynamicItem = Exclude<Item, { kind: 'text' | 'element' }>

export function isDynamic(item: Item): item is DynamicItem {
  return item.kind !== 'text' && item.kind !== 'element'
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
      case 'for':
      case 'await':
      case 'try':
        items.push({ kind: node.kind, node } as Item)

        break
      case 'slot':
        continue
    }

    previous = node
  }

  return items
}

// What a `slot` renders: the component's children, or the block prop it names, called with its arguments when it has some.
export function slotValue(b: CodeBuilder, slot: ElementNode): void {
  if (!slot.outlet) {
    b.add('__props.children')

    return
  }

  b.add('__props.').addSource(slot.outlet.name)

  if (slot.outlet.args)
    b.add('?.(').addSource(slot.outlet.args).add(')')
}

// A lone dynamic part of an element owns all of its content, so it needs no markers around it.
export function soleDynamic(items: Item[]): boolean {
  return items.length === 1 && isDynamic(items[0]!)
}
