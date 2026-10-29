import type { ParseResult } from '@babel/parser'
import type * as t from '@babel/types'
import type { Diagnostic, Span } from './ast'
import type { ParsedFence } from './script-shared'
import { parse } from '@babel/parser'
import { eachNode } from './each-node'
import { POSITION_SUFFIX } from './rewrite'
import { FIRST_TOKEN, KAY_NAME, WHITESPACE } from './script-shared'
import { walkScope } from './walk'

// A fence being typed breaks a handful of statements at most; more than this is not recovered.
const MAX_BROKEN = 20
// What a statement that goes on over the next line ends with.
const UNFINISHED = /[.,([{=+\-*/&|?:<>!~^%]/
// A line of a fence that begins a statement: written from its first column, and not closing or continuing the one before it.
const STATEMENT_START = /^(?![\s})\]]|else\b|catch\b|finally\b)/

// Without `blank`, the parse is the one Babel's recovery gives, its statements that do not parse left in; none is read again.
export function parseFence(source: string, span: Span, diagnostics: Diagnostic[], blank = true): ParsedFence | undefined {
  const original = source.slice(span.start, span.end)
  const broken: Span[] = []
  let code = original
  let reported = false

  // A statement Babel cannot parse, or recovers from only with an error the shadow code would not survive, is blanked and the rest parsed again: one being typed costs the editor only its own analysis.
  while (true) {
    let ast: ParseResult<t.File> | undefined
    let errors: { pos: number, message: string }[]

    try {
      ast = parse(code, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
      errors = (ast.errors ?? []).map(error => ({ pos: (error as unknown as { pos?: number }).pos ?? 0, message: error.message }))
    }
    catch (error) {
      errors = [{ pos: (error as { pos?: number }).pos ?? 0, message: (error as Error).message }]
    }

    if (!reported) {
      reported = true

      if (blank && errors.length > 0 && reportJsx(original, span, diagnostics))
        return undefined

      for (const { pos, message } of errors)
        diagnostics.push({ start: span.start + pos, end: span.start + pos + 1, code: 'fence-syntax', message: message.replace(POSITION_SUFFIX, '') })
    }

    const statements = blank && broken.length < MAX_BROKEN ? new Map(errors.flatMap(({ pos }) => brokenStatement(code, pos)).map(statement => [statement.start, statement])) : new Map<number, { start: number, end: number }>()

    if (errors.length === 0 || statements.size === 0)
      return ast && { code, offset: span.start, ast, broken, shift: node => ({ start: span.start + node.start!, end: span.start + node.end! }) }

    for (const { start, end } of statements.values()) {
      // A statement that swallows an earlier blank one replaces it.
      broken.splice(0, broken.length, ...broken.filter(known => known.start < span.start + start || known.end > span.start + end))
      broken.push({ start: span.start + start, end: span.start + end })
      code = code.slice(0, start) + code.slice(start, end).replaceAll(/\S/g, ' ') + code.slice(end)
    }

    broken.sort((a, b) => a.start - b.start)
  }
}

// The offset just after the last code before `at`, past the whitespace and the comments ending a line.
function endOfCode(code: string, starts: number[], at: number): number {
  let end = at

  while (true) {
    while (end > 0 && WHITESPACE.test(code[end - 1]!))
      end--

    const line = starts.findLastIndex(start => start < end)

    const comment = line < 0 ? -1 : lineCommentAt(code.slice(starts[line], end))

    if (comment < 0)
      return end

    end = starts[line]! + comment
  }
}

// Where the `//` comment ending a line starts, `//` inside a string not counting.
function lineCommentAt(line: string): number {
  let quote = ''

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!

    if (quote !== '') {
      if (char === '\\')
        i++
      else if (char === quote)
        quote = ''
    }
    else if (char === '\'' || char === '"' || char === '`') {
      quote = char
    }
    else if (char === '/' && line[i + 1] === '/') {
      return i
    }
  }

  return -1
}

// The top-level statement a parse error falls in, found by indentation: from the line at the first column before it, to the next one.
// The `//` comment lines just above are part of it, so a comment does not stay behind and attach to the next statement.
function brokenStatement(code: string, pos: number): { start: number, end: number }[] {
  const lines = code.split('\n')
  const starts: number[] = []
  let at = 0

  for (const line of lines) {
    starts.push(at)
    at += line.length + 1
  }

  let probe = Math.min(pos, code.length)
  const row = Math.max(0, starts.findLastIndex(start => start <= probe))
  const firstToken = FIRST_TOKEN.exec(lines[row]!)![0].length
  const inFirstToken = lines[row] !== '' && STATEMENT_START.test(lines[row]!) && probe <= starts[row]! + firstToken
  let before = inFirstToken ? starts[row]! : probe

  before = endOfCode(code, starts, before)

  // An error at the end or in blank text is the fault of the text before it, and so is one in the first word of a statement when the text before it is unfinished: `count.` then `const` reads as `count.const`.
  if (probe >= code.length || WHITESPACE.test(code[probe]!) || inFirstToken) {
    if (!inFirstToken || (before > 0 && UNFINISHED.test(code[before - 1]!)))
      probe = Math.max(0, before - 1)
  }

  let line = starts.findLastIndex(start => start <= probe)

  while (line > 0 && !STATEMENT_START.test(lines[line]!))
    line--

  while (line > 0 && lines[line - 1]!.startsWith('//'))
    line--

  let next = line + 1

  while (next < lines.length && (!STATEMENT_START.test(lines[next]!) || starts[next]! <= probe))
    next++

  const start = starts[line]!
  const end = next < lines.length ? starts[next]! : code.length

  return code.slice(start, end).trim() === '' ? [] : [{ start, end }]
}

