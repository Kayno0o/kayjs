import type { CallExpression, ObjectExpression, ObjectProperty } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { unwrapped } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

// A hook key renamed to the convention of [hooks](llms/hooks.md): `call`, imported from `source`, takes the options object as its argument number `argument` (the object under `key` of it when set).
// Each slice of #2806 adds its rows here, its `since` minor being the lint's.
export interface HookRename {
  from: string
  to: string
  call: string
  source: string
  argument: number
  key?: string
}

export const HOOK_RENAMES: readonly HookRename[] = [
  { from: 'onFailed', to: 'onError', call: 'queue', source: 'kay/server', argument: 2 },
  { from: 'onFailed', to: 'onError', call: 'workflow', source: 'kay/server', argument: 2 },
  { from: 'onFailed', to: 'onError', call: 'mailer', source: '@kaynooo/kayjs-mail', argument: 0, key: 'queue' },
]

const OLD_NAMES = new RegExp(`\\b(?:${[...new Set(HOOK_RENAMES.map(row => row.from))].join('|')})\\b`)

// A `key: value`, shorthand or method property with a name written out: not a spread, an accessor or a computed key.
function isPlain(property: ObjectExpression['properties'][number]): property is ObjectProperty {
  return property.type === 'Property' && property.kind === 'init' && !property.computed
}

function nameOf(property: ObjectProperty): string | undefined {
  const { key } = property

  if (key.type === 'Identifier')
    return key.name

  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined
}

function isCallOf(callee: CallExpression['callee'], imported: { locals: Set<string>, namespaces: Set<string> }, name: string): boolean {
  if (callee.type === 'Identifier')
    return imported.locals.has(callee.name)

  return callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier' && callee.property.name === name && imported.namespaces.has(callee.object.name)
}

// A hook key under the name it had before 1.87, in the options of `queue()`, `workflow()` and `mailer({ queue })`: the fix writes the new name, a shorthand `{ onFailed }` becoming `{ onError: onFailed }`.
// A key written beside its new name is reported with no fix, as both would run.
export async function hookNames(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-hook-names', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-hook-names', OLD_NAMES, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const imports = HOOK_RENAMES.map(row => importsOf(ast, source => source === row.source, row.call))

      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        for (const [index, row] of HOOK_RENAMES.entries()) {
          if (!isCallOf(node.callee, imports[index]!, row.call))
            continue

          const argument = node.arguments[row.argument]
          let object: Node | undefined = argument && unwrapped(argument)

          if (row.key !== undefined && object?.type === 'ObjectExpression') {
            const inner = object.properties.find(property => isPlain(property) && nameOf(property) === row.key)

            object = inner?.type === 'Property' ? unwrapped(inner.value) : undefined
          }

          if (object?.type !== 'ObjectExpression')
            continue

          const clash = object.properties.some(property => isPlain(property) && nameOf(property) === row.to)

          for (const property of object.properties) {
            if (!isPlain(property) || nameOf(property) !== row.from)
              continue

            const { key } = property
            const quote = key.type === 'Literal' ? key.raw?.[0] ?? '\'' : ''
            const written = `${quote}${row.to}${quote}`
            const text = property.shorthand ? `${row.to}: ${row.from}` : written

            report(base + key.start, base + key.end, `\`${row.from}\` of \`${row.call}()\` is \`${row.to}\` since 1.87, as every hook of a run that fails: it works until 1.90`, clash ? `\`${row.to}\` is set beside it, and both run: drop \`${row.from}\`` : `write \`${row.to}\``, clash ? null : [{ start: base + key.start, end: base + (property.shorthand ? property.value.end : key.end), text }])
          }
        }
      })
    }
  })
}
