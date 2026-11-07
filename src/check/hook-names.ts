import type { ObjectExpression, ObjectProperty } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { unwrapped } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

interface HookRenames {
  // The library, as a message names it.
  library: string
  from: (source: string) => boolean
  // The functions whose options hold the hooks.
  calls: readonly string[]
  // The file whose `export const hooks` holds the same keys, relative to the project.
  hooksFile?: string
  renames: Readonly<Record<string, string>>
  until: string
}

// The hooks renamed to follow the convention of `llms/hooks.md`, by library; each slice of #2806 adds its rows.
const HOOK_RENAMES: readonly HookRenames[] = [
  {
    library: 'kayjs-auth',
    from: source => source === '@kaynooo/kayjs-auth' || source.startsWith('@kaynooo/kayjs-auth/'),
    calls: ['auth', 'authCore', 'createAuth'],
    hooksFile: 'src/auth.ts',
    renames: { onAuthEvent: 'onEvent', onDelete: 'beforeDelete' },
    until: '1.95',
  },
]

const OLD_HOOK = new RegExp(`\\b(?:${[...new Set(HOOK_RENAMES.flatMap(({ renames }) => Object.keys(renames)))].join('|')})\\b`)

type Member = ObjectExpression['properties'][number]

// A property with a written key, a method included: `onDelete() {}` is as old a hook as `onDelete: () => {}`.
function isNamed(member: Member): member is ObjectProperty {
  return member.type === 'Property' && member.kind === 'init' && !member.computed && (member.key.type === 'Identifier' || (member.key.type === 'Literal' && typeof member.key.value === 'string'))
}

function nameOf(member: ObjectProperty): string {
  return member.key.type === 'Identifier' ? member.key.name : String((member.key as { value: unknown }).value)
}

// The hooks of kay's libraries under the names they had before the convention of `llms/hooks.md`: `onAuthEvent` and `onDelete` of kayjs-auth are `onEvent` and `beforeDelete`.
// Found in the options object written out at a call of the library's function, and in the `hooks` an app keeps in `src/auth.ts`. The fix renames the key, a shorthand `{ onDelete }` becoming `{ beforeDelete: onDelete }`; a key written beside its new name is reported with no fix, as the new one wins.
export async function hookNames(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-hook-names', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-hook-names', OLD_HOOK, ({ file, parsed, report }) => {
    for (const { ast, base } of parsed) {
      const rename = (object: ObjectExpression, group: HookRenames, what: string) => {
        const members = object.properties.filter(isNamed)

        for (const member of members) {
          const old = nameOf(member)
          const name = group.renames[old]

          if (name === undefined || !Object.hasOwn(group.renames, old))
            continue

          const clash = members.some(one => nameOf(one) === name)
          const { key } = member
          const quote = key.type === 'Literal' ? key.raw?.[0] ?? '\'' : ''
          const text = member.shorthand ? `${name}: ${old}` : `${quote}${name}${quote}`

          report(base + key.start, base + key.end, `\`${old}\` of ${what} is \`${name}\` since 1.92, so every hook is \`onX\` after a transition and \`beforeX\` when it can refuse it; the old name works until ${group.until}`, clash ? `\`${name}\` is set beside it, which wins: drop \`${old}\`` : `write \`${name}\``, clash ? null : [{ start: base + key.start, end: base + (member.shorthand ? member.value.end : key.end), text }])
        }
      }

      for (const group of HOOK_RENAMES) {
        const imported = group.calls.map(call => ({ call, ...importsOf(ast, group.from, call) }))

        walk(ast, (node: Node) => {
          if (node.type === 'CallExpression') {
            const { callee } = node
            const called = imported.find(({ call, locals, namespaces }) => callee.type === 'Identifier'
              ? locals.has(callee.name)
              : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier' && callee.property.name === call && namespaces.has(callee.object.name))
            const given = called && node.arguments[0] ? unwrapped(node.arguments[0]) : undefined

            if (called && given?.type === 'ObjectExpression')
              rename(given, group, `\`${called.call}()\` of ${group.library}`)

            return
          }

          if (group.hooksFile === undefined || !file.endsWith(`/${group.hooksFile}`) || node.type !== 'ExportNamedDeclaration' || node.declaration?.type !== 'VariableDeclaration')
            return

          for (const declarator of node.declaration.declarations) {
            const init = declarator.init && unwrapped(declarator.init)

            if (declarator.id.type === 'Identifier' && declarator.id.name === 'hooks' && init?.type === 'ObjectExpression')
              rename(init, group, `the \`hooks\` of ${group.hooksFile}`)
          }
        })
      }
    }
  })
}
