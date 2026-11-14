import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { renamePackages } from '../package-names'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

type ObjectNode = NodeOfType<'ObjectExpression'>
type Property = Extract<ObjectNode['properties'][number], { type: 'Property' }>

interface Library {
  // The package whose imports the calls come from.
  package: string
  // The functions of the package that take hooks in their options.
  calls: readonly string[]
  // The options of kayjs-mail's lists are read off any `.list()` call in a file importing the package.
  lists?: boolean
  // `cms({ collections: { posts: { onSave } } })` sets the same hooks per collection.
  collections?: boolean
  hooks: Readonly<Record<string, string>>
}

const LIBRARIES: readonly Library[] = [
  { package: '@kayjs/auth', calls: ['auth', 'authCore'], hooks: { onSignUp: 'afterSignUp' } },
  { package: '@kayjs/mail', calls: ['mail', 'mailer', 'contactForm'], lists: true, hooks: { onSend: 'afterSend', onSuppress: 'afterSuppress', onSubscribe: 'afterSubscribe', onConfirm: 'afterConfirm', onUnsubscribe: 'afterUnsubscribe', onBroadcast: 'afterBroadcast' } },
  { package: '@kayjs/cms', calls: ['cms'], collections: true, hooks: { onSave: 'afterSave', onUpload: 'afterUpload' } },
  { package: '@kayjs/ai', calls: ['ai', 'ask', 'speak', 'embed', 'transcribe', 'describeImage'], hooks: { onStep: 'afterStep', onToolCall: 'afterToolCall', onSuccess: 'afterRequest' } },
]

const NEEDLE = /\b(?:onSignUp|onSend|onSuppress|onSubscribe|onConfirm|onUnsubscribe|onBroadcast|onSave|onUpload|onStep|onToolCall|onSuccess)\b/
const HELP = 'write the `after` name: a hook that is told what happened is `after<Verb>`, one that may refuse or change it `before<Verb>`'

// A server hook of kayjs-auth, -mail, -cms or -ai under its name before 1.105, when the ones that observe became `after<Verb>`: `onSignUp` is `afterSignUp`, `onSend` and `onSuppress` of the mailer and `onSend` of `contactForm()` are `afterSend` and `afterSuppress`, a list's `onSubscribe`, `onConfirm`, `onUnsubscribe` and `onBroadcast` follow, `onSave` and `onUpload` of `cms()` (and of each collection) are `afterSave` and `afterUpload`, and `onStep`, `onToolCall` and `onSuccess` of kayjs-ai are `afterStep`, `afterToolCall` and `afterRequest`; `onError` and `onEvent` keep their names.
// Found in the options object written in a call of the library's function imported from it, and in the `hooks` object of kayjs-auth's `src/auth.ts`; the fix renames the key, a bare `{ onSave }` becoming `afterSave: onSave`, and offers none where the object spreads another or already writes the new name.
export async function hookNames(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-hook-names', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-hook-names', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      for (const library of LIBRARIES) {
        const from = (source: string) => renamePackages(source) === library.package
        const found = library.calls.map(name => ({ name, ...importsOf(ast, from, name) }))
        const imported = ast.body.some(statement => statement.type === 'ImportDeclaration' && statement.importKind !== 'type' && from(statement.source.value))

        if (!imported && library.package !== '@kayjs/auth')
          continue

        const isCall = (callee: Node): boolean => found.some(({ name, locals, namespaces }) => callee.type === 'Identifier'
          ? locals.has(callee.name)
          : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === name)
        const isList = (callee: Node): boolean => library.lists === true && imported && callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'list'

        const check = (object: ObjectNode): void => {
          const properties = object.properties.filter((property): property is Property => property.type === 'Property')
          const spread = object.properties.some(property => property.type === 'SpreadElement')
          const keys = new Set(properties.filter(property => !property.computed).map(property => keyName(property)))

          for (const property of properties) {
            const old = property.computed ? undefined : keyName(property)
            const name = old === undefined ? undefined : library.hooks[old]

            if (old === undefined || name === undefined)
              continue

            const fixable = !spread && !keys.has(name)
            const text = property.shorthand ? `${name}: ${old}` : name
            const edit = property.shorthand ? { start: base + property.start, end: base + property.end, text } : { start: base + property.key.start, end: base + property.key.end, text }

            report(base + property.start, base + property.end, `\`${old}\` is \`${name}\` since 1.105: a server hook that is told what happened is \`after<Verb>\``, HELP, fixable ? [edit] : null)
          }

          if (!library.collections)
            return

          const collections = properties.find(property => !property.computed && keyName(property) === 'collections')?.value

          if (collections?.type !== 'ObjectExpression')
            return

          for (const each of collections.properties) {
            if (each.type === 'Property' && each.value.type === 'ObjectExpression')
              check(each.value)
          }
        }

        walk(ast, (node) => {
          if (node.type === 'CallExpression' && (isCall(node.callee) || isList(node.callee))) {
            for (const argument of node.arguments) {
              if (argument.type === 'ObjectExpression')
                check(argument)
            }

            return
          }

          if (library.package === '@kayjs/auth' && node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'hooks' && node.init?.type === 'ObjectExpression')
            check(node.init)
        })
      }
    }
  })
}
