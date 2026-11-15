import type { CheckDiagnostic, CheckOptions } from '.'
import type { NodeOfType } from '../compiler/estree'
import type { Property } from './regroup'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { configObjects, propertiesOf, propertyOf } from './config-objects'
import { scan } from './renamed-exports'

type ObjectExpression = NodeOfType<'ObjectExpression'>

const NEEDLE = /\b(?:onStart|observe)\b/
const PUNCTUATION = /^[\s,]*$/

// Where the property `onError` of `observe` goes: beside it, or in its place when it was the only key.
function movedOnError(root: ObjectExpression, observe: Property, object: ObjectExpression, onError: Property, text: string, base: number): Edit[] | undefined {
  if (propertyOf(root, 'onError') !== undefined || object.properties.some(property => property.type !== 'Property'))
    return undefined

  const written = text.slice(onError.start, onError.end)

  if (object.properties.length === 1)
    return [{ start: base + observe.start, end: base + observe.end, text: written }]

  const at = object.properties.indexOf(onError)
  const after = object.properties[at + 1]
  const [from, to] = after === undefined ? [object.properties[at - 1]!.end, onError.end] : [onError.start, after.start]
  // A comment between the keys would be lost with the property.
  const between = after === undefined ? text.slice(from, onError.start) : text.slice(onError.end, to)

  if (!PUNCTUATION.test(between))
    return undefined

  return [{ start: base + observe.start, end: base + observe.start, text: `${written}, ` }, { start: base + from, end: base + to, text: '' }]
}

// `log` of `observe` as a group: `'json'` is `{ format: 'json' }` and a function written in place `{ sink }`.
function groupedLog(log: Property, text: string, base: number): { edits: Edit[], now: string } | undefined {
  const { value } = log

  if (value.type === 'Literal' && value.value === 'json')
    return { edits: [{ start: base + value.start, end: base + value.end, text: '{ format: \'json\' }' }], now: '{ format: \'json\' }' }

  if (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression')
    return { edits: [{ start: base + value.start, end: base + value.end, text: `{ sink: ${text.slice(value.start, value.end)} }` }], now: '{ sink }' }

  return undefined
}

// The hooks and the log of kay.config.ts, and of the options of `pages()` and `testSite()`, written before 1.105: `onStart` is `onListen`, `observe.onError` is `onError` beside `observe`, and `observe.log` as `'json'` or a function is `{ format: 'json' }` or `{ sink }`.
export async function appHooks(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-app-hooks', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-app-hooks', NEEDLE, ({ file, parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      for (const { object } of configObjects(file, ast)) {
        const [start] = propertiesOf(object, 'onStart')

        if (start !== undefined && !start.method && start.kind === 'init') {
          const taken = propertyOf(object, 'onListen') !== undefined
          const edits: Edit[] = taken ? [] : [start.shorthand ? { start: base + start.start, end: base + start.end, text: 'onListen: onStart' } : { start: base + start.key.start, end: base + start.key.end, text: 'onListen' }]

          report(base + start.start, base + start.end, '`onStart` of the config is deprecated since 1.105: the hook that runs when the server listens is `onListen`, `onStart` naming where a job begins', 'write `onListen`', edits)
        }

        const ops = propertyOf(object, 'ops')
        const inOps = ops?.value.type === 'ObjectExpression' ? propertyOf(ops.value, 'observe') : undefined

        // The `onError` of an `observe` inside `ops` is reported with no fix: it moves to the top of the config, beside `ops`, which the fix of `observe` does not reach.
        for (const [observe, nested] of [[propertyOf(object, 'observe'), false], [inOps, true]] as const) {
          const group = observe?.value.type === 'ObjectExpression' ? observe.value : undefined

          if (observe === undefined || group === undefined)
            continue

          const [onError] = propertiesOf(group, 'onError')
          const [log] = propertiesOf(group, 'log')

          if (onError !== undefined)
            report(base + onError.start, base + onError.end, '`observe.onError` is deprecated since 1.105: the hooks are flat keys of the config, named by the moment they run', nested ? 'write `onError` beside `ops`' : 'write `onError` beside `observe`', nested ? null : movedOnError(object, observe, group, onError, text, base) ?? null)

          const grouped = log === undefined || log.shorthand ? undefined : groupedLog(log, text, base)

          if (log !== undefined && grouped !== undefined)
            report(base + log.value.start, base + log.value.end, '`observe.log` as `\'json\'` or a function is deprecated since 1.105: it is `{ format, requests, sink }`', `write \`${grouped.now}\``, grouped.edits)
        }
      }
    }
  })
}
