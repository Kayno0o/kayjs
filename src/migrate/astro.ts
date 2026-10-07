import type * as t from '@babel/types'
import { parse, parseExpression } from '@babel/parser'
import { formatKay } from '../compiler/format'

// `kay migrate astro`: an `.astro` file's frontmatter becomes a fence, its markup the indented template. What has no kay counterpart, or is not written the usual way, stays in the output commented out under a `// kay migrate:` line and is listed, never dropped.

export type Role = 'page' | 'component'

export interface Note {
  line: number
  message: string
}

export interface MigratedFile {
  code: string
  notes: Note[]
}

export interface MigrateOptions {
  role: Role
  // The `.kay` specifier an import of an `.astro` file becomes, relative to the new file, or undefined to keep it.
  rewriteImport: (specifier: string) => string | undefined
}

const FRONTMATTER = /^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const RAW_BLOCK = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi
const DOCTYPE = /<!doctype[^>]*>/gi
const HTML_COMMENT = /<!--([\s\S]*?)-->/g
const VOID_TAG = /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b((?:[^>"'{/]|"[^"]*"|'[^']*'|\{[^}]*\}|\/(?!>))*)(\/?)>/gi
const OTHER_FRAMEWORK = /\.(?:svelte|vue|jsx|tsx)$/
const RAW_TAG = /^kay-raw-(\d+)$/
const WHITESPACE = /\s+/g
const CLASS_TOKEN = /^[\w\-:/@!]+$/
const ID_TOKEN = /^[\w-]+$/
const UPPERCASE_START = /^[A-Z]/
const COMMENT_END = /\*\//g
const TEMPLATE_UNSAFE = /[`\\]|\$\{/g
const ATTRIBUTE_PART = /\s([\w:-]+)(?:=("[^"]*"|'[^']*'))?/g
// Elements that read as part of a line of text, rendered inline as `#[strong text]`.
const INLINE = new Set(['a', 'abbr', 'b', 'br', 'code', 'em', 'i', 'kbd', 'mark', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u'])
const HYDRATE: Record<string, string | undefined> = { 'client:load': undefined, 'client:idle': 'idle', 'client:visible': 'visible' }
// Attributes Astro reads and kay has no use for: the page swap is kay's own, and an inline script is the only kind.
const DROPPED = new Set(['is:inline', 'is:raw', 'transition:animate', 'transition:name', 'transition:persist', 'transition:persist-props'])
const ROUTER_COMPONENTS = new Set(['ClientRouter', 'ViewTransitions'])

interface RawBlock {
  tag: string
  attributes: string
  content: string
}

interface Edit {
  start: number
  end: number
  text: string
}

function escapeTemplate(text: string): string {
  return text.replace(TEMPLATE_UNSAFE, match => `\\${match}`)
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

function applyEdits(text: string, edits: Edit[]): string {
  let result = text

  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)

  return result
}

// What the template can do with each name an import declares: Astro's own components need a kay counterpart or nothing.
interface Imports {
  image: Set<string>
  router: Set<string>
  // What the translation uses from `kay`, imported in the fence.
  kay: Set<string>
  kayTypes: Set<string>
}

export function migrateAstro(source: string, options: MigrateOptions): MigratedFile {
  const notes: Note[] = []
  const match = FRONTMATTER.exec(source)
  const frontmatter = match?.[1] ?? ''
  // The template's first line in the file, for the lines notes give.
  const templateStart = match ? match[0].length : 0
  const templateLine = lineAt(source, templateStart)
  const imports: Imports = { image: new Set(), router: new Set(), kay: new Set(), kayTypes: new Set() }
  const script = migrateFrontmatter(frontmatter, options, imports, (line, message) => notes.push({ line: line + 1, message }))
  const template = migrateTemplate(source.slice(templateStart), options, imports, (line, message) => notes.push({ line: line + templateLine - 1, message }))
  const kayImport = [...imports.kayTypes.size > 0 ? [`import type { ${[...imports.kayTypes].toSorted().join(', ')} } from 'kay'\n`] : [], ...imports.kay.size > 0 ? [`import { ${[...imports.kay].toSorted().join(', ')} } from 'kay'\n`] : []].join('')
  const fenced = `${kayImport}${script.trim()}`.trim()
  const fence = fenced === '' ? '' : `${options.role === 'page' ? '--- server' : '---'}\n${fenced}\n---\n`
  const code = `${fence}${template}`
  const formatted = formatKay(code)

  if (formatted.diagnostics.length > 0)
    notes.push({ line: 1, message: `the translation does not parse as kay (${formatted.diagnostics[0]!.message}), so it is left as written; fix it by hand` })

  return { code: formatted.diagnostics.length > 0 ? code : formatted.code, notes: notes.toSorted((a, b) => a.line - b.line) }
}

function migrateFrontmatter(code: string, options: MigrateOptions, imports: Imports, note: (line: number, message: string) => void): string {
  if (code.trim() === '')
    return ''

  let ast: t.File

  try {
    ast = parse(code, { sourceType: 'module', plugins: ['typescript'], allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true })
  }
  catch (error) {
    note(0, `the frontmatter does not parse (${error instanceof Error ? error.message : error}): kept as written`)

    return code
  }

  const edits: Edit[] = []
  const lineOf = (node: t.Node) => node.loc!.start.line
  const hasProps = ast.program.body.some(statement => (statement.type === 'TSInterfaceDeclaration' || statement.type === 'TSTypeAliasDeclaration') && statement.id.name === 'Props')
  let imageMetadata: string | undefined
  let htmlAttributes: string | undefined

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') {
      const from = statement.source.value
      const remove = () => edits.push({ start: statement.start!, end: statement.end!, text: '' })

      if (from === 'astro:assets') {
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && specifier.imported.name === 'Image')
            imports.image.add(specifier.local.name)
          else
            note(lineOf(specifier), `\`${specifier.local.name}\` from astro:assets has no kay counterpart: an imported image is its URL, \`img(src={photo})\`, sized by kay`)
        }

        remove()
      }
      else if (from === 'astro:transitions') {
        for (const specifier of statement.specifiers)
          imports.router.add(specifier.local.name)

        remove()
      }
      else if (from === 'astro' || from === 'astro/types') {
        for (const specifier of statement.specifiers) {
          const imported = specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' ? specifier.imported.name : undefined

          if (imported === 'ImageMetadata')
            imageMetadata = specifier.local.name
          else if (imported === 'HTMLAttributes')
            htmlAttributes = specifier.local.name
          else
            note(lineOf(specifier), `\`${specifier.local.name}\` from ${from} has no kay counterpart`)
        }

        remove()
      }
      else if (from.startsWith('astro:')) {
        note(lineOf(statement), `${from} has no kay counterpart${from === 'astro:content' ? ': a content collection is read with `collection` from `kay/content` (see Content collections)' : ''}`)
      }
      else if (from.endsWith('.astro')) {
        const target = options.rewriteImport(from)

        if (target === undefined)
          note(lineOf(statement), `${from} is no .astro file of the project kay migrate found: point the import at the .kay file`)
        else
          edits.push({ start: statement.source.start!, end: statement.source.end!, text: `'${target}'` })
      }
      else if (OTHER_FRAMEWORK.test(from)) {
        note(lineOf(statement), `${from} is another framework's component: rewrite it as a .kay island`)
      }
    }
    else if (statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'FunctionDeclaration' && statement.declaration.id?.name === 'getStaticPaths') {
      note(lineOf(statement), 'getStaticPaths: list the params in `export const prerender = [...]` instead (see Prerendering); commented out')
      edits.push({ start: statement.start!, end: statement.end!, text: code.slice(statement.start!, statement.end!).split('\n').map(line => `// ${line}`).join('\n') })
    }
  }

  // `ImageMetadata` is what an imported image is in Astro; in kay it is its URL.
  // The imports are removed whole, so the walks leave them out.
  const statements = ast.program.body.filter(statement => statement.type !== 'ImportDeclaration')

  const aliased = new Set<string>()

  for (const statement of statements) {
    walk(statement, (node) => {
      if (imageMetadata && node.type === 'Identifier' && node.name === imageMetadata)
        edits.push({ start: node.start!, end: node.end!, text: 'string' })

      // `HTMLAttributes<'svg'>`, the attributes of an element, is kay's `JSX.IntrinsicElements['svg']`.
      if (htmlAttributes && node.type === 'TSTypeReference' && node.typeName.type === 'Identifier' && node.typeName.name === htmlAttributes) {
        const [element] = node.typeParameters?.params ?? []

        if (element?.type === 'TSLiteralType' && element.literal.type === 'StringLiteral') {
          edits.push({ start: node.start!, end: node.end!, text: `JSX.IntrinsicElements['${element.literal.value}']` })
          imports.kayTypes.add('JSX')
        }
        else {
          note(lineOf(node), `${htmlAttributes} without an element name has no kay counterpart`)
        }

        return false
      }

      // An interface extends a name only, so the attributes get one: `interface Props extends SvgAttributes`.
      if (htmlAttributes && node.type === 'TSExpressionWithTypeArguments' && node.expression.type === 'Identifier' && node.expression.name === htmlAttributes) {
        const [element] = node.typeParameters?.params ?? []

        if (element?.type === 'TSLiteralType' && element.literal.type === 'StringLiteral') {
          const tag = element.literal.value
          const name = `${tag[0]!.toUpperCase()}${tag.slice(1)}Attributes`

          edits.push({ start: node.start!, end: node.end!, text: name })
          imports.kayTypes.add('JSX')

          if (!aliased.has(name)) {
            aliased.add(name)
            edits.push({ start: statement.start!, end: statement.start!, text: `type ${name} = JSX.IntrinsicElements['${tag}']\n\n` })
          }
        }
        else {
          note(lineOf(node), `${htmlAttributes} without an element name has no kay counterpart`)
        }

        return false
      }
    })

    edits.push(...astroEdits(statement, code, 0, options.role, hasProps, note))

    // Astro awaits in any component, kay in the server fence of a page or a layout only.
    if (options.role === 'component') {
      walk(statement, (node) => {
        if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await))
          note(lineOf(node), 'a component renders synchronously: load this in the page\'s server fence and pass it as a prop')

        return !node.type.includes('Function') && node.type !== 'AwaitExpression'
      })
    }
  }

  return applyEdits(code, edits)
}

