import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const SCHEDULE = /\bschedule\b/
const FROM_KAY = (source: string) => source === 'kay' || source === 'kay/server'
const HELP = 'write `timeZone`'

// `tz` in the options of `schedule()`, `timeZone` since 1.98, the name of the config's setting it falls back to.
// Found on a call of `schedule` imported from `kay` or `kay/server`, in an options object written in the call; `{ tz }` becomes `timeZone: tz`, and an object that already holds a `timeZone` is reported with no fix.
export async function scheduleTz(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-schedule-tz', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-schedule-tz', SCHEDULE, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const { locals, namespaces } = importsOf(ast, FROM_KAY, 'schedule')

      if (locals.size === 0 && namespaces.size === 0)
        continue

      const isSchedule = (callee: Node): boolean => callee.type === 'Identifier'
        ? locals.has(callee.name)
        : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'schedule'

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || !isSchedule(node.callee))
          return

        for (const argument of node.arguments.slice(1)) {
          if (argument.type !== 'ObjectExpression')
            continue

          const tz = argument.properties.find((property): property is Extract<typeof property, { type: 'Property' }> => property.type === 'Property' && keyName(property) === 'tz')

          if (!tz)
            continue

          const taken = argument.properties.some(property => property.type === 'Property' && keyName(property) === 'timeZone')
          const renamed = tz.shorthand ? { start: base + tz.start, end: base + tz.end, text: 'timeZone: tz' } : { start: base + tz.key.start, end: base + tz.key.end, text: 'timeZone' }
          const edits = taken || tz.computed ? null : [renamed]

          report(base + tz.start, base + tz.end, '`tz` of `schedule()` is deprecated since 1.98: the option is `timeZone`, as in kay.config.ts, which it falls back to', HELP, edits)
        }
      })
    }
  })
}
