import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { renamePackages } from '../package-names'
import { importsOf, walk } from './ast'
import { renamedCallOptions } from './renamed-call-options'
import { renamedTypes, scan } from './renamed-exports'

const LINT = 'deprecated-store-names'
const NEEDLE = /\b(?:pgConversations|conversationTable|createConversationTable|sqliteConversations|conversations|pgLoader|sqliteLoader|PgLoaderOptions|SqliteLoaderOptions|openLists|createMailListTables|mailListTableNames|listStore|suppressionStore)\b/
const FROM_AI = (source: string) => renamePackages(source) === '@kayjs/ai'
const FROM_MAIL = (source: string) => renamePackages(source) === '@kayjs/mail'
const MAILER_KEYS = [['listStore', 'lists'], ['suppressionStore', 'suppressions']] as const

type Property = Extract<NodeOfType<'ObjectExpression'>['properties'][number], { type: 'Property' }>

// `listStore: x` as `store: { lists: x }`, a shorthand written out.
function moved(property: Property, old: string, part: string, base: number): Edit[] {
  if (property.shorthand)
    return [{ start: base + property.start, end: base + property.end, text: `store: { ${part}: ${old} }` }]

  return [{ start: base + property.key.start, end: base + property.value.start, text: `store: { ${part}: ` }, { start: base + property.value.end, end: base + property.value.end, text: ' }' }]
}

// What kayjs-mail's `mailer()` takes as `store: { lists, suppressions }` since 1.105: `listStore` and `suppressionStore` still work until 1.108.
// A fix moves a lone one under `store`; both together, a spread or a `store` already there are reported with no fix, as they need the object rewritten.
async function mailerStores(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return scan(root, options, LINT, NEEDLE, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const bound = ['mailer', 'mail'].map(name => ({ name, ...importsOf(ast, FROM_MAIL, name) })).filter(one => one.locals.size > 0 || one.namespaces.size > 0)

      if (bound.length === 0)
        continue

      const isMailer = (callee: Node): boolean => bound.some(({ name, locals, namespaces }) => callee.type === 'Identifier'
        ? locals.has(callee.name)
        : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === name)

      walk(ast, (node) => {
        const argument = node.type === 'CallExpression' && isMailer(node.callee) ? node.arguments[0] : undefined

        if (argument?.type !== 'ObjectExpression')
          return

        const properties = argument.properties.filter((one): one is Property => one.type === 'Property')
        const found = MAILER_KEYS.flatMap(([old, part]) => properties.filter(one => keyName(one) === old).map(property => ({ property, old, part })))
        const alone = found.length === 1 && argument.properties.length === properties.length && !properties.some(one => keyName(one) === 'store')

        for (const { property, old, part } of found) {
          const edits = alone && !property.computed ? moved(property, old, part, base) : null

          report(base + property.start, base + property.end, `\`${old}\` of \`mailer()\` is deprecated since 1.105: \`store: { ${part} }\` keeps the mailer's ${part === 'lists' ? 'lists' : 'bounces'} with the library's other stores`, `write \`store: { ${part} }\``, edits)
        }
      })
    }
  })
}

// The names of kayjs-ai, kayjs-mail and kayjs-cms's stores and tables before 1.105, which one naming took over: `ai({ conversations })` is `ai({ store })`, `pgConversations` is `pgAi`, `sqliteConversations` `sqliteAi`, `createConversationTable` `createAiTables`, `conversationTable` `aiTables`, `openLists` `sqliteLists`, `createMailListTables` `createMailTables`, `mailListTableNames` `mailTables`, and cms's `pgLoader` and `sqliteLoader` are `pgCms` and `sqliteCms`.
// The imports and their uses are renamed, and so is the `conversations` key of `ai()`; the `listStore` and `suppressionStore` of `mailer()` move under `store`.
export async function storeNames(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel(LINT, options.lints) === 'allow')
    return []

  const since = '1.105'
  const until = '1.108'

  return [
    ...await renamedTypes(root, options, {
      lint: LINT,
      modules: {
        '@kayjs/ai/pg': { pgConversations: 'pgAi', createConversationTable: 'createAiTables', conversationTable: 'aiTables' },
        '@kayjs/ai/sqlite': { sqliteConversations: 'sqliteAi' },
        '@kayjs/mail/pg': { createMailListTables: 'createMailTables', mailListTableNames: 'mailTables' },
        '@kayjs/mail/sqlite': { openLists: 'sqliteLists' },
        '@kayjs/cms/pg': { pgLoader: 'pgCms', PgLoaderOptions: 'PgCmsOptions' },
        '@kayjs/cms/sqlite': { sqliteLoader: 'sqliteCms', SqliteLoaderOptions: 'SqliteCmsOptions' },
      },
      needle: NEEDLE,
      since,
      until,
    }),
    ...await renamedCallOptions(root, options, { lint: LINT, needle: NEEDLE, from: FROM_AI, calls: { ai: 0 }, renames: [['conversations', 'store']], since, of: '`ai()`' }),
    ...await mailerStores(root, options),
  ]
}
