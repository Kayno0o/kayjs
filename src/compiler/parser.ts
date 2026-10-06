import type { Attribute, AwaitBranch, AwaitNode, Details, Diagnostic, ElementNode, ForNode, IfNode, KayFile, Node, SlotNode, Span, TextNode, TryNode } from './ast'

// `--- server`, `--- client`, or `--- <T extends Row>` making the component generic, its type parameters in the third or fourth group: `--- client <T>` takes both.
const FENCE = /---(?:([ \t]*)([a-z]+)(?:[ \t]+<(.*)>)?|[ \t]*<(.*)>)?[ \t]*\r?\n/diy
const CLOSING_FENCE = /^---[ \t]*$/gm
const CLOSING_LINE = /---[ \t]*(?=\r?\n|$)/y
const BLANK_LINES = /(?:[ \t]*\r?\n)*/y
const TAG_NAME = /[A-Z][\w-]*/iy
const CLASS_NAME = /[\w\-:/@!]+/y
const ID_NAME = /[\w-]+/y
const ATTRIBUTE_NAME = /[A-Z_@:][\w\-:.@]*/iy
const SLOT_NAME = /@[A-Z_$][\w$]*/iy
const FOR_HEAD = /for[ \t]+([A-Z_$][\w$]*)(?:[ \t]*,[ \t]*([A-Z_$][\w$]*))?[ \t]+of[ \t]+/diy
const KEYWORD = /(if|else[ \t]+if|else|for|await|then|catch|try)(?=[ \t]|\r?\n|$)/y
// Pug lines kay has no counterpart for, which would otherwise read as an element named after the keyword.
const PUG_KEYWORD = /(each|while|unless|case|when|include|extends|block|mixin|doctype)(?=[ \t]|\r?\n|$)/y
const PUG_HINTS: Record<string, string> = {
  each: 'kay loops with `for item of list key={item.id}`',
  while: 'kay loops with `for item of list key={item.id}`',
  unless: 'kay writes `unless x` as `if !x`',
  case: 'kay writes `case` as `if`, `else if` and `else`',
  when: 'kay writes `case` as `if`, `else if` and `else`',
  include: 'kay reuses markup through a component: import a `.kay` file and use its tag',
  extends: 'a `_layout.kay` wraps the pages of its directory at its `slot`',
  block: 'a `_layout.kay` renders its page at `slot`, and a component takes markup as an `@name` block',
  mixin: 'kay reuses markup through a component: import a `.kay` file and use its tag',
  doctype: 'kay writes the doctype of every page itself',
}
// `then list` closing the `await` line, or a bare `then`.
const INLINE_THEN = /\s+then(?:\s+([a-z_$][\w$]*))?\s*$/d
const BRANCH_NAME = /[a-z_$][\w$]*/iy
const ALIAS = /\s+as\s+([a-z_$][\w$]*)\s*$/d
const KEY_ATTRIBUTE = /[ \t]+key=\{/y
const CAPITALIZED = /^[A-Z]/
const WHITESPACE = /\s/
const ATTRIBUTE_SEPARATOR = /[\s,]/
// What a `/` after one of these characters starts: a regex literal, since an operand is expected there.
const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^')
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof', 'new', 'throw', 'case', 'yield', 'await', 'else', 'do'])
const WORD_BEFORE = /[\w$]+$/
const REGEX_FLAGS = /[a-z]*/iy
const CLOSERS = { '{': '}', '(': ')', '[': ']' } as const
const TYPE_KEYWORDS = new Set(['any', 'unknown', 'never', 'string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'const'])

export function parseKay(source: string): KayFile {
  const diagnostics: Diagnostic[] = []
  const fences: Partial<Record<'script' | 'server', Span>> = {}
  let typeParameters: Span | undefined
  let client: Span | undefined
  let templateStart = 0

  // Fences come first, in any order: `---` holds the component script, `--- client` one rendering in the browser only, `--- server` the code that runs on the server only.
  while (true) {
    BLANK_LINES.lastIndex = templateStart
    BLANK_LINES.exec(source)
    FENCE.lastIndex = BLANK_LINES.lastIndex
    const fence = FENCE.exec(source)

    if (!fence)
      break

    const kind = fence[2] === undefined || fence[2] === 'client' ? 'script' : fence[2]
    const spaced = fence[1] !== ''
    const bodyStart = fence.index + fence[0].length

    const closing = closingFence(source, bodyStart)
    const span = { start: bodyStart, end: closing ? closing.index : source.length }

    templateStart = closing ? closing.index + closing[0].length : source.length

    if (!closing)
      diagnostics.push({ start: fence.index, end: fence.index + 3, message: 'This fence is never closed with a `---` line' })

    if (!spaced || (kind !== 'script' && kind !== 'server'))
      diagnostics.push({ start: fence.index, end: bodyStart - 1, message: `Unknown fence \`${fence[0].trim()}\``, help: 'use `---` for the component script, `--- client` for one rendering in the browser only, or `--- server` for server code' })
    else if (fences[kind])
      diagnostics.push({ start: fence.index, end: bodyStart - 1, message: `A file has one ${kind === 'server' ? '`--- server`' : 'script'} fence` })
    else
      fences[kind] = span

    const parameters = fence.indices?.[3] ?? fence.indices?.[4]

    if (kind === 'server' && parameters)
      diagnostics.push({ start: parameters[0], end: parameters[1], message: 'Type parameters go on the component script fence', help: '`--- <T>`' })

    if (kind === 'script' && fences.script === span) {
      if (parameters)
        typeParameters = { start: parameters[0], end: parameters[1] }

      if (fence[2] === 'client')
        client = { start: fence.indices![2]![0], end: fence.indices![2]![1] }
    }
  }

  const parser = new TemplateParser(source, templateStart, diagnostics)

  return { source, script: fences.script, server: fences.server, typeParameters, client, templateStart, template: parser.parseTemplate(), diagnostics }
}

// The `---` line closing a fence, past any inside a template literal or a comment, such as a markdown front matter the code holds.
// Code that leaves a template literal open falls back to the first `---` line, so the template still parses.
function closingFence(source: string, bodyStart: number): RegExpExecArray | null {
  const scanned = new TemplateParser(source, bodyStart, []).closingLine()

  if (scanned !== undefined) {
    CLOSING_LINE.lastIndex = scanned

    return CLOSING_LINE.exec(source)
  }

  CLOSING_FENCE.lastIndex = bodyStart

  return CLOSING_FENCE.exec(source)
}

class TemplateParser {
  // The element that indented children attach to: the innermost one of a `li: a` block expansion.
  private target: ElementNode | undefined

  constructor(private readonly src: string, private pos: number, private readonly diagnostics: Diagnostic[]) {}

  // Where the first `---` line outside strings, template literals and comments starts.
  closingLine(): number | undefined {
    const start = this.pos
    let i = start

    while (i < this.src.length) {
      CLOSING_LINE.lastIndex = i

      if ((i === start || this.src[i - 1] === '\n') && CLOSING_LINE.test(this.src))
        return i

      const char = this.src[i]!

      if (char === '"' || char === '\'')
        i = this.skipString(i, char)
      else if (char === '`')
        i = this.skipTemplate(i)
      else if (char === '/' && this.src[i + 1] === '/')
        i = this.lineEnd(i)
      else if (char === '/' && this.src[i + 1] === '*')
        i = this.skipBlockComment(i)
      else if (char === '/')
        i = Math.max(this.skipRegex(start, i), i + 1)
      else
        i++
    }

    return undefined
  }

  parseTemplate(): Node[] {
    const nodes = this.parseBlock(-1)

    this.skipBlankLines()

    if (this.pos < this.src.length)
      this.error(this.pos, this.lineEnd(this.pos), 'Unexpected indentation')

    return nodes
  }

  // Parses every line indented deeper than `parentIndent`; the first line fixes the block's indentation.
  private parseBlock(parentIndent: number): Node[] {
    const nodes: Node[] = []
    let blockIndent = -1

    while (true) {
      this.skipBlankLines()

      if (this.pos >= this.src.length)
        break

      const indent = this.measureIndent()

      if (indent <= parentIndent)
        break

      if (blockIndent === -1)
        blockIndent = indent
      else if (indent !== blockIndent)
        this.error(this.pos, this.pos + indent, 'Inconsistent indentation', { label: `expected ${blockIndent} spaces, found ${indent}`, note: 'the first line of a block sets its indentation' })

      this.pos += indent
      this.parseLine(indent, nodes)
    }

    for (const node of nodes) {
      if (node.kind === 'await' && !node.resolved)
        this.error(node.start, node.value.end, '`await` has no `then` block', { help: 'add a `then` block at the same indentation, or write `await <value> then <name>` on one line' })
    }

    return nodes
  }

  private parseLine(indent: number, siblings: Node[]) {
    const start = this.pos

    if (this.src.startsWith('//', start)) {
      this.pos = this.lineEnd(start)
      this.skipChildren(indent)

      return
    }

    if (this.src[start] === '|') {
      this.pos++

      if (this.src[this.pos] === ' ')
        this.pos++

      siblings.push(this.parseText(start, '\n'))
      this.rejectChildren(indent, 'Text lines cannot have children')

      return
    }

    if (this.src[start] === '@') {
      siblings.push(this.parseSlot(indent))

      return
    }

    KEYWORD.lastIndex = start
    const keyword = KEYWORD.exec(this.src)?.[1]

    if (keyword === 'if') {
      siblings.push(this.parseIf(indent))

      return
    }

    if (keyword === 'for') {
      siblings.push(this.parseFor(indent))

      return
    }

    if (keyword === 'await') {
      siblings.push(this.parseAwait(indent))

      return
    }

    if (keyword === 'try') {
      siblings.push(this.parseTry(indent))

      return
    }

    if (keyword === 'then' || keyword === 'catch') {
      this.attachAwaitBranch(indent, siblings.at(-1), keyword)

      return
    }

    if (keyword !== undefined) {
      this.attachElse(indent, siblings.at(-1), keyword !== 'else')

      return
    }

    PUG_KEYWORD.lastIndex = start
    const pug = PUG_KEYWORD.exec(this.src)?.[1]

    if (pug !== undefined) {
      this.error(start, start + pug.length, `\`${pug}\` is pug syntax kay does not have`, { help: PUG_HINTS[pug] })
      this.pos = this.lineEnd(start)
      this.skipChildren(indent)

      return
    }

    const element = this.parseElement(start, '\n')

    if (!element) {
      this.error(start, this.lineEnd(start), 'Expected an element, text (`| text`), `if`, `for` or a `@slot`')
      this.pos = this.lineEnd(start)
      this.skipChildren(indent)

      return
    }

    const target = this.target ?? element

    target.children.push(...this.parseBlock(indent))
    const end = this.lastContentEnd()

    for (let node: ElementNode | undefined = element; node; node = node === target ? undefined : node.children[0] as ElementNode)
      node.end = end
    siblings.push(element)
  }

  private parseSlot(indent: number): SlotNode {
    const start = this.pos

    SLOT_NAME.lastIndex = start
    const match = SLOT_NAME.exec(this.src)

    if (!match) {
      this.error(start, start + 1, 'Expected a slot name after `@`, such as `@fallback`')
      this.pos = this.lineEnd(start)

      return { kind: 'slot', start, end: this.pos, name: { start, end: start + 1 }, children: this.parseBlock(indent) }
    }

    const name = { start: start + 1, end: start + match[0].length }

    let params: Span | undefined

    this.pos = name.end

    if (this.src[this.pos] === '(') {
      const close = this.scanBalanced(this.pos)

      params = { start: this.pos + 1, end: close - 1 }
      this.pos = close
    }

    this.expectLineEnd(params ? 'Nothing may follow the parameters of a slot on its line' : 'Nothing may follow a slot name on its line')
    const children = this.parseBlock(indent)

    return { kind: 'slot', start, end: this.lastContentEnd(), name, params, children }
  }

  private parseIf(indent: number): IfNode {
    const start = this.pos
    const branch = this.parseBranch(start + 2, indent)

    return { kind: 'if', start, end: branch.end, branches: [branch] }
  }

  private parseBranch(testStart: number, indent: number) {
    const start = this.pos

    this.pos = testStart
    this.skipSpaces()
    const test = this.scanToLineEnd()

    if (test.start === test.end)
      this.error(start, test.end, 'Expected a condition')

    let alias: Span | undefined
    const match = ALIAS.exec(this.src.slice(test.start, test.end))
    const group = match?.indices?.[1]

    if (match?.[1] !== undefined && group && !TYPE_KEYWORDS.has(match[1])) {
      alias = { start: test.start + group[0], end: test.start + group[1] }
      test.end = test.start + match.index
    }

    const children = this.parseBlock(indent)

    return { start, end: this.lastContentEnd(), test, alias, children }
  }

  private attachElse(indent: number, previous: Node | undefined, hasTest: boolean) {
    const start = this.pos

    if (previous?.kind === 'if' && previous.branches.at(-1)?.test) {
      if (hasTest) {
        const testStart = this.src.indexOf('if', start + 4)
        const branch = this.parseBranch(testStart + 2, indent)

        previous.branches.push(branch)
        previous.end = branch.end

        return
      }

      this.pos = start + 4
      this.expectLineEnd('`else` takes no condition', { help: 'use `else if <condition>`' })
      const children = this.parseBlock(indent)

      previous.branches.push({ start, end: this.lastContentEnd(), children })
      previous.end = this.lastContentEnd()

      return
    }

    if (previous?.kind === 'for' && !previous.fallback && !hasTest) {
      this.pos = start + 4
      this.expectLineEnd('`else` takes no condition after a `for`')
      previous.fallback = this.parseBlock(indent)
      previous.end = this.lastContentEnd()

      return
    }

    this.error(start, this.lineEnd(start), '`else` must directly follow an `if`, an `else if` or a `for` at the same indentation')
    this.pos = this.lineEnd(start)
    this.skipChildren(indent)
  }

  private parseAwait(indent: number): AwaitNode {
    const start = this.pos

    this.pos = start + 'await'.length
    this.skipSpaces()
    const value = this.scanToLineEnd()
    const lineEnd = value.end
    const inline = INLINE_THEN.exec(this.src.slice(value.start, value.end))

    if (inline)
      value.end = value.start + inline.index

    if (value.start === value.end)
      this.error(start, lineEnd, 'Expected the value to await', { help: '`await comments`' })

    if (!inline) {
      const pending = this.parseBlock(indent)

      return { kind: 'await', start, end: this.lastContentEnd(), value, pending }
    }

    const group = inline.indices?.[1]
    const alias = group && { start: value.start + group[0], end: value.start + group[1] }
    const children = this.parseBlock(indent)
    const end = this.lastContentEnd()

    return { kind: 'await', start, end, value, pending: [], resolved: { start: value.end, end, alias, children } }
  }

  private parseTry(indent: number): TryNode {
    const start = this.pos

    this.pos = start + 'try'.length
    this.expectLineEnd('`try` takes nothing on its line', { help: 'put its block below it, indented' })

    const children = this.parseBlock(indent)

    return { kind: 'try', start, end: this.lastContentEnd(), children }
  }

  // `then name` directly follows an `await`, and `catch error` its `then` or a `try`; both names are optional.
  private attachAwaitBranch(indent: number, previous: Node | undefined, keyword: 'then' | 'catch') {
    const start = this.pos
    const valid = previous?.kind === 'try' ? keyword === 'catch' && !previous.rejected : previous?.kind === 'await' && (keyword === 'then' ? !previous.resolved : previous.resolved !== undefined && !previous.rejected)

    if (!valid || !previous || (previous.kind !== 'try' && previous.kind !== 'await')) {
      this.error(start, this.lineEnd(start), keyword === 'then' ? '`then` must directly follow an `await` at the same indentation' : '`catch` must directly follow a `try`, or the `then` of an `await`, at the same indentation')
      this.pos = this.lineEnd(start)
      this.skipChildren(indent)

      return
    }

    this.pos = start + keyword.length
    this.skipSpaces()
    BRANCH_NAME.lastIndex = this.pos
    const name = this.atLineEnd() ? null : BRANCH_NAME.exec(this.src)
    const alias = name ? { start: this.pos, end: this.pos + name[0].length } : undefined

    if (alias)
      this.pos = alias.end

    this.expectLineEnd(`\`${keyword}\` takes one name at most`, { help: `\`${keyword} ${keyword === 'then' ? 'value' : 'error'}\`` })
    const children = this.parseBlock(indent)
    const branch: AwaitBranch = { start, end: this.lastContentEnd(), alias, children }

    if (previous.kind === 'try')
      previous.rejected = branch
    else
      previous[keyword === 'then' ? 'resolved' : 'rejected'] = branch

    previous.end = branch.end
  }

  private parseFor(indent: number): ForNode {
    const start = this.pos

    FOR_HEAD.lastIndex = start
    const head = FOR_HEAD.exec(this.src)
    const end = this.lineEnd(start)
    const itemIndices = head?.indices?.[1]

    if (!head || !itemIndices) {
      this.error(start, end, 'Malformed `for`', { help: '`for <item> of <list> key={<key>}`, or `for <item>, <index> of <list> key={index}`' })
      this.pos = end

      return { kind: 'for', start, end, item: { start, end: start }, each: { start, end: start }, key: { start, end: start }, children: this.parseBlock(indent) }
    }

    const item = { start: itemIndices[0], end: itemIndices[1] }
    const indexIndices = head.indices?.[2]
    const index = indexIndices ? { start: indexIndices[0], end: indexIndices[1] } : undefined

    this.pos = start + head[0].length
    const each = this.scanToLineEnd(true)
    let key: Span = { start: each.end, end: each.end }

    KEY_ATTRIBUTE.lastIndex = each.end
    const keyMatch = KEY_ATTRIBUTE.exec(this.src)

    if (keyMatch) {
      const open = each.end + keyMatch[0].length - 1
      const close = this.scanBalanced(open)

      key = { start: open + 1, end: close - 1 }
      this.pos = close
      this.expectLineEnd('Nothing may follow `key={...}`')
    }
    else {
      this.error(start, this.lineEnd(start), '`for` needs a key', { help: '`key={item.id}` for rows with an identity, or `for item, i of list key={i}` for positional rows' })
    }

    const children = this.parseBlock(indent)

    return { kind: 'for', start, end: this.lastContentEnd(), item, index, each, key, children }
  }

  // Parses `tag.class#id(attrs)` plus whatever follows on the line, stopping at `terminator` (a newline, or `]` inside `#[...]`).
  private parseElement(start: number, terminator: '\n' | ']'): ElementNode | undefined {
    let tag: Span
    let name: string

    TAG_NAME.lastIndex = start
    const tagMatch = TAG_NAME.exec(this.src)

    if (tagMatch) {
      tag = { start, end: start + tagMatch[0].length }
      name = tagMatch[0]
    }
    else if (this.src[start] === '.' || this.src[start] === '#') {
      tag = { start, end: start }
      name = 'div'
    }
    else {
      return undefined
    }

    const element: ElementNode = {
      kind: 'element',
      start,
      end: tag.end,
      tag,
      name,
      component: CAPITALIZED.test(name),
      classes: [],
      attributes: [],
      children: [],
    }

    this.pos = tag.end
    this.parseShorthand(element)

    if (this.src[this.pos] === '(')
      this.parseAttributes(element)

    element.end = this.pos
    const next = this.src[this.pos]

    if (next === ':' && (this.src[this.pos + 1] === ' ')) {
      this.pos += 2
      this.skipSpaces()
      KEYWORD.lastIndex = this.pos
      const keyword = KEYWORD.exec(this.src)?.[1]

      if (keyword !== undefined) {
        this.error(this.pos, this.pos + keyword.length, `\`${keyword}\` starts a line of its own`, { help: `put it on the next line, indented under <${name}>` })
        this.pos = this.lineEnd(this.pos)
        this.target = element

        return element
      }

      const child = this.parseElement(this.pos, terminator)

      if (child) {
        element.children.push(child)
        element.end = child.end
      }
      else {
        this.error(this.pos, this.lineEnd(this.pos), 'Expected an element after `: `')
        this.target = element
      }

      return element
    }

    if (next === ' ') {
      this.pos++
      const text = this.parseText(this.pos, terminator)

      // Spaces left at the end of a tag line are not text, so they render nothing.
      if (text.parts.some(part => part.kind !== 'chunk' || part.text.trim() !== ''))
        element.children.push(text)

      element.end = this.pos
      this.target = element

      return element
    }

    if (!this.atLineEnd() && !(terminator === ']' && next === ']')) {
      this.error(this.pos, this.lineEnd(this.pos), `Unexpected \`${next}\` after <${name}>`, { help: `inline text needs a space before it: \`${name} Hello\`` })
      this.pos = this.lineEnd(this.pos)
    }

    this.target = element

    return element
  }

  private parseShorthand(element: ElementNode) {
    while (true) {
      const char = this.src[this.pos]

      if (char !== '.' && char !== '#')
        return

      const pattern = char === '.' ? CLASS_NAME : ID_NAME

      pattern.lastIndex = this.pos + 1
      const match = pattern.exec(this.src)

      if (!match) {
        this.error(this.pos, this.pos + 1, char === '.' ? 'Expected a class name after `.`' : 'Expected an id after `#`')
        this.pos++

        return
      }

      let value = match[0]

      // A colon followed by a space ends the shorthand and opens block expansion (`li: a`); `md:flex` keeps it.
      if (char === '.' && value.endsWith(':') && (this.src[this.pos + 1 + value.length] === ' ' || this.atLineEnd(this.pos + 1 + value.length)))
        value = value.slice(0, -1)

      const span = { start: this.pos + 1, end: this.pos + 1 + value.length }

      if (char === '.') {
        element.classes.push(span)
      }
      else {
        if (element.id)
          this.error(this.pos, span.end, 'An element has one id')

        element.id = span
      }

      this.pos = span.end
    }
  }

  private parseAttributes(element: ElementNode) {
    const open = this.pos

    this.pos++

    while (true) {
      this.skipAttributeSeparators()
      const char = this.src[this.pos]

      if (char === undefined) {
        this.error(open, open + 1, 'Unclosed `(`')

        return
      }

      if (char === ')') {
        this.pos++
        element.parens = { start: open, end: this.pos }

        return
      }

      if (char === '{') {
        const end = this.scanBalanced(this.pos)
        const inner = this.src.slice(this.pos + 1, end - 1)
        const spreadAt = inner.indexOf('...')

        if (spreadAt === -1 || inner.slice(0, spreadAt).trim() !== '')
          this.error(this.pos, end, 'A braced attribute must be a spread', { help: '`{...props}`' })

        element.attributes.push({ kind: 'spread', expression: { start: this.pos + 1 + spreadAt + 3, end: end - 1 } })
        this.pos = end

        continue
      }

      ATTRIBUTE_NAME.lastIndex = this.pos
      const match = ATTRIBUTE_NAME.exec(this.src)

      if (!match) {
        this.error(this.pos, this.pos + 1, `Unexpected \`${char}\` in attributes`)
        this.pos++

        continue
      }

      const name = { start: this.pos, end: this.pos + match[0].length }

      this.pos = name.end
      element.attributes.push(this.parseAttributeValue(name))
    }
  }

  private parseAttributeValue(name: Span): Attribute {
    const save = this.pos

    this.skipSpaces()

    if (this.src[this.pos] !== '=') {
      this.pos = save

      return { kind: 'boolean', name }
    }

    this.pos++
    this.skipSpaces()
    const quote = this.src[this.pos]

    if (quote === '"' || quote === '\'') {
      const end = this.src.indexOf(quote, this.pos + 1)

      if (end === -1 || end > this.lineEnd(this.pos)) {
        this.error(this.pos, this.pos + 1, 'Unclosed string')
        this.pos = this.src.length

        return { kind: 'boolean', name }
      }

      const value = { start: this.pos + 1, end }

      this.pos = end + 1

      return { kind: 'static', name, value, text: this.src.slice(value.start, value.end) }
    }

    if (quote === '{') {
      const end = this.scanBalanced(this.pos)
      const expression = { start: this.pos + 1, end: end - 1 }

      this.pos = end

      if (this.src.slice(expression.start, expression.end).trim() === '')
        this.error(name.start, end, 'Empty attribute expression')

      return { kind: 'expression', name, expression }
    }

    this.error(name.start, this.pos, 'An attribute value is a quoted string or a `{expression}`', { help: `\`${this.src.slice(name.start, name.end)}={...}\`` })

    return { kind: 'boolean', name }
  }

  // Inline text with `{expression}` interpolation, `\{` escapes and `#[tag inline]` elements.
  private parseText(start: number, terminator: '\n' | ']'): TextNode {
    const parts: TextNode['parts'] = []
    let chunkStart = this.pos
    let chunk = ''
    const flush = () => {
      if (chunk !== '')
        parts.push({ kind: 'chunk', start: chunkStart, end: this.pos, text: chunk })

      chunk = ''
    }

    while (this.pos < this.src.length) {
      const char = this.src[this.pos]!

      if (char === '\n' || (char === '\r' && this.src[this.pos + 1] === '\n') || (terminator === ']' && char === ']'))
        break

      if (char === '\\' && (this.src[this.pos + 1] === '{' || this.src[this.pos + 1] === '#')) {
        chunk += this.src[this.pos + 1]
        this.pos += 2

        continue
      }

      if (char === '{') {
        flush()
        const end = this.scanBalanced(this.pos)
        const expression = { start: this.pos + 1, end: end - 1 }

        if (this.src.slice(expression.start, expression.end).trim() === '')
          this.error(this.pos, end, 'Empty `{}` in text', { help: 'write `\\{` for a literal brace' })

        parts.push({ kind: 'expression', start: this.pos, end, expression })
        this.pos = end
        chunkStart = this.pos

        continue
      }

      if (char === '#' && this.src[this.pos + 1] === '[') {
        flush()
        const open = this.pos

        this.pos += 2
        const element = this.parseElement(this.pos, ']')

        if (!element)
          this.error(open, open + 2, 'Expected an element after `#[`')

        if (this.src[this.pos] === ']')
          this.pos++
        else
          this.error(open, open + 2, 'Unclosed `#[`')

        if (element) {
          element.start = open
          element.end = this.pos
          parts.push(element)
        }

        chunkStart = this.pos

        continue
      }

      chunk += char
      this.pos++
    }

    flush()

    return { kind: 'text', start, end: this.pos, parts }
  }

  // Returns the position just past the bracket matching the one at `open`, skipping strings, template literals and comments.
  private scanBalanced(open: number): number {
    const closers: string[] = []
    let i = open

    while (i < this.src.length) {
      const char = this.src[i]!

      if (char === '"' || char === '\'') {
        i = this.skipString(i, char)

        continue
      }

      if (char === '`') {
        i = this.skipTemplate(i)

        continue
      }

      if (char === '/' && this.src[i + 1] === '/') {
        i = this.lineEnd(i)

        continue
      }

      if (char === '/' && this.src[i + 1] !== '*') {
        const end = this.skipRegex(open, i)

        if (end !== -1) {
          i = end

          continue
        }
      }

      if (char === '/' && this.src[i + 1] === '*') {
        i = this.skipBlockComment(i)

        continue
      }

      i++

      if (char === '{' || char === '(' || char === '[') {
        closers.push(CLOSERS[char])

        continue
      }

      if (char !== '}' && char !== ')' && char !== ']')
        continue

      if (closers.pop() !== char) {
        this.error(i - 1, i, `Unbalanced \`${char}\``)

        return i
      }

      if (closers.length === 0)
        return i
    }

    this.error(open, open + 1, `Unclosed \`${this.src[open]}\``)

    return this.src.length
  }

  private skipTemplate(open: number): number {
    let i = open + 1

    while (i < this.src.length && this.src[i] !== '`') {
      if (this.src[i] === '\\') {
        i += 2

        continue
      }

      if (this.src[i] === '$' && this.src[i + 1] === '{') {
        i = this.scanBalanced(i + 1)

        continue
      }

      i++
    }

    if (i >= this.src.length) {
      this.error(open, open + 1, 'Unclosed template literal')

      return this.src.length
    }

    return i + 1
  }

  private skipBlockComment(open: number): number {
    const close = this.src.indexOf('*/', open + 2)

    return close === -1 ? this.src.length : close + 2
  }

  private skipString(open: number, quote: string): number {
    let i = open + 1

    while (i < this.src.length && this.src[i] !== quote && this.src[i] !== '\n')
      i += this.src[i] === '\\' ? 2 : 1

    return this.src[i] === quote ? i + 1 : i
  }

  // Returns the position just past the regex literal starting at `at`, or -1 when a `/` there divides or the literal does not close on its line; `from` bounds the look back at the previous token.
  private skipRegex(from: number, at: number): number {
    let before = at - 1

    while (before >= from && WHITESPACE.test(this.src[before]!))
      before--

    const previous = before < from ? '{' : this.src[before]!
    const word = WORD_BEFORE.exec(this.src.slice(from, before + 1))?.[0]
    const doubled = (previous === '+' || previous === '-') && this.src[before - 1] === previous

    if (doubled || !(REGEX_PRECEDERS.has(previous) || (word !== undefined && REGEX_KEYWORDS.has(word))))
      return -1

    let inClass = false

    for (let i = at + 1; i < this.src.length && this.src[i] !== '\n'; i++) {
      const char = this.src[i]

      if (char === '\\') {
        i++
      }
      else if (char === '[') {
        inClass = true
      }
      else if (char === ']') {
        inClass = false
      }
      else if (char === '/' && !inClass) {
        REGEX_FLAGS.lastIndex = i + 1
        REGEX_FLAGS.test(this.src)

        return REGEX_FLAGS.lastIndex
      }
    }

    return -1
  }

  // Scans an expression running to the end of the line; brackets may span lines. With `stopAtKey`, a top-level ` key={` ends it.
  private scanToLineEnd(stopAtKey = false): Span {
    const start = this.pos
    let i = start

    while (i < this.src.length) {
      const char = this.src[i]!

      if (char === '\n')
        break

      if (stopAtKey && (char === ' ' || char === '\t')) {
        KEY_ATTRIBUTE.lastIndex = i

        if (KEY_ATTRIBUTE.test(this.src))
          break
      }

      if (char === '"' || char === '\'') {
        i = this.skipString(i, char)

        continue
      }

      if (char === '`') {
        i = this.skipTemplate(i)

        continue
      }

      if (char === '/') {
        const end = this.skipRegex(start, i)

        if (end !== -1) {
          i = end

          continue
        }
      }

      if (char === '{' || char === '(' || char === '[') {
        i = this.scanBalanced(i)

        continue
      }

      i++
    }

    this.pos = i
    let end = i

    while (end > start && WHITESPACE.test(this.src[end - 1]!))
      end--

    return { start, end }
  }

  private skipAttributeSeparators() {
    while (this.pos < this.src.length && ATTRIBUTE_SEPARATOR.test(this.src[this.pos]!))
      this.pos++
  }

  private skipSpaces() {
    while (this.src[this.pos] === ' ' || this.src[this.pos] === '\t')
      this.pos++
  }

  private skipBlankLines() {
    while (this.pos < this.src.length) {
      const end = this.lineEnd(this.pos)

      if (this.src.slice(this.pos, end).trim() !== '')
        return

      this.pos = end < this.src.length ? end + 1 : end
    }
  }

  // Skips the lines indented deeper than `indent`, leaving the cursor on the next line that is not.
  private skipChildren(indent: number) {
    let lineStart = this.lineEnd(this.pos) + 1

    while (lineStart < this.src.length) {
      const end = this.lineEnd(lineStart)

      if (this.src.slice(lineStart, end).trim() !== '') {
        if (this.indentAt(lineStart) <= indent)
          break

        this.rejectTabs(lineStart, this.indentAt(lineStart))
      }

      lineStart = end + 1
    }

    this.pos = Math.min(lineStart, this.src.length)
  }

  private rejectChildren(indent: number, message: string) {
    const save = this.pos
    const children = this.parseBlock(indent)

    if (children.length > 0)
      this.error(children[0]!.start, children.at(-1)!.end, message)

    if (children.length === 0)
      this.pos = save
  }

  private expectLineEnd(message: string, details?: Details) {
    this.skipSpaces()

    if (!this.atLineEnd()) {
      this.error(this.pos, this.lineEnd(this.pos), message, details)
      this.pos = this.lineEnd(this.pos)
    }
  }

  private measureIndent(): number {
    const indent = this.indentAt(this.pos)

    this.rejectTabs(this.pos, indent)

    return indent
  }

  private rejectTabs(lineStart: number, indent: number) {
    const tab = this.src.slice(lineStart, lineStart + indent).indexOf('\t')

    if (tab !== -1)
      this.error(lineStart + tab, lineStart + tab + 1, 'Indent with spaces, not tabs')
  }

  private indentAt(lineStart: number): number {
    let i = lineStart

    while (this.src[i] === ' ' || this.src[i] === '\t')
      i++

    return i - lineStart
  }

  private atLineEnd(at = this.pos): boolean {
    const char = this.src[at]

    return char === undefined || char === '\n' || (char === '\r' && this.src[at + 1] === '\n')
  }

  private lineEnd(from: number): number {
    const end = this.src.indexOf('\n', from)

    return end === -1 ? this.src.length : end
  }

  // The end of the last non-blank character consumed, so a node's span never swallows trailing blank lines.
  private lastContentEnd(): number {
    let end = this.pos

    while (end > 0 && WHITESPACE.test(this.src[end - 1]!))
      end--

    return end
  }

  private error(start: number, end: number, message: string, details?: Details) {
    this.diagnostics.push({ start, end: Math.max(end, start + 1), message, ...details })
  }
}
