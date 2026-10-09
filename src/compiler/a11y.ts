import type { Diagnostic, ElementNode, KayFile, NamedAttribute, Node } from './ast'
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

interface Context {
  // Inside a `label`, which names the control it holds.
  label: boolean
  // Inside a component's children, which it may wrap in a label of its own.
  component: boolean
  // Inside an element hidden from screen readers, as a honeypot field is.
  hidden: boolean
}

// What a page needs to be used without seeing it, read off the markup alone: a control with no label, a button or link with nothing to announce, a heading skipping a level.
export function accessibilityLints(file: KayFile): Diagnostic[] {
  const { source } = file
  const found: Diagnostic[] = []
  const labelled = new Set<string>()
  const controls: ElementNode[] = []
  let heading: { level: number, name: string } | undefined
  const text = (span: { start: number, end: number }) => source.slice(span.start, span.end)
  const named = (element: ElementNode) => element.attributes.filter((attribute): attribute is NamedAttribute => attribute.kind !== 'spread')
  const has = (element: ElementNode, name: string) => named(element).some(attribute => text(attribute.name) === name)
  const staticValue = (element: ElementNode, name: string) => {
    const attribute = named(element).find(candidate => text(candidate.name) === name)

    return attribute?.kind === 'static' ? attribute.text : undefined
  }
  const spread = (element: ElementNode) => element.attributes.some(attribute => attribute.kind === 'spread')
  const hidden = (element: ElementNode) => has(element, 'hidden') || staticValue(element, 'aria-hidden') === 'true'
  const at = (element: ElementNode) => element.tag.end > element.tag.start ? element.tag : element

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

  const checkElement = (element: ElementNode, context: Context) => {
    if (element.component || spread(element) || context.hidden || hidden(element))
      return

    if (element.name === 'label') {
      const target = staticValue(element, 'for')

      if (target !== undefined)
        labelled.add(target)
    }

    const level = HEADING.exec(element.name)

    if (level) {
      const current = Number(level[1])

      if (heading && current > heading.level + 1)
        found.push({ ...at(element), code: 'skipped-heading', message: `This \`${element.name}\` follows an \`${heading.name}\`, skipping a level`, note: 'screen reader users move through a page by its headings, and a skipped level reads as a missing section', help: `make it an \`h${heading.level + 1}\`, styled as it should look`, checkOnly: true })

      heading = { level: current, name: element.name }
    }

    const type = staticValue(element, 'type')?.toLowerCase()

    // A placeholder names a field too when nothing else does, as browsers and axe take it, though it is gone once the field holds text.
    if (LABELLED.has(element.name) && !(element.name === 'input' && type !== undefined && UNLABELLED_TYPES.has(type)) && !context.label && !context.component && ![...NAMING, 'placeholder'].some(name => has(element, name)))
      controls.push(element)

    if ((element.name === 'button' || (element.name === 'a' && has(element, 'href'))) && !elementHasContent(element))
      found.push({ ...at(element), code: 'empty-control', message: `This \`${element.name}\` has nothing for a screen reader to announce`, note: 'an icon alone is hidden from screen readers, so the control reads as nameless', help: 'give it text, or name it with `aria-label`', checkOnly: true })
  }

  const inside = (element: ElementNode, context: Context): Context => ({ label: context.label || element.name === 'label', component: context.component || element.component, hidden: context.hidden || hidden(element) })
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

          for (const branch of node.branches) {
            heading = before
            visit(branch.children, context)
          }

          break
        }
        case 'for':
          visit([...node.children, ...node.fallback ?? []], context)

          break
        case 'await':
          for (const block of awaitBlocks(node))
            visit(block, context)

          break
        case 'try':
          for (const block of tryBlocks(node))
            visit(block, context)

          break
      }
    }
  }

  visit(file.template, { label: false, component: false, hidden: false })

  for (const control of controls) {
    const id = control.id ? text(control.id) : staticValue(control, 'id')
    const dynamicId = !control.id && named(control).some(attribute => attribute.kind === 'expression' && text(attribute.name) === 'id')

    // An id written as an expression may be the one a label points at.
    if (dynamicId || (id !== undefined && labelled.has(id)))
      continue

    found.push({ ...at(control), code: 'missing-label', message: `This \`${control.name}\` has no label`, note: 'a screen reader announces a field by its label, and says nothing of what to type in one without', help: id === undefined ? 'wrap it in a `label`, or give it an id a `label(for="...")` points at' : `add \`label(for="${id}")\`, or name it with \`aria-label\``, checkOnly: true })
  }

  return found
}