// The `Astro.*` reads under `node`, as kay reads them: `Astro.props` through `props<Props>()`, a page's request through `ctx`.
function astroEdits(node: t.Node, code: string, offset: number, role: Role, hasProps: boolean, note: (line: number, message: string) => void): Edit[] {
  const edits: Edit[] = []
  const at = (inner: t.Node, text: string) => edits.push({ start: inner.start! - offset, end: inner.end! - offset, text })
  const page = role === 'page'

  walk(node, (inner, parent) => {
    // `return Astro.redirect('/login')` ends the frontmatter; `ctx.redirect` stops the render by itself.
    if (inner.type === 'ReturnStatement' && inner.argument?.type === 'CallExpression' && isAstro(inner.argument.callee, 'redirect') && page) {
      at(inner, code.slice(inner.argument.start! - offset, inner.argument.end! - offset).replace('Astro.redirect', 'ctx.redirect'))

      return false
    }

    if (inner.type !== 'MemberExpression' || inner.object.type !== 'Identifier' || inner.object.name !== 'Astro' || inner.property.type !== 'Identifier')
      return true

    const name = inner.property.name
    const line = inner.loc!.start.line

    if (name === 'props') {
      at(inner, hasProps ? 'props<Props>()' : 'props<Record<string, unknown>>()')

      if (!hasProps)
        note(line, 'Astro.props without a `Props` type: type `props<...>()`')
    }
    else if (name === 'generator') {
      at(inner, '\'kay\'')
    }
    else if (page && ['url', 'params', 'request', 'cookies', 'redirect'].includes(name)) {
      at(inner, `ctx.${name}`)
    }
    else {
      note(line, `Astro.${name}${parent?.type === 'MemberExpression' ? '' : ''} has no kay counterpart ${page ? 'in a page' : 'in a component, which has no request: pass what it needs as a prop'}`)
    }

    return false
  })

  return edits
}

