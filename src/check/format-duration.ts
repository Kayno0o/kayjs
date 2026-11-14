import type { CheckDiagnostic, CheckOptions } from '.'
import { lintLevel } from '../compiler/lints'
import { importsOf } from './ast'
import { scan } from './renamed-exports'

const FORMAT = /\bformatDuration\b/
const FROM_I18N = (source: string) => source === 'kay/i18n'
const HELP = 'write the length with its unit, `formatDuration(\'125m\')`'
const EXPRESSION = /^\d[\d_]*(?:\.\d+)?(?:\s*[*+\-/]\s*\d[\d_]*(?:\.\d+)?)*$/
const TERMS = /\s*([*+\-/])\s*/

// The value of numbers written with `+`, `-`, `*` and `/` between them, as the language reads them; the caller checked there is nothing else.
function evaluate(text: string): number {
  const parts = text.replaceAll('_', '').split(TERMS)
  const terms = [Number(parts[0])]
  const signs: string[] = []

  for (let at = 1; at < parts.length; at += 2) {
    const sign = parts[at]!
    const value = Number(parts[at + 1])

    if (sign === '*') {
      terms[terms.length - 1]! *= value
    }
    else if (sign === '/') {
      terms[terms.length - 1]! /= value
    }
    else {
      signs.push(sign)
      terms.push(value)
    }
  }

  return terms.slice(1).reduce((sum, term, at) => signs[at] === '+' ? sum + term : sum - term, terms[0]!)
}

// A call of `formatDuration` from `kay/i18n` with a bare number, milliseconds until 1.105 and a `Duration` since: `formatDuration(7_500_000)` is `formatDuration('7500000ms')`.
// Found on a number written as a literal or as arithmetic of literals, in a fence, a module or a template; a number held in a variable is a type error the editor shows, as `kay check` reads no types here. The fix writes the value in milliseconds.
export async function formatDurationNumbers(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-format-duration', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-format-duration', FORMAT, ({ source, parsed, report }) => {
    const names = new Set<string>()

    for (const { ast } of parsed) {
      const { locals, namespaces } = importsOf(ast, FROM_I18N, 'formatDuration')

      for (const name of locals)
        names.add(name)

      for (const name of namespaces)
        names.add(`${name}\\.formatDuration`)
    }

    if (names.size === 0)
      return

    // eslint-disable-next-line regexp/no-empty-group -- the names alternation is filled in at run time
    const calls = new RegExp(String.raw`(?<![\w$.])(?:${[...names].join('|')})\(([^,()]*)(?=[,)])`, 'g')

    for (const call of source.matchAll(calls)) {
      const text = call[1]!.trim()

      if (!EXPRESSION.test(text))
        continue

      const start = call.index + call[0].length - call[1]!.length + call[1]!.indexOf(text)
      const milliseconds = evaluate(text)

      report(start, start + text.length, '`formatDuration` takes a duration with its unit since 1.105, not milliseconds', HELP, Number.isFinite(milliseconds) ? [{ start, end: start + text.length, text: `'${milliseconds}ms'` }] : null)
    }
  })
}
