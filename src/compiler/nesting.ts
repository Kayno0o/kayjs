import type { Diagnostic, ElementNode, KayFile, Node } from './ast'
import { walkNodes } from './ast'

// Elements whose start tag closes a `p` open in button scope, so `p > div` reaches the browser as a closed `p` and a `div` after it; `markdown` renders blocks.
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dd', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'listing', 'main', 'markdown', 'menu', 'nav', 'ol', 'p', 'plaintext', 'pre', 'search', 'section', 'summary', 'table', 'ul', 'xmp'])
// What a search for an open `p`, `form` or `select` stops at: the parser looks no further up through these.
const SCOPE_BOUNDARY = new Set(['button', 'caption', 'td', 'th', 'object', 'marquee', 'applet', 'svg', 'math', 'template'])
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const LISTS = new Set(['ul', 'ol', 'menu'])
const ROW_GROUPS = new Set(['thead', 'tbody', 'tfoot'])
const LIST_CONTENT = new Set(['li', 'script', 'template', 'markdown'])
const OPTION_HOSTS = new Set(['select', 'datalist'])

// The HTML elements above a node up to the nearest thing that may render anywhere: a component, a slot, a snippet or a `pending` block, where the chain restarts and nothing is judged against what is unknown.
type Chain = readonly ElementNode[]

type Report = (message: string, note: string, help: string, around?: ElementNode) => void

// Markup the HTML parser rewrites (a block in a `p`, a table part, a nested form) or that HTML forbids (a stray `li`, an `option` outside a `select`), reported only where every element up to the nearest component or slot is in view.
export function nestingLints(file: KayFile): Diagnostic[] {
  const found: Diagnostic[] = []

  walkNodes<Chain>(file.template, [], (node: Node, chain) => {
    if (node.kind === 'slot' || node.kind === 'snippet' || node.kind === 'pending')
      return []

    if (node.kind !== 'element')
      return chain

    if (node.component || node.outlet || node.fills || node.name === 'template' || node.name === 'slot')
      return []

    nestingOf(node, chain, reporter(node, found))

    return [...chain, node]
  })

  return found
}

function reporter(element: ElementNode, found: Diagnostic[]): Report {
  return (message, note, help, around) => {
    found.push({ ...element.tag.end > element.tag.start ? element.tag : element, code: 'invalid-nesting', message, note, help, ...around ? { related: [{ start: around.tag.start, end: around.tag.end, label: 'the element it sits in' }] } : {}, checkOnly: true })
  }
}

// The nearest open `ancestor`, none past a scope boundary, and for a `p` none past a block that already closed any `p` above it.
function within(chain: Chain, ancestor: string): ElementNode | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const { name } = chain[i]!

    if (name === ancestor)
      return chain[i]

    if (SCOPE_BOUNDARY.has(name) || (ancestor === 'p' && CLOSES_P.has(name)))
      return undefined
  }

  return undefined
}

function nestingOf(element: ElementNode, chain: Chain, report: Report) {
  const { name } = element
  const parent = chain.at(-1)
  const paragraph = CLOSES_P.has(name) ? within(chain, 'p') : undefined

  if (paragraph) {
    report(`This \`${name}\` sits inside a \`p\``, 'the browser closes the `p` where a block starts, so the server\'s HTML and the DOM an island builds differ', `make the \`p\` a \`div\`, or put the \`${name}\` beside it`, paragraph)

    return
  }

  if (name === 'form' || name === 'select') {
    const outer = within(chain, name)

    if (outer) {
      report(`This \`${name}\` sits inside another \`${name}\``, `the browser drops the inner \`${name}\`'s tag, so its fields join the outer one`, `move the inner \`${name}\` out, beside the other`, outer)

      return
    }
  }

  if (!parent)
    return

  if (name === 'li' && !LISTS.has(parent.name))
    report(`This \`li\` sits inside a \`${parent.name}\`, not a list`, 'HTML wants a list item in a `ul`, an `ol` or a `menu`, and a screen reader announces it as an item of no list', 'wrap the items in a `ul` or an `ol`')
  else if (LISTS.has(parent.name) && !LIST_CONTENT.has(name))
    report(`This \`${name}\` sits directly inside a \`${parent.name}\``, 'HTML lets a list hold `li` elements only, and a screen reader counts anything else as outside the list', `wrap it in an \`li\`, or make the \`${parent.name}\` a \`div\``, parent)
  else if (HEADINGS.has(name) && HEADINGS.has(parent.name))
    report(`This \`${name}\` sits inside a \`${parent.name}\``, 'the browser closes the outer heading where the inner one starts', 'put them side by side', parent)
  else
    tablePart(name, parent, report)

  // A customizable select takes an `option` under a `div` or a `label` in it, so only one with no `select` or `datalist` anywhere above is reported.
  if (name === 'option' && !chain.some(ancestor => OPTION_HOSTS.has(ancestor.name)))
    report('This `option` sits outside a `select`', 'HTML wants an `option` in a `select` or a `datalist`, and it adds nothing to a form anywhere else', 'put it in a `select`', parent)
  else if (name === 'optgroup' && parent.name !== 'select')
    report(`This \`optgroup\` sits inside a \`${parent.name}\``, 'HTML wants an `optgroup` in a `select`, and it groups nothing anywhere else', 'put it in a `select`', parent)
}

function tablePart(name: string, parent: ElementNode, report: Report) {
  if (name === 'tr' && parent.name === 'table')
    report('This `tr` sits directly inside a `table`', 'the browser wraps it in a `tbody` an island never creates, so the server\'s HTML and the DOM differ', 'wrap the rows in a `tbody`, a `thead` or a `tfoot`', parent)
  else if (name === 'tr' && !ROW_GROUPS.has(parent.name))
    report(`This \`tr\` sits inside a \`${parent.name}\``, 'the browser drops a row outside a table', 'put it in a `table`', parent)
  else if ((name === 'td' || name === 'th') && parent.name !== 'tr')
    report(`This \`${name}\` sits inside a \`${parent.name}\``, 'the browser drops a cell outside a row, or wraps it in a `tr` an island never creates', 'put it in a `tr`', parent)
  else if ((ROW_GROUPS.has(name) || name === 'caption' || name === 'colgroup') && parent.name !== 'table')
    report(`This \`${name}\` sits inside a \`${parent.name}\``, 'the browser drops a table part outside a table', 'put it in a `table`', parent)
}