function isAstro(node: t.Node, name: string): boolean {
  return node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'Astro' && node.property.type === 'Identifier' && node.property.name === name
}

const SKIPPED_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments'])

// Visits every node under `node`, parents first; the visitor returns false to skip what is under one.
function walk(node: t.Node, visit: (node: t.Node, parent: t.Node | undefined) => boolean | void, parent?: t.Node): void {
  if (visit(node, parent) === false)
    return

  for (const [key, value] of Object.entries(node)) {
    if (SKIPPED_KEYS.has(key))
      continue

    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof (child as t.Node).type === 'string')
        walk(child as t.Node, visit, node)
    }
  }
}

function migrateTemplate(markup: string, options: MigrateOptions, imports: Imports, note: (line: number, message: string) => void): string {
  const raws: RawBlock[] = []
  // Each change keeps the text's line count, so a node's line is its line in the file.
  const prepared = markup
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
    note(1, `the markup does not parse as Astro markup kay reads (${error instanceof Error ? error.message : error}): kept as written, commented out`)

    return `// kay migrate: the markup below was not translated\n${markup.split('\n').map(line => `  ${line}`).join('\n')}\n`
  }

  const translator = new Translator(wrapped, options, imports, raws, note)

  return translator.document(root.children)
}

type Child = t.JSXText | t.JSXExpressionContainer | t.JSXSpreadChild | t.JSXElement | t.JSXFragment

class Translator {
  constructor(private readonly source: string, private readonly options: MigrateOptions, private readonly imports: Imports, private readonly raws: RawBlock[], private readonly note: (line: number, message: string) => void) {}

  private text(node: t.Node): string {
    return this.source.slice(node.start!, node.end!)
  }

  private line(node: t.Node): number {
    return node.loc!.start.line
  }

