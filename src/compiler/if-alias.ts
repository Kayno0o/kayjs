import type { Diagnostic, Span } from './ast'
import type { Expression } from './estree'
import type { Scanner } from './scanner'
import { parseExpression } from './estree'

// What a condition naming its value holds: `then name` since 1.102, and before it an `as` that may as well be a cast.
const MAY_ALIAS = /\sas\s/
const MAY_THEN = /\sthen(?:\s|$)/
const THEN_NAME = /^then(?:[ \t]+([\p{L}_$][\p{L}\p{N}_$]*))?[ \t]*(?:\/\/.*)?$/du
// Words that are no name for a value.
const RESERVED = new Set(['null', 'true', 'false', 'this', 'class', 'await', 'in', 'as', 'of', 'new', 'typeof', 'void', 'delete', 'function', 'return', 'if', 'else', 'const', 'let', 'var', 'yield', 'import', 'export', 'default', 'super', 'switch', 'case', 'for', 'while', 'do', 'try', 'catch', 'finally', 'throw', 'with', 'break', 'continue', 'instanceof', 'enum', 'extends', 'debugger'])
// A capitalized name after a condition's `as` is a type, so a cast.
const CAPITALIZED_NAME = /^[\p{Lu}\p{Lt}]/u
// What the tail of a condition is parsed behind, as the type of a cast.
const CAST = '_ as'
const WHITESPACE = /\s/

// `if user() then u` names the value it tests: a last `then` outside brackets, after the whole condition whatever operators it holds, then one name.
// Before 1.102 it was a last `as` followed by a lowercase name, which TypeScript reads as a cast to a type of that name, so a type it spells any other way stays a cast: a capitalized name, `as string`, `as const` or `as Box<T>`; that spelling is the `deprecated-if-alias` lint.
// Found, the alias is cut off the end of `test` and returned, with what to report.
export function ifAlias(src: string, quiet: Scanner, test: Span): { alias?: Span, diagnostics: Diagnostic[] } {
  const text = src.slice(test.start, test.end)
  const thenAt = MAY_THEN.test(text) ? lastWord(src, quiet, test, 'then') : undefined

  if (thenAt !== undefined)
    return thenAlias(src, test, thenAt)

  const asAt = MAY_ALIAS.test(text) ? lastWord(src, quiet, test, 'as') : undefined

  return asAt === undefined ? { diagnostics: [] } : asAlias(src, test, asAt)
}

function thenAlias(src: string, test: Span, at: number): { alias?: Span, diagnostics: Diagnostic[] } {
  const tail = THEN_NAME.exec(src.slice(at, test.end))
  // The end of the line, where the error stops once `test` is cut before the `then`.
  const lineEnd = test.end

  test.end = trimEnd(src, test.start, at)

  if (tail?.[1] === undefined || RESERVED.has(tail[1]))
    return { diagnostics: [{ start: at, end: lineEnd, message: '`then` takes one name after a condition', help: '`if user() then u`' }] }

  const [from, to] = tail.indices![1]!

  return { alias: { start: at + from, end: at + to }, diagnostics: [] }
}

function asAlias(src: string, test: Span, at: number): { alias?: Span, diagnostics: Diagnostic[] } {
  let cast: Expression

  try {
    cast = parseExpression(`${CAST}${src.slice(at + 2, test.end)}`, { lang: 'ts' })
  }
  catch {
    return { diagnostics: [] }
  }

  const type = cast.type === 'TSAsExpression' && cast.typeAnnotation.type === 'TSTypeReference' && !cast.typeAnnotation.typeArguments ? cast.typeAnnotation.typeName : undefined

  if (type?.type !== 'Identifier' || type.name === 'const' || CAPITALIZED_NAME.test(type.name))
    return { diagnostics: [] }

  // The parsed text starts with `_ as` where the source has `as`.
  const shift = at + 2 - CAST.length
  const keyword = { start: at, end: at + 2 }
  const lint: Diagnostic = {
    ...keyword,
    code: 'deprecated-if-alias',
    message: '`if cond as name` is `if cond then name` since 1.102: `as` is a type cast, and the lowercase type it could name was read as an alias',
    help: 'Write `then`',
    fixes: [{ title: 'Write `then`', edits: [{ ...keyword, text: 'then' }], safe: true }],
    checkOnly: true,
  }

  test.end = trimEnd(src, test.start, at)

  return { alias: { start: type.start + shift, end: type.end + shift }, diagnostics: [lint] }
}

function trimEnd(src: string, start: number, from: number): number {
  let end = from

  while (end > start && WHITESPACE.test(src[end - 1]!))
    end--

  return end
}

// Where the last ` word ` of `span` starts outside its brackets, strings, template literals, regex literals and comments.
function lastWord(src: string, quiet: Scanner, { start, end }: Span, word: string): number | undefined {
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
      if (i > start && src.startsWith(word, i) && WHITESPACE.test(src[i - 1]!) && WHITESPACE.test(src[i + word.length] ?? ' '))
        found = i

      i++
    }
  }

  return found
}
