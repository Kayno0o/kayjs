import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { renamePackages } from '../package-names'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const NEEDLE = /\b(?:transcribe|describeImage)\b/
const FROM_AI = (source: string) => renamePackages(source) === '@kayjs/ai'
const CALLS = ['transcribe', 'describeImage']
const HELP = 'write `locale`, which takes a BCP 47 tag such as `fr` or `pt-BR`'

type Property = Extract<NodeOfType<'ObjectExpression'>['properties'][number], { type: 'Property' }>

// `language` in the options of `transcribe()` and `describeImage()`, `locale` since 1.105: every call of kayjs-ai that names a language takes a BCP 47 tag under that name, and `transcribe` turns it into the ISO 639-1 code its provider takes.
// Found on a call of either imported from `@kayjs/ai`, or read off `import * as`, in the options object written in the call; the fix renames the key, a bare `{ language }` becoming `locale: language`, and offers none where `locale` is written too.
export async function aiLanguage(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-ai-language', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-ai-language', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const found = CALLS.map(name => ({ name, ...importsOf(ast, FROM_AI, name) }))

      if (found.every(({ locals, namespaces }) => locals.size === 0 && namespaces.size === 0))
        continue

      const isCall = (callee: Node): boolean => found.some(({ name, locals, namespaces }) => callee.type === 'Identifier'
        ? locals.has(callee.name)
        : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === name)

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || !isCall(node.callee))
          return

        const argument = node.arguments[1]

        if (argument?.type !== 'ObjectExpression')
          return

        const properties = argument.properties.filter((property): property is Property => property.type === 'Property')
        const language = properties.find(property => !property.computed && keyName(property) === 'language')

        if (!language)
          return

        const fixable = !argument.properties.some(property => property.type === 'SpreadElement') && !properties.some(property => keyName(property) === 'locale') && !language.method
        const text = language.shorthand ? 'locale: language' : 'locale'
        const edit = language.shorthand ? { start: base + language.start, end: base + language.end, text } : { start: base + language.key.start, end: base + language.key.end, text }

        report(base + language.start, base + language.end, '`language` of `transcribe()` and `describeImage()` is `locale` since 1.105, a BCP 47 tag', HELP, fixable ? [edit] : null)
      })
    }
  })
}