// Markup in a fence reads as JSX, which kay never compiles: the template is the only place for it.
function reportJsx(code: string, span: Span, diagnostics: Diagnostic[]): boolean {
  let jsx: t.Node | undefined

  try {
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] })

    jsx = findJsx(ast.program)
  }
  catch {
    return false
  }

  if (!jsx)
    return false

  diagnostics.push({ start: span.start + jsx.start!, end: span.start + jsx.end!, message: 'A fence holds TypeScript, never JSX', help: 'put markup in the template, or in a component of its own' })

  return true
}

function findJsx(node: t.Node): t.Node | undefined {
  let jsx: t.Node | undefined

  eachNode(node, (inner) => {
    if (inner.type === 'JSXElement' || inner.type === 'JSXFragment')
      jsx ??= inner

    return jsx === undefined
  })

  return jsx
}

// What a statement being typed mentions as code: its comments, strings, regular expressions and object keys are no read of a name.
const OBJECT_KEY = /([{,]\s*)[\w$]+(?=\s*:)/g
// What a regular expression literal follows, where a slash is not a division.
const BEFORE_REGEX = /(?:^|[(,=:[!&|?{};])\s*$/
const REGEX_LITERAL = /^\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\//

export function codeOf(text: string): string {
  let code = ''
  // The open interpolations of template literals, each counting the braces opened inside it.
  const interpolations: number[] = []
  let i = 0

  // The end of the template text from `from`: after its closing backtick, or after the `${` opening an interpolation.
  const templateText = (from: number): number => {
    let at = from

    while (at < text.length) {
      if (text[at] === '\\') {
        at++
      }
      else if (text[at] === '`') {
        return at + 1
      }
      else if (text[at] === '$' && text[at + 1] === '{') {
        interpolations.push(0)

        return at + 2
      }

      at++
    }

    return text.length
  }

  while (i < text.length) {
    const char = text[i]!
    const regex = char === '/' && BEFORE_REGEX.test(text.slice(Math.max(0, i - 40), i)) ? REGEX_LITERAL.exec(text.slice(i)) : null
    let skipped = true

    if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)

      i = end < 0 ? text.length : end
    }
    else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)

      i = end < 0 ? text.length : end + 2
    }
    else if (char === '\'' || char === '"') {
      i++

      while (i < text.length && text[i] !== char && text[i] !== '\n')
        i += text[i] === '\\' ? 2 : 1

      i += text[i] === char ? 1 : 0
    }
    else if (char === '`') {
      i = templateText(i + 1)
    }
    else if (regex) {
      i += regex[0].length
    }
    else if (char === '}' && interpolations.at(-1) === 0) {
      interpolations.pop()
      i = templateText(i + 1)
    }
    else {
      if (interpolations.length > 0 && (char === '{' || char === '}'))
        interpolations[interpolations.length - 1]! += char === '{' ? 1 : -1

      code += char
      skipped = false
      i++
    }

    // A skipped token leaves a space, so the code around it does not join.
    if (skipped)
      code += ' '
  }

  return code.replaceAll(OBJECT_KEY, '$1')
}

// Which of `kay`'s values, `declared` aside, the fence reads with nothing in it declaring or importing them, `typed` being the code of the statements that did not parse, where a mention counts as a read, and `read` the ones the template reads.
export function undeclared(ast: ParseResult<t.File>, code: string, declared: string[], typed: string, read: readonly string[]): string[] {
  // `ctx` in a fence is the request, which only a template reading it unimported gets from `kay`.
  const written = new Set([...(typed === '' ? [code] : [code, typed]).flatMap(text => (text.match(KAY_NAME) ?? []).filter(name => name !== 'ctx')), ...read])
  const mentioned = [...written].filter(name => !declared.includes(name))
  const found: string[] = []

  if (mentioned.length === 0)
    return found

  const inTyped = new Set(typed.match(KAY_NAME) ?? [])

  const walked = walkScope(ast, {
    Program(path) {
      found.push(...mentioned.filter(name => (path.scope.globals.has(name) || inTyped.has(name) || read.includes(name)) && !path.scope.hasBinding(name)))

      return 'stop'
    },
  })

  // A fence Babel's scope refuses takes as read every name it mentions outside its strings and comments.
  if (!walked) {
    const outside = new Set([...(codeOf(code).match(KAY_NAME) ?? []), ...inTyped, ...read])

    return mentioned.filter(name => outside.has(name))
  }

  return found
}
