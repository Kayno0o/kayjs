import type { CallExpression, ObjectExpression, ObjectProperty } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { Program } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { keyName, unwrapped } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const OLD_NAME = /\b(?:revalidate|keepFailed|keep)\b/
const KAY_MODULES = (source: string) => source === 'kay' || source === 'kay/server'

// The options object each function takes, by the place of its argument, and the key it renamed.
const OPTION_CALLS: Record<string, { argument: number, old: string, name: string }> = {
  notify: { argument: 1, old: 'keep', name: 'ttl' },
  queue: { argument: 2, old: 'keepFailed', name: 'failedTtl' },
  workflow: { argument: 2, old: 'keepFailed', name: 'failedTtl' },
}

function isPlain(property: ObjectExpression['properties'][number]): property is ObjectProperty {
  return property.type === 'Property' && property.kind === 'init' && !property.method && !property.computed
}

// Whether a bare call of `name` is kay's: imported from kay, or in a fence, which needs no import of what it reads from kay.
function isKayCall(ast: Program, callee: CallExpression['callee'], name: string, fence: boolean): boolean {
  if (callee.type === 'Identifier') {
    const { locals } = importsOf(ast, KAY_MODULES, name)
    const imported = ast.body.some(statement => statement.type === 'ImportDeclaration' && statement.specifiers.some(specifier => specifier.local.name === callee.name))

    return locals.has(callee.name) || (fence && callee.name === name && !imported)
  }

  if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier' || callee.property.name !== name)
    return false

  return importsOf(ast, KAY_MODULES, name).namespaces.has(callee.object.name)
}

// Lifetimes that were spelled with a word the config keeps for a boolean, or with another word than the rest of kay's: a page's `revalidate` is `ttl`, a notification's `keep` is `ttl`, a queue's or workflow's `keepFailed` is `failedTtl`, and kayjs-ai's `Chat` `keep` (checked with the templates) is `history`.
// The fix writes the new key; a key written beside its new name is reported with no fix, as the old one is ignored there.
export async function deprecatedLifetimes(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-lifetimes', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-lifetimes', OLD_NAME, ({ file, parsed, report }) => {
    const fence = file.endsWith('.kay')

    for (const { ast, base } of parsed) {
      const rename = (object: ObjectExpression, old: string, name: string, what: string) => {
        const plain = object.properties.filter(isPlain)
        const property = plain.find(one => keyName(one) === old)

        if (!property)
          return

        const clash = plain.some(one => keyName(one) === name)
        const key = property.key
        const edit = { start: base + key.start, end: base + (property.shorthand ? property.value.end : key.end), text: property.shorthand ? `${name}: ${old}` : name }

        report(base + key.start, base + key.end, `\`${old}\` of ${what} is \`${name}\` since 1.87, so a lifetime is always \`ttl\` or a word ending in \`Ttl\` and \`keep\` is only ever a boolean; the old name works until 1.90`, clash ? `\`${name}\` is set beside it, which wins: drop \`${old}\`` : `write \`${name}\``, clash ? null : [edit])
      }

      walk(ast, (node) => {
        // A page's settings: the object `export const page = { ... }` holds.
        if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration') {
          for (const declarator of node.declaration.declarations) {
            const init = declarator.init && unwrapped(declarator.init)

            if (declarator.id.type === 'Identifier' && declarator.id.name === 'page' && init?.type === 'ObjectExpression')
              rename(init, 'revalidate', 'ttl', 'a page\'s settings')
          }

          return
        }

        if (node.type !== 'CallExpression')
          return

        for (const [name, { argument, old, name: renamed }] of Object.entries(OPTION_CALLS)) {
          if (!isKayCall(ast, node.callee, name, fence))
            continue

          const given = node.arguments[argument] && unwrapped(node.arguments[argument])

          if (given?.type === 'ObjectExpression')
            rename(given, old, renamed, `\`${name}()\``)
        }
      })
    }
  })
}
