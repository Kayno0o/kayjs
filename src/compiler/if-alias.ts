import type { Diagnostic, Span } from './ast'
import type { Scanner } from './scanner'

// What a condition naming its value holds: `then name`.
const MAY_THEN = /\sthen(?:\s|$)/
const THEN_NAME = /^then(?:[ \t]+([\p{L}_$][\p{L}\p{M}\p{N}_$]*))?[ \t]*(?:\/\/.*)?$/du
// Words that are no name for a value.
const RESERVED = new Set(['null', 'true', 'false', 'this', 'class', 'await', 'in', 'as', 'of', 'new', 'typeof', 'void', 'delete', 'function', 'return', 'if', 'else', 'const', 'let', 'var', 'yield', 'import', 'export', 'default', 'super', 'switch', 'case', 'for', 'while', 'do', 'try', 'catch', 'finally', 'throw', 'with', 'break', 'continue', 'instanceof', 'enum', 'extends', 'debugger', 'static', 'interface', 'implements', 'package', 'private', 'protected', 'public'])
const WHITESPACE = /\s/

// `if user() then u` names the value it tests: a last `then` outside brackets, after the whole condition whatever operators it holds, then one name.
// Found, the alias is cut off the end of `test` and returned, with what to report.
export function ifAlias(src: string, quiet: Scanner, test: Span): { alias?: Span, diagnostics: Diagnostic[] } {
  const text = src.slice(test.start, test.end)
  const thenAt = MAY_THEN.test(text) ? lastWord(src, quiet, test, 'then') : undefined

  return thenAt === undefined ? { diagnostics: [] } : thenAlias(src, test, thenAt)
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
