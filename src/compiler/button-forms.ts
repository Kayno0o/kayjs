import type { ElementNode, KayFile, Node } from './ast'
import { childBlocks, componentAction } from './ast'

// A form that takes no box of its own, so the button inside it sits in its row as it would without the form.
const WRAPPER = ' style="display:contents"'

// `button(action={move.with({ id })})` outside any form is a form of its own, `form(action={...}) button`, which posts with or without JavaScript, from a page or an island: the `action` moves to a `form` around the button. One inside a form stays as written, which the validator refuses.
export function wrapActionButtons(file: KayFile): void {
  wrap(file.template, file.source, false)
}

function wrap(nodes: Node[], source: string, inForm: boolean): void {
  for (const [index, node] of nodes.entries()) {
    if (node.kind === 'element' && !inForm && !node.component && node.name === 'button') {
      const at = node.attributes.findIndex(attribute => attribute.kind === 'expression' && source.slice(attribute.name.start, attribute.name.end) === 'action')

      if (at >= 0) {
        const form: ElementNode = { kind: 'element', start: node.start, end: node.end, tag: { start: node.start, end: node.start }, name: 'form', component: false, classes: [], attributes: node.attributes.splice(at, 1), children: [node], fixed: WRAPPER }

        nodes[index] = form
      }
    }

    const forms = node.kind === 'element' && (node.component ? componentAction(node, source) !== undefined : node.name === 'form')

    for (const block of childBlocks(node))
      wrap(block, source, inForm || forms)
  }
}
