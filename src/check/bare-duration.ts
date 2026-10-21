import type { CheckDiagnostic } from '.'
import type { LintLevels } from '../compiler/lints'
import { lintLevels } from '../compiler/lints'
import { offsetAt, positionAt } from '../compiler/mapping'
import { tsgoCode } from './tsgo'

// Not assignable: a property, an argument or a variable.
const DURATION_ERROR_CODES = new Set([2322, 2345, 2769])
// How tsgo prints the `Duration` type: the template literals of its units, which no other type of kay's spells out.
const DURATION_TYPE = /`\$\{number\}ms`.*`\$\{number\}w`/s
// Where the value of the property or attribute the error stands on begins: past its name, a `:` or `=` and an opening `{`.
const WORD_CHAR = /[\w$]/
const VALUE_START = /^(?:[\w$]+\s*[:=]\s*\{?\s*)?/
// A whole literal: one followed by an operator is the start of an expression, which only a person can rewrite.
const NUMBER = /^\d[\d_]*(?:\.\d+)?(?=\s*(?:[,)}\]\n;]|$|\/\/))/
// What the calls that took milliseconds before 1.70 are named, and a `toast` method: a number inside one of these is milliseconds.
const MS_CALLS = new Set(['click', 'hover', 'waitFor', 'waitUntil', 'waitForResponse', 'hit', 'open', 'testSite', 'browse'])
// `outbox.waitFor` of kayjs-mail and kayjs-auth's `attempts.hit` took seconds, where the helpers of the same names took milliseconds.
const SECONDS_OWNER = /outbox|attempts/i
// A `hit` is milliseconds on a kay rate store and seconds on kayjs-auth's attempts store, and only a receiver named for one of them tells which.
const RATE_RECEIVER = /rate\w*\s*(?:\([^()]*\))?$/i
const TRAILING_DOT = /\.\s*$/
const TOAST_CALLS = new Set(['error', 'success', 'info'])
const CALLEE = /([\w$]+)(?:\s*\.\s*([\w$]+))?$/
// How far back the enclosing calls are looked for.
const REACH = 600

// The calls a position sits in, innermost first, as their last two names (`toast.error`, `page.click`).
function enclosingCalls(source: string, offset: number): [string | undefined, string, string][] {
  const calls: [string | undefined, string, string][] = []
  let depth = 0

  for (let at = offset - 1; at >= Math.max(0, offset - REACH); at--) {
    const char = source[at]

    if (char === ')' || char === ']' || char === '}') {
      depth++
    }
    else if (char === '(' || char === '[' || char === '{') {
      if (depth > 0) {
        depth--
      }
      else if (char === '(') {
        const head = source.slice(Math.max(0, at - 80), at).trimEnd()
        const callee = CALLEE.exec(head)

        if (callee)
          calls.push([callee[2] === undefined ? undefined : callee[1], callee[2] ?? callee[1]!, head.slice(0, head.length - callee[0].length).replace(TRAILING_DOT, '')])
      }
    }
  }

  return calls
}

// Whether the position is in a toast's options, the unit its number was read in (milliseconds in a browser test's wait or a toast, seconds anywhere else), and whether that unit is a guess: a `hit` on a receiver not known to be a rate store or an attempts store.
function contextAt(source: string, offset: number): { toast: boolean, unit: 'ms' | 's', guessed: boolean } {
  const calls = enclosingCalls(source, offset)
  const toast = calls.some(([owner, name]) => TOAST_CALLS.has(name) && owner === 'toast')
  const call = calls.find(([owner, name]) => MS_CALLS.has(name) && !SECONDS_OWNER.test(owner ?? ''))
  const guessed = !toast && call !== undefined && call[1] === 'hit' && !RATE_RECEIVER.test(call[2])

  return { toast, unit: toast || call ? 'ms' : 's', guessed }
}

// A type error on a bare number where a `Duration` goes, as the deprecation of the form before 1.70, with the fix that writes the number with its unit.
// Only a literal is rewritten; any other expression keeps the type error, which says what it takes.
export async function bareDuration(diagnostic: CheckDiagnostic, levels: LintLevels | undefined): Promise<CheckDiagnostic> {
  if (!DURATION_ERROR_CODES.has(tsgoCode(diagnostic) ?? 0) || !DURATION_TYPE.test(diagnostic.message))
    return diagnostic

  let source: string

  try {
    source = await Bun.file(diagnostic.file).text()
  }
  catch {
    return diagnostic
  }

  const asked = offsetAt(source, diagnostic)
  const start = asked + VALUE_START.exec(source.slice(asked))![0].length
  const literal = NUMBER.exec(source.slice(start))?.[0]
  const { toast, unit, guessed } = contextAt(source, start)
  const infinite = toast && source.startsWith('Infinity', start) && !WORD_CHAR.test(source[start + 8] ?? '')

  if (literal === undefined && !infinite)
    return diagnostic

  const level = lintLevels(source, levels)('deprecated-bare-duration', start)

  if (level === 'allow')
    return diagnostic

  const end = start + (literal ?? 'Infinity').length
  const written = infinite ? 'false' : `'${literal!.replaceAll('_', '')}${unit}'`

  return {
    ...diagnostic,
    end,
    ...positionAt(source, start),
    code: 'deprecated-bare-duration',
    severity: level === 'warn' ? 'warning' : 'error',
    message: `\`${source.slice(start, end)}\` is a bare number where a duration goes: it stood for ${infinite ? 'a toast that stays' : `${literal} ${unit === 'ms' ? 'milliseconds' : 'seconds'}`} before 1.70, and a duration is written with its unit now`,
    help: guessed ? `write ${written} if this is a kay rate store (milliseconds), or the seconds of an attempts store as '${literal}s'` : `write ${written}`,
    fixes: [{ title: `Write ${written}`, edits: [{ start, end, text: written }], safe: !guessed }],
  }
}
