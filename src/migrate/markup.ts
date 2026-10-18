import type * as t from '@babel/types'
import { parseExpression } from '@babel/parser'
import { eachNode } from '../compiler/each-node'

// The translation of markup into a kay template, which `kay migrate astro` and `kay fmt --from-html` share: the markup is read as JSX, which Astro's is and HTML is made to be.

// Astro attributes kay writes under another name.
const RENAMED_ATTRIBUTES = new Map([['class:list', 'class'], ['set:text', 'textContent']])
const RAW_BLOCK = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi
const DOCTYPE = /<!doctype[^>]*>/gi
const HTML_COMMENT = /<!--([\s\S]*?)-->/g
const VOID_TAG = /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b((?:[^>"'{/]|"[^"]*"|'[^']*'|\{[^}]*\}|\/(?!>))*)(\/?)>/gi
const BRACE = /[{}]/g
const ENTITY_START = /&(?=#?\w+;)/g
const PRESERVED_SPACE = /\n|[ \t]{2}/
const LEADING_SPACE = /^[ \t\n\r\f]*/
const TRAILING_SPACE = /[ \t\n\r\f]*$/
const INTERPOLATION = /#\[/g
const EVENT_ATTRIBUTE = /^on[a-z]+$/

const RAW_TAG = /^kay-raw-(\d+)$/
const WHITESPACE = /\s+/
// HTML's own whitespace, which leaves a no-break space alone.
const HTML_SPACE = /[ \t\n\r\f]+/g
const HTML_EDGE_SPACE = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g

const CLASS_TOKEN = /^[\w\-:/@!]+$/
const ID_TOKEN = /^[\w-]+$/
const UPPERCASE_START = /^[A-Z]/
const COMMENT_END = /\*\//g
const TEMPLATE_UNSAFE = /[`\\]|\$\{/g
const ATTRIBUTE_PART = /\s([\w:-]+)(?:=("[^"]*"|'[^']*'))?/g
// Elements that stand on lines of their own, so the space between one and a text beside it does not show.
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'])
// Elements that read as part of a line of text, rendered inline as `#[strong text]`.
const INLINE = new Set(['a', 'abbr', 'b', 'br', 'code', 'em', 'i', 'kbd', 'mark', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u'])
// Elements whose line break beside another renders as a space: `br` is left out, a break there collapses.
const FLOW_TAGS = new Set([...INLINE].filter(tag => tag !== 'br').concat(['audio', 'bdi', 'bdo', 'button', 'canvas', 'cite', 'data', 'del', 'dfn', 'iframe', 'img', 'input', 'ins', 'label', 'picture', 'q', 'samp', 'select', 'svg', 'textarea', 'var', 'video']))
const HYDRATE: Record<string, string | undefined> = { 'client:load': undefined, 'client:idle': 'idle', 'client:visible': 'visible' }
// Attributes Astro reads and kay has no use for: the page swap is kay's own, and an inline script is the only kind.
const DROPPED = new Set(['is:inline', 'is:raw', 'transition:animate', 'transition:name', 'transition:persist', 'transition:persist-props'])
const ROUTER_COMPONENTS = new Set(['ClientRouter', 'ViewTransitions'])

export interface RawBlock {
  tag: string
  attributes: string
  content: string
}

function escapeTemplate(text: string): string {
  return text.replace(TEMPLATE_UNSAFE, match => `\\${match}`)
}

// What the template can do with each name an import declares: Astro's own components need a kay counterpart or nothing.
export interface Imports {
  image: Set<string>
  router: Set<string>
  // What the translation uses from `kay`, imported in the fence.
  kay: Set<string>
  kayTypes: Set<string>
}

// What a caller supplies: where a note goes, what a layout's `lang` becomes, and how an expression of the markup is read (Astro's `Astro.*` rewritten, HTML having none).
export interface MarkupHost {
  note: (line: number, message: string) => void
  lang: (line: number, value: string) => void
  expression: (node: t.Node, code: string) => string
  // HTML keeps its `slot` and `key` attributes, scripts and styles as written, and a `<slot>` is a web component's, not kay's.
  mode: 'astro' | 'html'
  // Makes HTML safe to read as JSX.
  prepare?: ((markup: string) => string) | undefined
}

// The markup does not parse, as Astro's markup or as the HTML made into it.
export class MarkupError extends Error {}

export function translateMarkup(markup: string, host: MarkupHost, imports: Imports): string {
  const raws: RawBlock[] = []
  // Each change keeps the text's line count, so a node's line is its line in the file.
  const prepared = (host.prepare ? host.prepare(markup) : markup)
    .replace(RAW_BLOCK, (whole, tag: string, attributes: string, content: string) => `<kay-raw-${raws.push({ tag: tag.toLowerCase(), attributes, content }) - 1} />${'\n'.repeat(whole.split('\n').length - 1)}`)
    .replace(DOCTYPE, '')
    .replace(HTML_COMMENT, (_whole, text: string) => `{/*${text.replace(COMMENT_END, '* /')}*/}`)
    .replace(VOID_TAG, (whole, tag: string, attributes: string, closed: string) => closed ? whole : `<${tag}${attributes} />`)
  const wrapped = `<>${prepared}</>`
  let root: t.JSXFragment

  try {
    root = parseExpression(wrapped, { plugins: ['jsx', 'typescript'] }) as t.JSXFragment
  }
  catch (error) {
    throw new MarkupError(error instanceof Error ? error.message : String(error))
  }

  const translator = new Translator(wrapped, host, imports, raws)

  return translator.document(root.children)
}

type Child = t.JSXText | t.JSXExpressionContainer | t.JSXSpreadChild | t.JSXElement | t.JSXFragment

class Translator {
  private readonly note: MarkupHost['note']
  private readonly lang: MarkupHost['lang']

  constructor(private readonly source: string, private readonly host: MarkupHost, private readonly imports: Imports, private readonly raws: RawBlock[]) {
    this.note = host.note
    this.lang = host.lang
  }

  private get html(): boolean {
    return this.host.mode === 'html'
  }

  private text(node: t.Node): string {
    return this.source.slice(node.start!, node.end!)
  }

  private line(node: t.Node): number {
    return node.loc!.start.line
  }

  // An expression as kay reads it, its JSX, if any, unreadable to kay.
  private expression(node: t.Node): string {
    return this.host.expression(node, this.text(node))
  }

  // An expression kay cannot render, its source kept commented out under a note.
  private untranslated(node: t.Node, why: string): string[] {
    this.note(this.line(node), `${why}: commented out`)

    return [`// kay migrate: ${why}`, ...this.text(node).split('\n').map(line => `  ${line.trimEnd()}`)]
  }

  // The top level of a file: a layout's `html` gives its `head` children to kay's `head` block and its `body` children to the template.
  document(children: Child[]): string {
    const html = this.meaningful(children).find((child): child is t.JSXElement => child.type === 'JSXElement' && this.tagName(child) === 'html')

    if (!html)
      return `${this.block(children).join('\n')}\n`

    const lines: string[] = []

    for (const attribute of html.openingElement.attributes) {
      if (attribute.type !== 'JSXAttribute' || this.attributeName(attribute) !== 'lang')
        continue

      if (attribute.value?.type === 'StringLiteral')
        this.lang(this.line(attribute), attribute.value.value)
      else
        this.note(this.line(attribute), `\`lang\` on html: set \`lang: ${this.text(attribute.value!)}\` in kay.config.ts, which writes it on every page`)
    }

    for (const part of this.meaningful(html.children)) {
      if (part.type !== 'JSXElement') {
        lines.push(...this.child(part))

        continue
      }

      const name = this.tagName(part)

      if (name === 'head') {
        // A head block holds elements only, an `if` or `for` there has no kay counterpart.
        const head = this.meaningful(part.children).flatMap(child => child.type === 'JSXExpressionContainer' && child.expression.type !== 'JSXEmptyExpression' && containsJsx(child.expression) ? this.untranslated(child, 'markup a head block renders conditionally or in a loop, where it takes elements only') : this.child(child))

        if (head.length > 0)
          lines.push('head', ...head.map(line => `  ${line}`))
      }
      else if (name === 'body') {
        if (part.openingElement.attributes.length > 0)
          this.note(this.line(part), `the attributes of body (${part.openingElement.attributes.map(attribute => this.text(attribute)).join(' ')}) have no place in kay, which writes body itself: move them to an element inside it`)

        lines.push(...this.block(part.children))
      }
      else {
        lines.push(...this.child(part))
      }
    }

    return `${lines.join('\n')}\n`
  }

  // Children dropping the whitespace between lines, which JSX would too, except between two inline siblings, where HTML renders a space.
  private meaningful(children: Child[]): Child[] {
    const kept = children.filter(child => !(child.type === 'JSXExpressionContainer' && child.expression.type === 'JSXEmptyExpression' && !this.hasComment(child)))

    return kept.filter((child, index) => !(child.type === 'JSXText' && trimSpace(child.value) === '' && child.value.includes('\n')) || (index > 0 && index < kept.length - 1 && this.isFlow(kept[index - 1]!) && this.isFlow(kept[index + 1]!)))
  }

  private isFlow(child: Child): boolean {
    if (child.type === 'JSXElement')
      return FLOW_TAGS.has(this.tagName(child))

    return child.type === 'JSXExpressionContainer' && child.expression.type !== 'JSXEmptyExpression' && !containsJsx(child.expression)
  }

  private hasComment(container: t.JSXExpressionContainer): boolean {
    return (container.expression.innerComments ?? []).length > 0
  }

  private block(children: Child[]): string[] {
    return this.meaningful(children).flatMap((child, index, all) => this.child(child, all[index - 1], all[index + 1]))
  }

  private child(child: Child, before?: Child, after?: Child): string[] {
    switch (child.type) {
      case 'JSXText':
        return this.textLine(child.value, before, after)
      case 'JSXElement':
        return this.element(child)
      case 'JSXFragment':
        return this.block(child.children)
      case 'JSXSpreadChild':
        return this.untranslated(child, 'a spread child')
      case 'JSXExpressionContainer':
        return this.container(child)
    }
  }

  // A line of text, keeping the space it has against an element or value beside it, which would otherwise run into the text.
  private textLine(value: string, before: Child | undefined, after: Child | undefined): string[] {
    const body = trimSpace(text(value))
    const space = (edge: string, other: Child | undefined) => edge !== '' && other !== undefined && !this.isBlock(other) && (this.html || !edge.includes('\n')) ? '{\' \'}' : ''

    if (body === '')
      return before !== undefined && after !== undefined && (value.includes('\n') || (space(value, before) !== '' && space(value, after) !== '')) ? ['| {\' \'}'] : []

    return [`| ${space(LEADING_SPACE.exec(value)![0], before)}${body}${space(TRAILING_SPACE.exec(value)![0], after)}`]
  }

  private isBlock(child: Child): boolean {
    return child.type === 'JSXElement' && BLOCK_TAGS.has(this.tagName(child))
  }

  private container(container: t.JSXExpressionContainer): string[] {
    const { expression } = container

    if (expression.type === 'JSXEmptyExpression')
      return (expression.innerComments ?? []).flatMap(comment => comment.value.trim().split('\n').map(line => `// ${line.trim()}`))

    return this.rendering(expression, container)
  }

  // An expression in the markup: control flow written as `&&`, a ternary or `.map` becomes `if` and `for`.
  // `outer` is what a part kay cannot read is kept as, the braces around the expression included.
  private rendering(expression: t.Expression, outer: t.Node = expression): string[] {
    if (!containsJsx(expression))
      return [`| {${this.expression(expression)}}`]

    if (expression.type === 'JSXElement')
      return this.element(expression)

    if (expression.type === 'JSXFragment')
      return this.block(expression.children)

    if (expression.type === 'LogicalExpression' && expression.operator === '&&' && !containsJsx(expression.left))
      return [`if ${this.expression(expression.left)}`, ...this.indent(this.rendering(expression.right))]

    if (expression.type === 'ConditionalExpression' && !containsJsx(expression.test))
      return [`if ${this.expression(expression.test)}`, ...this.indent(this.rendering(expression.consequent)), ...isNothing(expression.alternate) ? [] : ['else', ...this.indent(this.rendering(expression.alternate))]]

    const loop = this.loop(expression, outer)

    if (loop)
      return loop

    return this.untranslated(outer, 'an expression rendering markup another way than `&&`, a ternary or `.map`')
  }

  // `items.map((item, i) => <li>...</li>)`, the callback giving its markup at once or from a lone return.
  private loop(expression: t.Expression, outer: t.Node): string[] | undefined {
    if (expression.type !== 'CallExpression' || expression.callee.type !== 'MemberExpression' || expression.callee.property.type !== 'Identifier' || expression.callee.property.name !== 'map' || containsJsx(expression.callee.object))
      return undefined

    const callback = expression.arguments[0]

    if (!callback || (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression'))
      return undefined

    const [item, index] = callback.params

    if (!item || item.type !== 'Identifier' || (index && index.type !== 'Identifier') || callback.params.length > 2)
      return this.untranslated(outer, '`.map` with a destructured parameter, which `for` does not take: name the item and read its fields')

    let body: t.Node = callback.body

    if (body.type === 'BlockStatement') {
      const statement = body.body.length === 1 ? body.body[0] : undefined

      if (statement?.type !== 'ReturnStatement' || !statement.argument)
        return this.untranslated(outer, '`.map` whose callback does more than return markup')

      body = statement.argument
    }

    const key = body.type === 'JSXElement' ? body.openingElement.attributes.find((attribute): attribute is t.JSXAttribute => attribute.type === 'JSXAttribute' && this.attributeName(attribute) === 'key') : undefined
    const keyText = key?.value?.type === 'JSXExpressionContainer' && key.value.expression.type !== 'JSXEmptyExpression' ? ` key={${this.expression(key.value.expression)}}` : ''
    const head = `for ${item.name}${index ? `, ${index.name}` : ''} of ${this.expression(expression.callee.object)}${keyText}`

    return [head, ...this.indent(this.rendering(body))]
  }

  private indent(lines: string[]): string[] {
    return lines.map(line => `  ${line}`)
  }

  private tagName(element: t.JSXElement): string {
    return this.text(element.openingElement.name)
  }

  private attributeName(attribute: t.JSXAttribute): string {
    return this.text(attribute.name)
  }

  private element(element: t.JSXElement): string[] {
    const name = this.tagName(element)
    const raw = RAW_TAG.exec(name)

    if (raw)
      return this.rawBlock(this.raws[Number(raw[1])]!, element)

    if (this.imports.router.has(name) || ROUTER_COMPONENTS.has(name))
      return []

    if (name === 'Fragment')
      return this.fragment(element)

    if (name === 'slot') {
      return this.html
        ? this.untranslated(element, 'a web component\'s `<slot>`: kay\'s `slot` renders a wrapper\'s children, so it cannot write the element')
        : this.slot(element)
    }

    if (this.html && (name === 'pre' || name === 'textarea') && element.children.some(inner => inner.type === 'JSXText' && PRESERVED_SPACE.test(inner.value)))
      this.note(this.line(element), `${name} keeps its whitespace in HTML: the template collapses it to single spaces, so write its text with \`\\n\` by hand`)

    const tag = this.imports.image.has(name) ? 'img' : name
    const head = this.head(element, tag)
    const children = this.meaningful(element.children)
    const json = this.jsonText(element)

    if (json !== undefined)
      return [`${head} {${json}}`]

    if (children.length === 0)
      return [head]

    const inline = this.inline(children)

    if (inline !== undefined)
      return [`${head} ${inline}`]

    return [head, ...this.indent(this.componentChildren(element, children))]
  }

  // A component's children given to a named slot, `<h2 slot="title">`, become its `@title` block.
  private componentChildren(element: t.JSXElement, children: Child[]): string[] {
    if (!UPPERCASE_START.test(this.tagName(element)))
      return children.flatMap((child, index) => this.child(child, children[index - 1], children[index + 1]))

    const named = new Map<string, string[]>()
    const rest: string[] = []

    for (const [index, child] of children.entries()) {
      const slot = child.type === 'JSXElement' ? child.openingElement.attributes.find((attribute): attribute is t.JSXAttribute => attribute.type === 'JSXAttribute' && this.attributeName(attribute) === 'slot' && attribute.value?.type === 'StringLiteral') : undefined

      if (!slot) {
        rest.push(...this.child(child, children[index - 1], children[index + 1]))

        continue
      }

      const slotName = (slot.value as t.StringLiteral).value

      named.set(slotName, [...named.get(slotName) ?? [], ...this.child(child)])
    }

    return [...[...named].flatMap(([slotName, lines]) => [`@${slotName}`, ...this.indent(lines)]), ...rest]
  }

  // Text, values and inline elements holding no more, written on the element's own line.
  private inline(children: Child[]): string | undefined {
    const parts: string[] = []

    for (const child of children) {
      if (child.type === 'JSXText') {
        parts.push(text(child.value))
      }
      else if (child.type === 'JSXExpressionContainer' && child.expression.type !== 'JSXEmptyExpression' && !containsJsx(child.expression)) {
        parts.push(`{${this.expression(child.expression)}}`)
      }
      else if (child.type === 'JSXElement' && INLINE.has(this.tagName(child)) && children.some(other => other.type === 'JSXText')) {
        const inner = this.meaningful(child.children)
        const text = inner.length === 0 ? '' : this.inline(inner)

        if (text === undefined)
          return undefined

        parts.push(`#[${this.head(child, this.tagName(child))}${text ? ` ${trimSpace(text)}` : ''}]`)
      }
      else {
        return undefined
      }
    }

    const line = trimSpace(parts.join(''))

    return line === '' ? undefined : line
  }

  // A JSON-LD script's `set:html`, which kay writes as its text, escaping what would end the script.
  private jsonText(element: t.JSXElement): string | undefined {
    const attributes = element.openingElement.attributes.filter((attribute): attribute is t.JSXAttribute => attribute.type === 'JSXAttribute')
    const type = attributes.find(attribute => this.attributeName(attribute) === 'type')?.value
    const html = attributes.find(attribute => this.attributeName(attribute) === 'set:html')?.value

    if (this.tagName(element) !== 'script' || type?.type !== 'StringLiteral' || !type.value.endsWith('json') || html?.type !== 'JSXExpressionContainer' || html.expression.type === 'JSXEmptyExpression')
      return undefined

    return this.expression(html.expression)
  }

  // `tag.class#id(attributes)`, with the static classes and id as shorthand where kay's syntax takes them.
  private head(element: t.JSXElement, tag: string): string {
    const shorthand: string[] = []
    const attributes: string[] = []
    let id = ''
    let hydrate: string | undefined

    for (const attribute of element.openingElement.attributes) {
      if (attribute.type === 'JSXSpreadAttribute') {
        attributes.push(`{...${this.expression(attribute.argument)}}`)

        continue
      }

      const name = this.attributeName(attribute)
      const value = attribute.value

      if (!this.html && (name === 'key' || name === 'slot'))
        continue

      // `onclick="..."` is code in a string, where kay's `onClick={...}` takes a function.
      if (EVENT_ATTRIBUTE.test(name) && value?.type === 'StringLiteral')
        this.note(this.line(attribute), `${name} holds code as text: write it as \`on${name[2]!.toUpperCase()}${name.slice(3)}={() => ...}\` in an island`)

      if (DROPPED.has(name))
        continue

      if (name.startsWith('client:')) {
        if (name in HYDRATE)
          hydrate = HYDRATE[name]
        else
          this.note(this.line(attribute), `${name} has no kay counterpart: an interactive .kay component hydrates by itself, \`hydrate="idle"\` or \`"visible"\` delaying it`)

        continue
      }

      if (name === 'define:vars') {
        this.note(this.line(attribute), 'define:vars: pass the values through an attribute or a prop instead; dropped')

        continue
      }

      // Astro writes `set:html` as it is, which kay does for a value `trustHtml` marks.
      if (name === 'set:html') {
        let html: string | undefined

        if (value?.type === 'StringLiteral')
          html = JSON.stringify(value.value)
        else if (value?.type === 'JSXExpressionContainer' && value.expression.type !== 'JSXEmptyExpression')
          html = this.expression(value.expression)

        if (html !== undefined && this.jsonText(element) === undefined) {
          attributes.push(`innerHTML={trustHtml(${html})}`)
          this.imports.kay.add('trustHtml')
        }

        continue
      }

      const target = RENAMED_ATTRIBUTES.get(name) ?? name

      if (value?.type === 'StringLiteral') {
        if (target === 'class') {
          for (const token of value.value.split(WHITESPACE).filter(Boolean)) {
            if (CLASS_TOKEN.test(token))
              shorthand.push(`.${token}`)
            else
              attributes.push(`class="${token}"`)
          }

          continue
        }

        if (target === 'id' && ID_TOKEN.test(value.value) && !id) {
          id = `#${value.value}`

          continue
        }

        attributes.push(value.value.includes('"') ? `${target}={${JSON.stringify(value.value)}}` : `${target}="${value.value}"`)
      }
      else if (value?.type === 'JSXExpressionContainer') {
        if (value.expression.type !== 'JSXEmptyExpression')
          attributes.push(`${target}={${this.expression(value.expression)}}`)
      }
      else if (!value) {
        attributes.push(target)
      }
      else {
        this.note(this.line(attribute), `the attribute ${name} holds markup: dropped`)
      }
    }

    if (hydrate !== undefined)
      attributes.push(`hydrate="${hydrate}"`)

    // Several static classes left out of the shorthand join in one attribute.
    const classes = attributes.filter(attribute => attribute.startsWith('class="'))
    const others = attributes.filter(attribute => !attribute.startsWith('class="'))
    const merged = classes.length > 0 ? [`class="${classes.map(attribute => attribute.slice(7, -1)).join(' ')}"`, ...others] : others
    const bare = tag === 'div' && (shorthand.length > 0 || id !== '')

    return `${bare ? '' : tag}${id}${shorthand.join('')}${merged.length > 0 ? `(${merged.join(' ')})` : ''}`
  }

  private fragment(element: t.JSXElement): string[] {
    const html = element.openingElement.attributes.find((attribute): attribute is t.JSXAttribute => attribute.type === 'JSXAttribute' && this.attributeName(attribute) === 'set:html')

    if (html)
      return this.untranslated(element, 'a Fragment with set:html: put the markup in an element\'s `innerHTML`')

    return this.block(element.children)
  }

  private slot(element: t.JSXElement): string[] {
    const named = element.openingElement.attributes.find((attribute): attribute is t.JSXAttribute => attribute.type === 'JSXAttribute' && this.attributeName(attribute) === 'name' && attribute.value?.type === 'StringLiteral')

    if (this.meaningful(element.children).length > 0)
      this.note(this.line(element), 'a slot\'s fallback content: render it with `if` when the slot is empty')

    if (!named)
      return ['slot']

    const slotName = (named.value as t.StringLiteral).value

    this.note(this.line(element), `the named slot \`${slotName}\` renders the \`${slotName}\` prop: add \`${slotName}?: JSX.Element\` to the component's props`)

    return [`| {${slotName}}`]
  }

  // A `<script>` or `<style>` taken out before parsing: an inline script and a stylesheet stay as their element, a bundled script cannot.
  private rawBlock(block: RawBlock, element: t.JSXElement): string[] {
    const attributes = [...block.attributes.matchAll(ATTRIBUTE_PART)].map(([, name, value]) => ({ name: name!, value }))
    const kept = attributes.filter(attribute => !DROPPED.has(attribute.name) && attribute.name !== 'set:html')
    const html = attributes.find(attribute => attribute.name === 'set:html')
    const head = `${block.tag}${kept.length > 0 ? `(${kept.map(attribute => attribute.value === undefined ? attribute.name : `${attribute.name}=${attribute.value.startsWith('\'') ? `"${attribute.value.slice(1, -1)}"` : attribute.value}`).join(' ')})` : ''}`

    if (html) {
      this.note(this.line(element), `${block.tag} with set:html={...}: set its \`innerHTML\` from the value instead`)

      return [`// kay migrate: ${block.tag} with set:html`, `  <${block.tag}${block.attributes}>${block.content}</${block.tag}>`]
    }

    if (block.tag === 'script' && !this.html && !attributes.some(attribute => attribute.name === 'is:inline') && !attributes.some(attribute => attribute.name === 'type' && attribute.value !== '"module"')) {
      this.note(this.line(element), 'a script Astro bundles: write what it does as a .kay island, or import it in an inline script')

      return ['// kay migrate: a script Astro bundles', ...`<script${block.attributes}>${block.content}</script>`.split('\n').map(line => `  ${line.trimEnd()}`)]
    }

    if (block.tag === 'style' && !this.html && !attributes.some(attribute => attribute.name === 'is:global'))
      this.note(this.line(element), 'a style Astro scoped to the component is global in kay: check its selectors reach only what they styled')

    return [`${head.replace('(is:global)', '').replace(' is:global', '')} {\`${escapeTemplate(block.content.trim())}\`}`]
  }
}

function trimSpace(value: string): string {
  return value.replace(HTML_EDGE_SPACE, '')
}

// Text as kay writes it on a line: its whitespace collapsed, a brace, which would open an expression, written as one, and `#[`, which would open an inline element, escaped.
function text(value: string): string {
  return value.replace(HTML_SPACE, ' ').replace(BRACE, brace => `{'${brace}'}`).replace(INTERPOLATION, '\\#[').replace(ENTITY_START, '{\'&\'}')
}

function containsJsx(node: t.Node): boolean {
  let found = false

  eachNode(node, (inner) => {
    if (inner.type === 'JSXElement' || inner.type === 'JSXFragment')
      found = true

    return !found
  })

  return found
}

function isNothing(node: t.Node): boolean {
  return node.type === 'NullLiteral' || (node.type === 'Identifier' && node.name === 'undefined') || (node.type === 'StringLiteral' && node.value === '') || (node.type === 'BooleanLiteral' && !node.value)
}