  // An expression as kay reads it: `Astro.*` rewritten, its JSX, if any, unreadable to kay.
  private expression(node: t.Node): string {
    const edits = astroEdits(node, this.source.slice(node.start!, node.end!), node.start!, this.options.role, true, this.note)

    return applyEdits(this.text(node), edits)
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
      if (attribute.type === 'JSXAttribute' && this.attributeName(attribute) === 'lang')
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

  // Children dropping the whitespace between lines, which JSX would too, and keeping a space between values on one line.
  private meaningful(children: Child[]): Child[] {
    return children.filter(child => !(child.type === 'JSXText' && child.value.trim() === '' && child.value.includes('\n')) && !(child.type === 'JSXExpressionContainer' && child.expression.type === 'JSXEmptyExpression' && !this.hasComment(child)))
  }

  private hasComment(container: t.JSXExpressionContainer): boolean {
    return (container.expression.innerComments ?? []).length > 0
  }

  private block(children: Child[]): string[] {
    return this.meaningful(children).flatMap(child => this.child(child))
  }

  private child(child: Child): string[] {
    switch (child.type) {
      case 'JSXText':
        return child.value.trim() === '' ? [] : [`| ${child.value.replace(WHITESPACE, ' ').trim()}`]
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
      return [`if ${this.expression(expression.left)}`, ...this.indent(this.rendering(expression.right as t.Expression))]

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
    const head = `for ${item.name}${index ? `, ${(index as t.Identifier).name}` : ''} of ${this.expression(expression.callee.object)}${keyText}`

    return [head, ...this.indent(this.rendering(body as t.Expression))]
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

    if (name === 'slot')
      return this.slot(element)

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
      return children.flatMap(child => this.child(child))

    const named = new Map<string, string[]>()
    const rest: string[] = []

    for (const child of children) {
      const slot = child.type === 'JSXElement' ? child.openingElement.attributes.find((attribute): attribute is t.JSXAttribute => attribute.type === 'JSXAttribute' && this.attributeName(attribute) === 'slot' && attribute.value?.type === 'StringLiteral') : undefined

      if (!slot) {
        rest.push(...this.child(child))

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
        parts.push(child.value.replace(WHITESPACE, ' '))
      }
      else if (child.type === 'JSXExpressionContainer' && child.expression.type !== 'JSXEmptyExpression' && !containsJsx(child.expression)) {
        parts.push(`{${this.expression(child.expression)}}`)
      }
      else if (child.type === 'JSXElement' && INLINE.has(this.tagName(child)) && children.some(other => other.type === 'JSXText')) {
        const inner = this.meaningful(child.children)
        const text = inner.length === 0 ? '' : this.inline(inner)

        if (text === undefined)
          return undefined

        parts.push(`#[${this.head(child, this.tagName(child))}${text ? ` ${text.trim()}` : ''}]`)
      }
      else {
        return undefined
      }
    }

    const line = parts.join('').trim()

    // A line starting as a tag would read as one.
    return line.startsWith('#[') || line === '' ? undefined : line
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

      if (name === 'key' || name === 'slot')
        continue

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
        const html = value?.type === 'StringLiteral' ? JSON.stringify(value.value) : value?.type === 'JSXExpressionContainer' && value.expression.type !== 'JSXEmptyExpression' ? this.expression(value.expression) : undefined

        if (html !== undefined && this.jsonText(element) === undefined) {
          attributes.push(`innerHTML={trustHtml(${html})}`)
          this.imports.kay.add('trustHtml')
        }

        continue
      }

      const target = name === 'class:list' ? 'class' : name === 'set:text' ? 'textContent' : name

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

    if (hydrate)
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

    if (block.tag === 'script' && !attributes.some(attribute => attribute.name === 'is:inline') && !attributes.some(attribute => attribute.name === 'type' && attribute.value !== '"module"')) {
      this.note(this.line(element), 'a script Astro bundles: write what it does as a .kay island, or import it in an inline script')

      return ['// kay migrate: a script Astro bundles', ...`<script${block.attributes}>${block.content}</script>`.split('\n').map(line => `  ${line.trimEnd()}`)]
    }

    if (block.tag === 'style' && !attributes.some(attribute => attribute.name === 'is:global'))
      this.note(this.line(element), 'a style Astro scoped to the component is global in kay: check its selectors reach only what they styled')

    return [`${head.replace('(is:global)', '').replace(' is:global', '')} {\`${escapeTemplate(block.content.trim())}\`}`]
  }
}

function containsJsx(node: t.Node): boolean {
  let found = false

  walk(node, (inner) => {
    if (inner.type === 'JSXElement' || inner.type === 'JSXFragment')
      found = true

    return !found
  })

  return found
}

function isNothing(node: t.Node): boolean {
  return node.type === 'NullLiteral' || (node.type === 'Identifier' && node.name === 'undefined') || (node.type === 'StringLiteral' && node.value === '') || (node.type === 'BooleanLiteral' && !node.value)
}
