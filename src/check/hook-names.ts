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
  // The position of the options object in a call, for the functions that take it after another argument (`ask(prompt, { ... })`); the first by default.
  argument?: Readonly<Record<string, number>>
  // The group's `onError` is told `{ error, context }` since the release, where it was told the error itself.
  errorShape?: true
  // The file whose `export const hooks` holds the same keys, relative to the project.
  hooksFile?: string
  renames: Readonly<Record<string, string>>
  // The renamed hooks whose new name also changes what they do, so the fix is offered but not applied by `kay upgrade`.
  changed?: readonly string[]
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
    // `beforeDelete` is cut off after 10 s, refuses on `false` and on a throw, where `onDelete` waited and propagated.
    changed: ['onDelete'],
    until: '1.95',
  },
  {
    library: 'kayjs-ai',
    from: source => source === '@kaynooo/kayjs-ai' || source.startsWith('@kaynooo/kayjs-ai/'),
    calls: ['ai', 'ask'],
    argument: { ask: 1 },
    // `beforeRequest` and `onSuccess` run where `onRequest` and `onFinish` did, in the same order and with the same refusals, so the rename keeps what the hook does.
    renames: { onRequest: 'beforeRequest', onFinish: 'onSuccess' },
    errorShape: true,
    until: '1.95',
  },
]

const OLD_HOOK = new RegExp(`\\b(?:${[...new Set(HOOK_RENAMES.flatMap(({ renames, errorShape }) => [...Object.keys(renames), ...errorShape === true ? ['onError'] : []]))].join('|')})\\b`)

type Member = ObjectExpression['properties'][number]

// A property with a written key, a method included: `onDelete() {}` is as old a hook as `onDelete: () => {}`.
function isNamed(member: Member): member is ObjectProperty {
  return member.type === 'Property' && member.kind === 'init' && !member.computed && (member.key.type === 'Identifier' || (member.key.type === 'Literal' && typeof member.key.value === 'string'))
}

function nameOf(member: ObjectProperty): string {
  return member.key.type === 'Identifier' ? member.key.name : String((member.key as { value: unknown }).value)
}

// The hooks of kay's libraries under the names they had before the convention of `llms/hooks.md`: `onAuthEvent` and `onDelete` of kayjs-auth are `onEvent` and `beforeDelete`.
// Found in the options object written out at a call of the library's function, and in the `hooks` an app keeps in `src/auth.ts`. The fix renames the key (`onDelete` is left to you, as `beforeDelete` is cut off after 10 s and refuses on `false` or a throw where `onDelete` waited and propagated), a shorthand `{ onDelete }` becoming `{ beforeDelete: onDelete }`; a key written beside its new name is reported with no fix, as the new one wins.
export async function hookNames(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-hook-names', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-hook-names', OLD_HOOK, ({ file, parsed, report }) => {
    for (const { ast, base, text: source } of parsed) {
      const rename = (object: ObjectExpression, group: HookRenames, what: string) => {
        const members = object.properties.filter(isNamed)

        for (const member of group.errorShape === true ? members : []) {
          if (nameOf(member) !== 'onError')
            continue

          const hook = unwrapped(member.value)
          const written = hook.type === 'ArrowFunctionExpression' || hook.type === 'FunctionExpression'
          const param = written ? hook.params[0] : undefined

          // A function with no parameter, or one that destructures its argument, reads nothing of the error itself.
          if (written && (param === undefined || param.type !== 'Identifier'))
            continue

          let edits: { start: number, end: number, text: string }[] | null = null

          // A typed parameter is left to the app, as the pattern would have to carry the type.
          if (param?.type === 'Identifier' && param.typeAnnotation == null) {
            const pattern = param.name === 'error' ? '{ error }' : `{ error: ${param.name} }`
            const bare = hook.type === 'ArrowFunctionExpression' && source.slice(0, param.start).trimEnd().at(-1) !== '('

            edits = [{ start: base + param.start, end: base + param.end, text: bare ? `(${pattern})` : pattern }]
          }

          report(base + member.key.start, base + member.key.end, `\`onError\` of ${what} is told \`{ error, context }\` since 1.92 and no longer the error itself, so every hook is told one object`, written ? 'write `({ error }) =>`, or `({ error: name }) =>` for another name' : 'the hook is not written here: read `error` of its argument', edits)
        }

        for (const member of members) {
          const old = nameOf(member)
          const name = group.renames[old]

          if (name === undefined || !Object.hasOwn(group.renames, old))
            continue

          const clash = members.some(one => nameOf(one) === name)
          const { key } = member
          const quote = key.type === 'Literal' ? key.raw?.[0] ?? '\'' : ''
          const text = member.shorthand ? `${name}: ${old}` : `${quote}${name}${quote}`

          report(base + key.start, base + key.end, `\`${old}\` of ${what} is \`${name}\` since 1.92, so every hook is \`onX\` after a transition and \`beforeX\` when it can refuse it; the old name works until ${group.until}`, clash ? `\`${name}\` is set beside it, which wins: drop \`${old}\`` : `write \`${name}\``, clash ? null : [{ start: base + key.start, end: base + (member.shorthand ? member.value.end : key.end), text }], group.changed?.includes(old) !== true)
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
            const argument = called ? node.arguments[group.argument?.[called.call] ?? 0] : undefined
            const given = argument ? unwrapped(argument) : undefined

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
