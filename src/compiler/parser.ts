import type * as t from '@babel/types'
import type { Attribute, AwaitBranch, AwaitNode, ConstNode, Details, Diagnostic, ElementNode, ErrorNode, ForNode, IfBranch, IfNode, KayFile, MatchNode, Node, PendingNode, SlotNode, SnippetNode, Span, TextNode, TryNode } from './ast'
import { parseExpression } from '@babel/parser'
import { scanClassName } from './class-name'
import { Scanner } from './scanner'

// `--- server`, `--- client`, `--- script`, or `--- <T extends Row>` making the component generic, its type parameters in the third or fourth group: `--- client <T>` takes both.
const FENCE = /---(?:([ \t]*)([a-z]+)(?:[ \t]+<(.*)>)?|[ \t]*<(.*)>)?[ \t]*\r?\n/diy
const CLOSING_FENCE = /^---(?:[ \t]*$|[ \t]*[a-z<])/gm
const CLOSING_LINE = /---[ \t]*(?=\r?\n|$)/y
// A labeled fence line, which closes the fence before it and opens its own.
const NEXT_FENCE_LINE = /---[ \t]*[a-z<]/y
const BLANK_LINES = /(?:[ \t]*\r?\n)*/y
const TAG_NAME = /[A-Z][\w-]*/iy
const ID_NAME = /[\w-]+/y
// What separates the words of a class value: not `\s`, whose non-breaking space is part of a word.
const WHITESPACE_RUN = /[ \t\r\n]+/g
// A `class="` that ends its line, which opens a value over several lines.
const LINE_BREAK_AFTER = /[ \t]*\r?\n/y
const ATTRIBUTE_NAME = /[A-Z_@:][\w\-:.@]*/iy
const MODIFIERS = /(?:\|[\w-]*)+/y
// The name a bare `{name}` attribute takes from its variable, and the last member of `{post.title}`.
const SHORTHAND_NAME = /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u
const MEMBER_CHAIN = /^(?:[\p{ID_Start}_$][\p{ID_Continue}$]*\??\.)+([\p{ID_Start}_$][\p{ID_Continue}$]*)$/u
const RESERVED_WORDS = new Set(['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield'])
// What a binding may not be named in a module, which a snippet's name is.
const STRICT_RESERVED_WORDS = new Set(['arguments', 'eval', 'implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static'])
const SLOT_NAME = /@[A-Z_$][\w$]*/iy
// `slot actions`: where a component renders its `actions` block prop.
const NAMED_SLOT = /slot[ \t]+([A-Z_$][\w$]*)/diy
const SNIPPET_HELP = '`snippet feature(title: string, text: string)`, then its lines indented below it'
const FOR_HEAD = /for[ \t]+([A-Z_$][\w$]*)(?:[ \t]*,[ \t]*([A-Z_$][\w$]*))?[ \t]+of[ \t]+/diy
const COMMENT_HEAD = /\/\//y
// `| text`, or a line made of an expression, which is text as `| {expr}` is.
const TEXT_HEAD = /\| ?|(?=\{)/y
const SLOT_HEAD = /(?=@)/y
const MARKDOWN_HEAD = /markdown[ \t]*(?=\r?\n|$)/y
// `- code`, which pug runs.
const PUG_CODE = /-(?= |\r?\n|$)/y
// What a condition naming its value holds, which may as well be a cast.
const MAY_ALIAS = /\sas\s/
// A capitalized name after a condition's `as` is a type, so a cast.
const CAPITALIZED_NAME = /^[\p{Lu}\p{Lt}]/u
// What the tail of a condition is parsed behind, as the type of a cast.
const CAST = '_ as'
const MATCH_LINE = /(when|else)(?=[ \t]|\r?\n|$)/y
const CONST_HEAD = /const(?=[ \t]|\r?\n|$)/y
// `let x = 1`: a declaration kay has no counterpart for, told from a `var` element by the `=`.
const REASSIGNABLE = /(let|var)[ \t]+[A-Z_$][\w$]*[ \t]*=(?!=)/iy
const CONST_NAME = /[A-Z_$][\w$]*/iy
const CONST_HELP = '`const name = value`, or `const { a, b } = value` to destructure it'
// `error title`, `error.text-sm title` or a bare `error`.
const ERROR_HEAD = /error(?=[. \t]|\r?\n|$)/y
const FIELD_NAME = /[\w$-]+|"[^"\n]*"|'[^'\n]*'/y
const ERROR_HELP = '`error title` shows the message of the field posted as `title`, a bare `error` the form\'s own'
// Pug lines kay has no counterpart for, which would otherwise read as an element named after the keyword.
const PUG_KEYWORD = /(each|while|unless|case|include|extends|block|mixin|doctype)(?=[ \t]|\r?\n|$)/y
const PUG_HINTS: Record<string, string> = {
  each: 'kay loops with `for item of list`',
  while: 'kay loops with `for item of list`',
  unless: 'kay writes `unless x` as `if !x`',
  case: 'kay picks among values with `match value` and its `when` lines',
  include: 'kay reuses markup through a component: import a `.kay` file and use its tag',
  extends: 'a `_layout.kay` wraps the pages of its directory at its `slot`',
  block: 'a `_layout.kay` renders its page at `slot`, and a component takes markup as an `@name` block',
  mixin: 'kay reuses markup through a component: import a `.kay` file and use its tag, or declare a `snippet` for markup used in one file',
  doctype: 'kay writes the doctype of every page itself',
}
// `then list` closing the `await` line, or a bare `then`.
const INLINE_THEN = /\s+then(?:\s+([a-z_$][\w$]*))?\s*$/d
const BRANCH_NAME = /[a-z_$][\w$]*/iy
const KEY_ATTRIBUTE = /[ \t]+key=\{/y
const CAPITALIZED = /^[A-Z]/
const WHITESPACE = /\s/
const ATTRIBUTE_SEPARATOR = /[\s,]/

// A keyword starting a line, such as `if`, past which a space or the end of the line comes.
function keyword(words: string): RegExp {
  return new RegExp(`(?:${words})(?=[ \\t]|\\r?\\n|$)`, 'y')
}

const KEYWORD = keyword('if|else[ \\t]+if|else|for|await|then|catch|try|pending|match|when')

export function parseKay(source: string): KayFile {
  const diagnostics: Diagnostic[] = []
  const fences: Partial<Record<'script' | 'server', Span>> = {}
  let typeParameters: Span | undefined
  let client: Span | undefined
  let templateStart = 0
  let unclosedServer: Diagnostic | undefined

  // Fences come first, in any order: `---` or `--- script` holds the component script, `--- client` one rendering in the browser only, `--- server` the code that runs on the server only.
  // A labeled fence line also closes the fence before it, so `--- server` code can run straight into `--- script`.
  while (true) {
    BLANK_LINES.lastIndex = templateStart
    BLANK_LINES.exec(source)
    FENCE.lastIndex = BLANK_LINES.lastIndex
    const fence = FENCE.exec(source)

    if (!fence)
      break

    const kind = fence[2] === undefined || fence[2] === 'client' || fence[2] === 'script' ? 'script' : fence[2]
    const spaced = fence[1] !== ''
    const bodyStart = fence.index + fence[0].length

    const closing = closingFence(source, bodyStart)
    const span = { start: bodyStart, end: closing ? closing.start : source.length }

    templateStart = closing ? closing.end : source.length

    if (!closing) {
      const unclosed: Diagnostic = { start: fence.index, end: fence.index + 3, code: 'fence-invalid', message: 'This fence is never closed with a `---` line' }

      if (kind === 'server' && spaced && !unclosedServer)
        unclosedServer = unclosed
      else
        diagnostics.push(unclosed)
    }

    if (!spaced || (kind !== 'script' && kind !== 'server'))
      diagnostics.push({ start: fence.index, end: bodyStart - 1, code: 'fence-invalid', message: `Unknown fence \`${fence[0].trim()}\``, help: 'use `---` or `--- script` for the component script, `--- client` for one rendering in the browser only, or `--- server` for server code' })
    else if (fences[kind])
      diagnostics.push({ start: fence.index, end: bodyStart - 1, code: 'fence-invalid', message: `A file has one ${kind === 'server' ? '`--- server`' : 'script'} fence` })
    else
      fences[kind] = span

    const parameters = fence.indices?.[3] ?? fence.indices?.[4]

    if (kind === 'server' && parameters)
      diagnostics.push({ start: parameters[0], end: parameters[1], code: 'fence-invalid', message: 'Type parameters go on the component script fence', help: '`--- <T>`' })

    if (kind === 'script' && fences.script === span) {
      if (parameters)
        typeParameters = { start: parameters[0], end: parameters[1] }

      if (fence[2] === 'client')
        client = { start: fence.indices![2]![0], end: fence.indices![2]![1] }
    }
  }

  const parser = new TemplateParser(source, templateStart, diagnostics)

  return { source, script: fences.script, server: fences.server, typeParameters, client, templateStart, template: parser.parseTemplate(), diagnostics, unclosedServer }
}

// The line closing a fence, past any inside a template literal or a comment, such as a markdown front matter the code holds: a `---` line, consumed, or a labeled one opening the next fence, left to it.
// Code that leaves a template literal open falls back to the first such line, so the template still parses.
function closingFence(source: string, bodyStart: number): Span | undefined {
  CLOSING_FENCE.lastIndex = bodyStart

  const start = new TemplateParser(source, bodyStart, []).closingLine() ?? CLOSING_FENCE.exec(source)?.index

  if (start === undefined)
    return undefined

  CLOSING_LINE.lastIndex = start

  return { start, end: CLOSING_LINE.test(source) ? CLOSING_LINE.lastIndex : start }
}

class TemplateParser {
  // The element that indented children attach to: the innermost one of a `li: a` block expansion.
  private target: ElementNode | undefined

  private readonly scan: Scanner
  // Steps over code a span already scanned, whose problems it reported then.
  private readonly quiet: Scanner

  constructor(private readonly src: string, private pos: number, private readonly diagnostics: Diagnostic[]) {
    this.scan = new Scanner(src, (start, end, message) => this.error(start, end, message))
    this.quiet = new Scanner(src, () => undefined)
  }

  // Where the first `---` or labeled fence line outside strings, template literals and comments starts.
  closingLine(): number | undefined {
    const start = this.pos
    let i = start

    while (i < this.src.length) {
      CLOSING_LINE.lastIndex = i
      NEXT_FENCE_LINE.lastIndex = i

      if ((i === start || this.src[i - 1] === '\n') && (CLOSING_LINE.test(this.src) || NEXT_FENCE_LINE.test(this.src)))
        return i

      const char = this.src[i]!

      if (char === '"' || char === '\'')
        i = this.scan.string(i, char)
      else if (char === '`')
        i = this.scan.template(i)
      else if (char === '/' && this.src[i + 1] === '/')
        i = this.scan.lineEnd(i)
      else if (char === '/' && this.src[i + 1] === '*')
        i = this.scan.blockComment(i)
      else if (char === '/')
        i = Math.max(this.scan.regex(start, i), i + 1)
      else
        i++
    }

    return undefined
  }

  parseTemplate(): Node[] {
    const nodes = this.parseBlock(-1)

    this.skipBlankLines()

    if (this.pos < this.src.length)
      this.error(this.pos, this.scan.lineEnd(this.pos), 'Unexpected indentation')

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

  // Each kind of line by how it starts, tried in order, the cursor at the start of the line; a line none of them starts is an element.
  // Each kind of line by how it starts and the characters it may start with, tried in order, the cursor at the start of the line; a line none of them starts is an element.
  private static readonly lineKinds: [head: RegExp, first: string, parse: (parser: TemplateParser, indent: number, siblings: Node[], head: RegExpExecArray) => void][] = [
    [COMMENT_HEAD, '/', (parser, indent) => parser.skipLine(indent)],
    // A line made of an expression is text, as `| {expr}` is.
    [TEXT_HEAD, '|{', (parser, indent, siblings, head) => {
      const start = parser.pos

      parser.pos += head[0].length
      siblings.push(parser.parseText(start, '\n'))
      parser.rejectChildren(indent, 'Text lines cannot have children')
    }],
    [SLOT_HEAD, '@', (parser, indent, siblings) => siblings.push(parser.parseSlot(indent))],
    [ERROR_HEAD, 'e', (parser, indent, siblings) => siblings.push(parser.parseError(indent))],
    [CONST_HEAD, 'c', (parser, indent, siblings) => {
      const node = parser.parseConst(indent)

      if (node)
        siblings.push(node)
    }],
    [REASSIGNABLE, 'lvLV', (parser, indent, _, head) => parser.skipLine(indent, { length: head[1]!.length, message: `A template declares names with \`const\`, not \`${head[1]}\``, note: 'what the template renders follows the values it reads, so nothing in it is reassigned', help: 'write `const`, or keep a value that changes in a signal of the script' })],
    [PUG_CODE, '-', (parser, indent) => parser.skipLine(indent, { length: 1, message: '`- code` is pug syntax kay does not have', help: 'a template names a value with `const name = value`; other code goes in the script' })],
    [keyword('if'), 'i', (parser, indent, siblings) => siblings.push(parser.parseIf(indent))],
    [keyword('for'), 'f', (parser, indent, siblings) => siblings.push(parser.parseFor(indent))],
    [keyword('await'), 'a', (parser, indent, siblings) => siblings.push(parser.parseAwait(indent))],
    [keyword('try'), 't', (parser, indent, siblings) => siblings.push(parser.parseTry(indent))],
    [keyword('pending'), 'p', (parser, indent, siblings) => siblings.push(parser.parsePending(indent))],
    [MARKDOWN_HEAD, 'm', (parser, indent, siblings, head) => siblings.push(parser.parseMarkdown(indent, head[0].length))],
    [keyword('match'), 'm', (parser, indent, siblings) => siblings.push(parser.parseMatch(indent))],
    [keyword('when'), 'w', (parser, indent) => parser.skipLine(indent, { length: 4, message: '`when` sits in a `match` block', help: '`match status`, then one `when \'draft\'` line per case below it' })],
    [keyword('then|catch'), 'tc', (parser, indent, siblings, head) => parser.attachAwaitBranch(indent, siblings.at(-1), head[0] as 'then' | 'catch')],
    [keyword('else[ \\t]+if|else'), 'e', (parser, indent, siblings, head) => parser.attachElse(indent, siblings.at(-1), head[0] !== 'else')],
    [PUG_KEYWORD, 'ewucibmd', (parser, indent, _, head) => parser.skipLine(indent, { length: head[0].length, message: `\`${head[0]}\` is pug syntax kay does not have`, help: PUG_HINTS[head[0]] })],
    [keyword('snippet'), 's', (parser, indent, siblings) => {
      const node = parser.parseSnippet(indent)

      if (node)
        siblings.push(node)
    }],
    [NAMED_SLOT, 'sS', (parser, indent, siblings, head) => siblings.push(parser.parseOutlet(indent, head))],
  ]

  // The kinds a line may be by its first character, so most lines, elements, try none.
  private static readonly kindsByFirst = Map.groupBy(TemplateParser.lineKinds.flatMap(kind => [...kind[1]].map(char => [char, kind] as const)), ([char]) => char)

  private parseLine(indent: number, siblings: Node[]) {
    for (const [, [head, , parse]] of TemplateParser.kindsByFirst.get(this.src[this.pos]!) ?? []) {
      head.lastIndex = this.pos
      const found = head.exec(this.src)

      if (found) {
        parse(this, indent, siblings, found)

        return
      }
    }

    const start = this.pos
    const element = this.parseElement(start, '\n')

    if (!element) {
      this.skipLine(indent, { message: 'Expected an element, text (`| text`), `if`, `for` or a `@slot`' })

      return
    }

    const target = this.target ?? element

    target.children.push(...this.parseBlock(indent))
    const end = this.lastContentEnd()

    for (let node: ElementNode | undefined = element; node; node = node === target ? undefined : node.children[0] as ElementNode)
      node.end = end
    siblings.push(element)
  }

  // Leaves the line and the lines indented under it, reporting `problem` from the cursor over `length` characters, or to the end of the line.
  private skipLine(indent: number, problem?: Details & { message: string, length?: number }) {
    const start = this.pos
    const end = this.scan.lineEnd(start)

    if (problem) {
      const { message, length, ...details } = problem

      this.error(start, length === undefined ? end : start + length, message, details)
    }

    this.pos = end
    this.skipChildren(indent)
  }

  // The raw lines under `markdown`, which the compiler lowers to template lines before the template is read again.
  private parseMarkdown(indent: number, length: number): ElementNode {
    const start = this.pos
    const lineEnd = this.scan.lineEnd(start)

    this.pos = start + length
    this.skipChildren(indent)

    const end = this.lastContentEnd()
    const markdown = { start: lineEnd, end: Math.max(end, lineEnd) }

    return { kind: 'element', start, end: markdown.end, tag: { start, end: start + 8 }, name: 'markdown', component: false, classes: [], attributes: [], markdown, children: [] }
  }

  private parseOutlet(indent: number, match: RegExpExecArray): ElementNode {
    const start = this.pos
    const [nameStart, nameEnd] = match.indices![1]!
    let args: Span | undefined

    this.pos = nameEnd

    if (this.src[this.pos] === '(') {
      const close = this.scan.balanced(this.pos)

      args = { start: this.pos + 1, end: close - 1 }
      this.pos = close
    }

    this.expectLineEnd(args ? 'Nothing may follow the arguments of a slot on its line' : 'Nothing may follow a slot name on its line', { help: 'the lines under it render when the block is not given' })
    const children = this.parseBlock(indent)

    return { kind: 'element', start, end: this.lastContentEnd(), tag: { start, end: start + 4 }, name: 'slot', component: false, classes: [], attributes: [], outlet: { name: { start: nameStart, end: nameEnd }, args }, children }
  }

  // `snippet feature(title: string)`, its parameters read as a function's, the lines below it the markup it returns.
  private parseSnippet(indent: number): SnippetNode | undefined {
    const start = this.pos

    this.pos += 'snippet'.length
    this.skipSpaces()
    BRANCH_NAME.lastIndex = this.pos
    const match = BRANCH_NAME.exec(this.src)

    if (!match) {
      this.error(start, this.scan.lineEnd(start), 'A snippet needs a name', { help: SNIPPET_HELP })
      this.skipChildren(indent)

      return undefined
    }

    const nameStart = this.pos
    const nameEnd = nameStart + match[0].length
    const name = { start: nameStart, end: nameEnd }
    let params: Span

    if (RESERVED_WORDS.has(match[0]) || STRICT_RESERVED_WORDS.has(match[0]))
      this.error(nameStart, nameEnd, `\`${match[0]}\` is a reserved word, so it cannot name a snippet`, { help: SNIPPET_HELP })

    this.pos = nameEnd

    if (this.src[this.pos] === '(') {
      const close = this.scan.balanced(this.pos)

      params = { start: this.pos + 1, end: close - 1 }
      this.pos = close
    }
    else {
      params = { start: nameEnd, end: nameEnd }
    }

    this.expectLineEnd('Nothing may follow the parameters of a snippet on its line', { help: SNIPPET_HELP })
    const children = this.parseBlock(indent)

    if (children.length === 0) {
      this.error(start, this.scan.lineEnd(start), 'A snippet needs lines below it', { help: SNIPPET_HELP })

      return undefined
    }

    return { kind: 'snippet', start, end: this.lastContentEnd(), name, params, children }
  }

  private parseSlot(indent: number): SlotNode {
    const start = this.pos

    SLOT_NAME.lastIndex = start
    const match = SLOT_NAME.exec(this.src)

    if (!match) {
      this.error(start, start + 1, 'Expected a slot name after `@`, such as `@fallback`')
      this.pos = this.scan.lineEnd(start)

      return { kind: 'slot', start, end: this.pos, name: { start, end: start + 1 }, children: this.parseBlock(indent) }
    }

    const name = { start: start + 1, end: start + match[0].length }

    let params: Span | undefined

    this.pos = name.end

    if (this.src[this.pos] === '(') {
      const close = this.scan.balanced(this.pos)

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

  private parseBranch(testStart: number, indent: number): IfBranch {
    const start = this.pos

    this.pos = testStart
    this.skipSpaces()
    const test = this.scanToLineEnd()

    if (test.start === test.end)
      this.error(start, test.end, 'Expected a condition')

    const alias = this.alias(test)
    const children = this.parseBlock(indent)

    return { start, end: this.lastContentEnd(), test, alias, children }
  }

  // `if user() as u` names the value it tests: a last `as` outside brackets, after the whole condition whatever operators it holds, then a name.
  // TypeScript reads it as a cast to a type of that name, so a type it spells any other way stays a cast: a capitalized name, `as string`, `as const` or `as Box<T>`. Found, it is cut off the end of `test`.
  private alias(test: Span): Span | undefined {
    const at = MAY_ALIAS.test(this.src.slice(test.start, test.end)) ? this.lastAs(test) : undefined

    if (at === undefined)
      return undefined

    let cast: t.Expression

    try {
      cast = parseExpression(`${CAST}${this.src.slice(at + 2, test.end)}`, { plugins: ['typescript'] })
    }
    catch {
      return undefined
    }

    const type = cast.type === 'TSAsExpression' && cast.typeAnnotation.type === 'TSTypeReference' && !cast.typeAnnotation.typeParameters ? cast.typeAnnotation.typeName : undefined

    if (type?.type !== 'Identifier' || type.name === 'const' || CAPITALIZED_NAME.test(type.name))
      return undefined

    // The parsed text starts with `_ as` where the source has `as`.
    const shift = at + 2 - CAST.length
    let end = at

    while (end > test.start && WHITESPACE.test(this.src[end - 1]!))
      end--

    test.end = end

    return { start: type.start! + shift, end: type.end! + shift }
  }

  // Where the last ` as ` of `span` starts outside its brackets, strings, template literals, regex literals and comments.
  private lastAs({ start, end }: Span): number | undefined {
    const { src, quiet } = this
    let found: number | undefined
    let i = start

    while (i < end) {
      const char = src[i]!

      if (char === '"' || char === '\'') {
        i = quiet.string(i, char)
      }
      else if (char === '`') {
        i = quiet.template(i)
      }
      else if (char === '/' && src[i + 1] === '/') {
        break
      }
      else if (char === '/' && src[i + 1] === '*') {
        i = quiet.blockComment(i)
      }
      else if (char === '/' && quiet.regex(start, i) !== -1) {
        i = quiet.regex(start, i)
      }
      else if (char === '{' || char === '(' || char === '[') {
        i = quiet.balanced(i)
      }
      else {
        if (i > start && src.startsWith('as', i) && WHITESPACE.test(src[i - 1]!) && WHITESPACE.test(src[i + 2] ?? ''))
          found = i

        i++
      }
    }

    return found
  }

  // Only `when` lines and a last `else` sit in a `match`, each holding the markup of its case.
  private parseMatch(indent: number): MatchNode {
    const start = this.pos

    this.pos = start + 'match'.length
    this.skipSpaces()
    const subject = this.scanToLineEnd()
    const node: MatchNode = { kind: 'match', start, end: subject.end, subject, cases: [] }
    let blockIndent = -1

    if (subject.start === subject.end)
      this.error(start, subject.end, 'Expected the value to match', { help: '`match post.status`' })

    while (true) {
      this.skipBlankLines()

      if (this.pos >= this.src.length)
        break

      const lineIndent = this.measureIndent()

      if (lineIndent <= indent)
        break

      if (blockIndent === -1)
        blockIndent = lineIndent
      else if (lineIndent !== blockIndent)
        this.error(this.pos, this.pos + lineIndent, 'Inconsistent indentation', { label: `expected ${blockIndent} spaces, found ${lineIndent}`, note: 'the first line of a block sets its indentation' })

      this.pos += lineIndent
      const lineStart = this.pos

      COMMENT_HEAD.lastIndex = lineStart

      if (COMMENT_HEAD.test(this.src)) {
        this.skipLine(lineIndent)

        continue
      }

      MATCH_LINE.lastIndex = lineStart
      const word = MATCH_LINE.exec(this.src)?.[1]

      if (word === undefined || node.fallback) {
        this.skipLine(lineIndent, { message: word === undefined ? 'A `match` holds `when` lines and a last `else`' : '`else` comes last in a `match`' })

        continue
      }

      this.pos = lineStart + word.length

      if (word === 'else') {
        this.expectLineEnd('`else` takes no value in a `match`')
        node.fallback = { start: lineStart, end: lineStart, children: this.parseBlock(lineIndent) }
        node.fallback.end = this.lastContentEnd()
      }
      else {
        this.skipSpaces()
        const { test, values } = this.scanValues()

        node.cases.push({ start: lineStart, end: test.end, test, values, children: this.parseBlock(lineIndent) })
        node.cases.at(-1)!.end = this.lastContentEnd()
      }

      node.end = this.lastContentEnd()
    }

    if (node.cases.length === 0)
      this.error(start, subject.end, '`match` has no `when` line', { help: 'one `when \'draft\'` line per case below it, then an optional `else`' })

    return node
  }

  // A `when` line's values, split at its top-level commas.
  private scanValues(): { test: Span, values: Span[] } {
    const test = this.scanToLineEnd()
    const values: Span[] = []
    let from = test.start
    let i = test.start

    while (i <= test.end) {
      const char = this.src[i]

      if (i === test.end || char === ',') {
        let start = from
        let end = i

        while (start < end && WHITESPACE.test(this.src[start]!))
          start++

        while (end > start && WHITESPACE.test(this.src[end - 1]!))
          end--

        if (start === end)
          this.error(from, Math.max(i, from + 1), 'Expected a value', { help: '`when \'draft\'`, or `when \'published\', \'scheduled\'`' })
        else
          values.push({ start, end })

        from = ++i

        continue
      }

      if (char === '"' || char === '\'')
        i = this.scan.string(i, char)
      else if (char === '`')
        i = this.scan.template(i)
      else if (char === '{' || char === '(' || char === '[')
        i = this.scan.balanced(i)
      else if (char === '/' && this.scan.regex(test.start, i) !== -1)
        i = this.scan.regex(test.start, i)
      else
        i++
    }

    return { test, values }
  }

  private attachElse(indent: number, previous: Node | undefined, hasTest: boolean) {
    const start = this.pos

    if (previous?.kind === 'if' && !previous.fallback) {
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

      previous.fallback = { start, end: this.lastContentEnd(), children }
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

    this.skipLine(indent, { message: '`else` must directly follow an `if`, an `else if` or a `for` at the same indentation' })
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

  private parsePending(indent: number): PendingNode {
    const start = this.pos

    this.pos = start + 'pending'.length
    this.expectLineEnd('`pending` takes nothing on its line', { help: 'put its block below it, indented' })

    const children = this.parseBlock(indent)

    return { kind: 'pending', start, end: this.lastContentEnd(), children }
  }

  // `then name` directly follows an `await`, and `catch error` its `then` or a `try`; both names are optional.
  private attachAwaitBranch(indent: number, previous: Node | undefined, word: 'then' | 'catch') {
    const start = this.pos
    const valid = previous?.kind === 'try' ? word === 'catch' && !previous.rejected : previous?.kind === 'await' && (word === 'then' ? !previous.resolved : previous.resolved !== undefined && !previous.rejected)

    if (!valid || !previous || (previous.kind !== 'try' && previous.kind !== 'await')) {
      this.error(start, this.scan.lineEnd(start), word === 'then' ? '`then` must directly follow an `await` at the same indentation' : '`catch` must directly follow a `try`, or the `then` of an `await`, at the same indentation')
      this.pos = this.scan.lineEnd(start)
      this.skipChildren(indent)

      return
    }

    this.pos = start + word.length
    this.skipSpaces()
    BRANCH_NAME.lastIndex = this.pos
    const name = this.atLineEnd() ? null : BRANCH_NAME.exec(this.src)
    const alias = name ? { start: this.pos, end: this.pos + name[0].length } : undefined

    if (alias)
      this.pos = alias.end

    this.expectLineEnd(`\`${word}\` takes one name at most`, { help: `\`${word} ${word === 'then' ? 'value' : 'error'}\`` })
    const children = this.parseBlock(indent)
    const branch: AwaitBranch = { start, end: this.lastContentEnd(), alias, children }

    if (previous.kind === 'try')
      previous.rejected = branch
    else
      previous[word === 'then' ? 'resolved' : 'rejected'] = branch

    previous.end = branch.end
  }

  private parseFor(indent: number): ForNode {
    const start = this.pos

    FOR_HEAD.lastIndex = start
    const head = FOR_HEAD.exec(this.src)
    const end = this.scan.lineEnd(start)
    const itemIndices = head?.indices?.[1]

    if (!head || !itemIndices) {
      this.error(start, end, 'Malformed `for`', { help: '`for <item> of <list>`, or `for <item>, <index> of <list>`, then `key={<key>}` when rows are not matched by `item.id`' })
      this.pos = end

      return { kind: 'for', start, end, item: { start, end: start }, each: { start, end: start }, children: this.parseBlock(indent) }
    }

    const item = { start: itemIndices[0], end: itemIndices[1] }
    const indexIndices = head.indices?.[2]
    const index = indexIndices ? { start: indexIndices[0], end: indexIndices[1] } : undefined

    this.pos = start + head[0].length
    const each = this.scanToLineEnd(true)
    let key: Span | undefined

    KEY_ATTRIBUTE.lastIndex = each.end
    const keyMatch = KEY_ATTRIBUTE.exec(this.src)

    if (keyMatch) {
      const open = each.end + keyMatch[0].length - 1
      const close = this.scan.balanced(open)

      key = { start: open + 1, end: close - 1 }
      this.pos = close
      this.expectLineEnd('Nothing may follow `key={...}`')
    }

    const children = this.parseBlock(indent)

    return { kind: 'for', start, end: this.lastContentEnd(), item, index, each, key, children }
  }

  private parseError(indent: number): ErrorNode {
    const start = this.pos
    const classes: Span[] = []

    this.pos += 'error'.length

    while (this.src[this.pos] === '.') {
      const end = this.readClassName()

      if (end === undefined) {
        this.error(this.pos, this.pos + 1, 'Expected a class name after `.`')
        this.pos++

        break
      }

      classes.push({ start: this.pos + 1, end })
      this.pos = end
    }

    this.skipSpaces()

    let field: Span | undefined
    let name = ''

    if (!this.atLineEnd()) {
      FIELD_NAME.lastIndex = this.pos
      const match = FIELD_NAME.exec(this.src)

      if (match) {
        field = { start: this.pos, end: this.pos + match[0].length }
        name = match[0][0] === '"' || match[0][0] === '\'' ? match[0].slice(1, -1) : match[0]
        this.pos = field.end
      }
    }

    const end = field?.end ?? classes.at(-1)?.end ?? start + 'error'.length

    this.expectLineEnd('An `error` line names one field', { help: ERROR_HELP })
    this.rejectChildren(indent, 'An `error` line has no children: it shows the message the action gives')

    return { kind: 'error', start, end, classes, field, name }
  }

  private parseConst(indent: number): ConstNode | undefined {
    const start = this.pos
    const lineEnd = this.scan.lineEnd(start)

    this.pos += 'const'.length
    this.skipSpaces()

    const patternStart = this.pos
    let pattern: Span | undefined

    if (this.src[this.pos] === '{' || this.src[this.pos] === '[') {
      this.pos = this.scan.balanced(this.pos)
      pattern = { start: patternStart, end: this.pos }
    }
    else {
      CONST_NAME.lastIndex = this.pos
      const name = CONST_NAME.exec(this.src)

      if (name) {
        this.pos += name[0].length
        pattern = { start: patternStart, end: this.pos }
      }
    }

    this.skipSpaces()

    if (!pattern || this.src[this.pos] !== '=' || this.src[this.pos + 1] === '=') {
      this.error(start, lineEnd, 'Malformed `const`', { help: CONST_HELP })
      this.pos = lineEnd
      this.skipChildren(indent)

      return undefined
    }

    this.pos++
    this.skipSpaces()
    const value = this.scanToLineEnd()

    if (value.start === value.end) {
      this.error(start, lineEnd, 'A `const` needs a value', { help: CONST_HELP })
      this.skipChildren(indent)

      return undefined
    }

    this.rejectChildren(indent, 'A `const` line has no children: the lines after it at its indentation read its name')

    return { kind: 'const', start, end: value.end, pattern, value }
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
      const word = KEYWORD.exec(this.src)?.[0]

      if (word !== undefined) {
        this.error(this.pos, this.pos + word.length, `\`${word}\` starts a line of its own`, { help: `put it on the next line, indented under <${name}>` })
        this.pos = this.scan.lineEnd(this.pos)
        this.target = element

        return element
      }

      const child = this.parseElement(this.pos, terminator)

      if (child) {
        element.children.push(child)
        element.end = child.end
      }
      else {
        this.error(this.pos, this.scan.lineEnd(this.pos), 'Expected an element after `: `')
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
      this.error(this.pos, this.scan.lineEnd(this.pos), `Unexpected \`${next}\` after <${name}>`, { help: name === 'key' && next === '=' ? 'a `for`\'s key goes on the `for` line: `for todo of todos key={todo.slug}`' : `inline text needs a space before it: \`${name} Hello\`` })
      this.pos = this.scan.lineEnd(this.pos)
    }

    this.target = element

    return element
  }

  private parseShorthand(element: ElementNode) {
    while (true) {
      const char = this.src[this.pos]

      if (char !== '.' && char !== '#')
        return

      let end: number | undefined

      if (char === '.') {
        end = this.readClassName()
      }
      else {
        ID_NAME.lastIndex = this.pos + 1
        end = ID_NAME.test(this.src) ? ID_NAME.lastIndex : undefined
      }

      if (end === undefined) {
        this.error(this.pos, this.pos + 1, char === '.' ? 'Expected a class name after `.`' : 'Expected an id after `#`')
        this.pos++

        return
      }

      // A colon followed by a space ends the shorthand and opens block expansion (`li: a`); `md:flex` keeps it.
      if (char === '.' && this.src[end - 1] === ':' && (this.src[end] === ' ' || this.atLineEnd(end)))
        end--

      const span = { start: this.pos + 1, end }

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

  // The end of the class named after the `.` at the cursor, or undefined when none follows it.
  private readClassName(): number | undefined {
    const start = this.pos + 1
    const { end, unclosed } = scanClassName(this.src, start)

    if (unclosed)
      this.error(unclosed.at, unclosed.at + 1, `Unclosed \`${unclosed.group}\` in a class`, { help: 'close the group before any space: a space inside a Tailwind value is written `_`' })

    return end > start ? end : undefined
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
        const end = this.scan.balanced(this.pos)
        const inner = this.src.slice(this.pos + 1, end - 1)
        const spreadAt = inner.indexOf('...')

        if (spreadAt === -1 || inner.slice(0, spreadAt).trim() !== '') {
          const shorthand = this.parseBareAttribute(this.pos, end)

          if (shorthand)
            element.attributes.push(shorthand)
          else
            element.attributes.push({ kind: 'spread', expression: { start: this.pos + 1, end: end - 1 } })

          this.pos = end

          continue
        }

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

      MODIFIERS.lastIndex = this.pos
      const modifiers = MODIFIERS.exec(this.src)
      const modified = modifiers ? { start: this.pos, end: this.pos + modifiers[0].length } : undefined

      if (modified)
        this.pos = modified.end

      const attribute = this.parseAttributeValue(name)

      if (modified && attribute.kind === 'expression')
        attribute.modifiers = modified
      else if (modified)
        this.error(modified.start, modified.end, 'A modifier belongs to an event handler written `onSubmit|preventDefault={save}`')

      element.attributes.push(attribute)
    }
  }

  // `{title}` for `title={title}`, from the brace at `open` to `end`. Anything else braced is reported, with the written-out form when the last name of a member chain can stand for the attribute.
  private parseBareAttribute(open: number, end: number): Attribute | undefined {
    const inner = this.src.slice(open + 1, end - 1)
    const trimmed = inner.trim()
    const start = open + 1 + inner.indexOf(trimmed)
    const name = { start, end: start + trimmed.length }

    if (SHORTHAND_NAME.test(trimmed) && !RESERVED_WORDS.has(trimmed))
      return { kind: 'expression', name, expression: name, shorthand: { start: open, end } }

    if (RESERVED_WORDS.has(trimmed)) {
      this.error(open, end, `\`${trimmed}\` is a reserved word, so no variable has that name`, { help: `\`${trimmed}={value}\`` })

      return undefined
    }

    const last = MEMBER_CHAIN.exec(trimmed)?.[1]

    this.error(open, end, 'A braced attribute is the name of a variable, or a spread', { help: last === undefined ? '`name={expression}`, or `{...props}`' : `\`${last}={${trimmed}}\`` })

    return undefined
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

      // A long list of classes may run over several lines, which render as single spaces, when its opening quote ends a line: a quote forgotten on a line still reports at once.
      LINE_BREAK_AFTER.lastIndex = this.pos + 1

      const spansLines = this.src.slice(name.start, name.end) === 'class' && LINE_BREAK_AFTER.test(this.src)

      if (end === -1 || (end > this.scan.lineEnd(this.pos) && !spansLines)) {
        this.error(this.pos, this.pos + 1, 'Unclosed string')
        this.pos = this.src.length

        return { kind: 'boolean', name }
      }

      const value = { start: this.pos + 1, end }
      const text = this.src.slice(value.start, value.end)

      this.pos = end + 1

      return { kind: 'static', name, value, text: spansLines && text.includes('\n') ? text.trim().replaceAll(WHITESPACE_RUN, ' ') : text }
    }

    if (quote === '{') {
      const end = this.scan.balanced(this.pos)
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
        const end = this.scan.balanced(this.pos)
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
        i = this.scan.string(i, char)

        continue
      }

      if (char === '`') {
        i = this.scan.template(i)

        continue
      }

      if (char === '/') {
        const end = this.scan.regex(start, i)

        if (end !== -1) {
          i = end

          continue
        }
      }

      if (char === '{' || char === '(' || char === '[') {
        i = this.scan.balanced(i)

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
      const end = this.scan.lineEnd(this.pos)

      if (this.src.slice(this.pos, end).trim() !== '')
        return

      this.pos = end < this.src.length ? end + 1 : end
    }
  }

  // Skips the lines indented deeper than `indent`, leaving the cursor on the next line that is not.
  private skipChildren(indent: number) {
    let lineStart = this.scan.lineEnd(this.pos) + 1

    while (lineStart < this.src.length) {
      const end = this.scan.lineEnd(lineStart)

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
      this.error(this.pos, this.scan.lineEnd(this.pos), message, details)
      this.pos = this.scan.lineEnd(this.pos)
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
