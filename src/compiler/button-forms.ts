import type { ElementNode, KayFile, Node } from './ast'
import { BUTTON_FORM_ATTRIBUTE } from '../runtime/button-form'
import { childBlocks, componentAction } from './ast'

// The form takes no box of its own, which the page's rule for the attribute sets, so the button inside it sits in its row as it would without the form, under a CSP with no inline style attributes.
const WRAPPER = ` ${BUTTON_FORM_ATTRIBUTE}`

// `button(action={move.with({ id })})` outside any form is a form of its own, `form(action={...}) button`, which posts with or without JavaScript, from a page or an island: the `action` moves to a `form` around the button. One inside a form stays as written, which the validator refuses.
export function wrapActionButtons(file: KayFile): void {
  wrap(file, file.template, false)
}

function wrap(file: KayFile, nodes: Node[], inForm: boolean): void {
  const { source } = file

  for (const [index, node] of nodes.entries()) {
    if (node.kind === 'element' && !inForm && !node.component && node.name === 'button') {
      const at = node.attributes.findIndex(attribute => attribute.kind === 'expression' && source.slice(attribute.name.start, attribute.name.end) === 'action')

      if (at >= 0) {
        const form: ElementNode = { kind: 'element', start: node.start, end: node.end, tag: { start: node.start, end: node.start }, name: 'form', component: false, classes: [], attributes: node.attributes.splice(at, 1), children: [node], fixed: WRAPPER }

        nodes[index] = form
        file.wrapsButtons = true
      }
    }

    const forms = node.kind === 'element' && (node.component ? componentAction(node, source) !== undefined : node.name === 'form')

    for (const block of childBlocks(node))
      wrap(file, block, inForm || forms)
  }
}
