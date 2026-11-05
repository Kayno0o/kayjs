import type { Diagnostic, ElementNode, KayFile, Node } from './ast'
import { walkNodes } from './ast'

// Elements whose start tag closes a `p` open in button scope, so `p > div` reaches the browser as a closed `p` and a `div` after it.
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'center', 'details', 'dd', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'table', 'ul'])
// What a search for an open `p`, `form` or `select` stops at: the parser looks no further up through these.
const SCOPE_BOUNDARY = new Set(['button', 'caption', 'td', 'th', 'object', 'marquee', 'applet', 'svg', 'math', 'template'])
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const LISTS = new Set(['ul', 'ol', 'menu'])
const ROW_GROUPS = new Set(['thead', 'tbody', 'tfoot'])
const LIST_CONTENT = new Set(['li', 'script', 'template'])

// The HTML elements above a node up to the nearest thing that may render anywhere: a component, a slot, a snippet or a `pending` block, where the chain restarts and nothing is judged against what is unknown.
type Chain = readonly ElementNode[]

// Markup the HTML parser rewrites or drops, so the server's HTML and the DOM an island builds differ: reported only where every element up to the nearest component or slot is in view.
export function nestingLints(file: KayFile): Diagnostic[] {
  const found: Diagnostic[] = []

  walkNodes<Chain>(file.template, [], (node: Node, chain) => {
    if (node.kind === 'slot' || node.kind === 'snippet' || node.kind === 'pending')
      return []

    if (node.kind !== 'element')
      return chain

    if (node.component || node.outlet || node.fills || node.name === 'template' || node.name === 'slot')
      return []

    nestingOf(node, chain, found)

    return [...chain, node]
  })

  return found
}

function nestingOf(element: ElementNode, chain: Chain, found: Diagnostic[]) {
  const { name } = element
  const parent = chain.at(-1)
  const report = (message: string, note: string, help: string, around?: ElementNode) => {
    found.push({ ...element.tag.end > element.tag.start ? element.tag : element, code: 'invalid-nesting', message, note, help, ...around ? { related: [{ start: around.tag.start, end: around.tag.end, label: 'the element it sits in' }] } : {}, checkOnly: true })
  }
  // The nearest open `ancestor`, none past a scope boundary, and none past a block that already closed any `p` above it.
  const within = (ancestor: string) => {
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i]!.name === ancestor)
        return chain[i]

      if (SCOPE_BOUNDARY.has(chain[i]!.name) || (ancestor === 'p' && CLOSES_P.has(chain[i]!.name)))
        return undefined
    }

    return undefined
  }

  const paragraph = CLOSES_P.has(name) ? within('p') : undefined

  if (paragraph) {
    report(`This \`${name}\` sits inside a \`p\``, 'the browser closes the `p` where a block starts, so the server\'s HTML and the DOM an island builds differ', `make the \`p\` a \`div\`, or put the \`${name}\` beside it`, paragraph)

    return
  }

  if (name === 'form' || name === 'select') {
    const outer = within(name)

    if (outer) {
      report(`This \`${name}\` sits inside another \`${name}\``, `the browser drops the inner \`${name}\`'s tag, so its fields join the outer one`, `move the inner \`${name}\` out, beside the other`, outer)

      return
    }
  }

  if (!parent)
    return

  if (name === 'li' && !LISTS.has(parent.name))
    report(`This \`li\` sits inside a \`${parent.name}\`, not a list`, 'a list item belongs in a `ul`, an `ol` or a `menu`, and a screen reader announces it as a list item of no list', 'wrap the items in a `ul` or an `ol`')
  else if (LISTS.has(parent.name) && !LIST_CONTENT.has(name))
    report(`This \`${name}\` sits directly inside a \`${parent.name}\``, 'a list holds `li` elements only, and a screen reader counts anything else as outside the list', `wrap it in an \`li\`, or make the \`${parent.name}\` a \`div\``, parent)
  else if (HEADINGS.has(name) && HEADINGS.has(parent.name))
    report(`This \`${name}\` sits inside a \`${parent.name}\``, 'the browser closes the outer heading where the inner one starts', 'put them side by side', parent)
  else
    tablePart(name, parent, report)

  if (name === 'option' && !['select', 'optgroup', 'datalist'].includes(parent.name))
    report(`This \`option\` sits inside a \`${parent.name}\``, 'the browser drops an `option` outside a `select`, an `optgroup` or a `datalist`', 'put it in a `select`', parent)
  else if (name === 'optgroup' && parent.name !== 'select')
    report(`This \`optgroup\` sits inside a \`${parent.name}\``, 'the browser drops an `optgroup` outside a `select`', 'put it in a `select`', parent)
}

function tablePart(name: string, parent: ElementNode, report: (message: string, note: string, help: string, around?: ElementNode) => void) {
  if (name === 'tr' && parent.name === 'table')
    report('This `tr` sits directly inside a `table`', 'the browser wraps it in a `tbody` an island never creates, so the server\'s HTML and the DOM differ', 'wrap the rows in a `tbody`, a `thead` or a `tfoot`', parent)
  else if (name === 'tr' && !ROW_GROUPS.has(parent.name))
    report(`This \`tr\` sits inside a \`${parent.name}\``, 'the browser drops a row outside a table', 'put it in a `table`', parent)
  else if ((name === 'td' || name === 'th') && parent.name !== 'tr')
    report(`This \`${name}\` sits inside a \`${parent.name}\``, 'the browser drops a cell outside a row, or wraps it in a `tr` an island never creates', 'put it in a `tr`', parent)
  else if ((ROW_GROUPS.has(name) || name === 'caption' || name === 'colgroup') && parent.name !== 'table')
    report(`This \`${name}\` sits inside a \`${parent.name}\``, 'the browser drops a table part outside a table', 'put it in a `table`', parent)
}
