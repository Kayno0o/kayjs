import type { ObjectExpression, ObjectProperty } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import { lintLevel } from '../compiler/lints'
import { keyName, unwrapped } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { renamedTypes, scan } from './renamed-exports'

const SINCE = '1.91'
const UNTIL = '1.94'

// The exports renamed in 1.91 so constructors are nouns, every Postgres helper takes one `PgSource` and every `xTableNames` lists names, per module they are imported from, and the name each has now.
// The root of kayjs-mail keeps the old names of its pg helpers until it drops them, so only `@kaynooo/kayjs-mail/pg` is renamed.
export const LIBRARY_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'kay/server': { PgJobsSource: 'PgSource' },
  'kay/library': { PgJobsSource: 'PgSource' },
  '@kaynooo/kayjs-mail/pg': { createMailSuppressionTable: 'createMailSuppressionTables', mailListTables: 'mailListTableNames' },
  '@kaynooo/kayjs-auth': { createAuth: 'authCore', createGate: 'authGate', createRoleHierarchy: 'roleHierarchy', createWsAuthStore: 'wsAuthStore', memoryAuthStore: 'memoryAuth' },
  '@kaynooo/kayjs-auth/pg': { pgStore: 'pgAuth' },
  '@kaynooo/kayjs-cms': { createDrafts: 'cmsDrafts' },
  '@kaynooo/kayjs-cms/form': { createEntryForm: 'cmsEntryForm' },
}

const OLD_NAME = new RegExp(`\\b(?:${[...new Set(Object.values(LIBRARY_NAMES).flatMap(names => Object.keys(names)))].join('|')})\\b`)
const PG_LOADER = /\bpgLoader\b/
const CMS_PG = '@kaynooo/kayjs-cms/pg'

function isPlain(property: ObjectExpression['properties'][number]): property is ObjectProperty {
  return property.type === 'Property' && property.kind === 'init' && !property.method && !property.computed
}

// An export imported under the name it had before 1.91 (`LIBRARY_NAMES`): the fix renames the import and every use of it.
export async function libraryNames(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return [
    ...await renamedTypes(root, options, { lint: 'deprecated-library-names', modules: LIBRARY_NAMES, needle: OLD_NAME, since: SINCE, until: UNTIL }),
    ...await dynamicImports(root, options),
  ]
}

// A member read straight off a dynamic import, `(await import('@kaynooo/kayjs-auth/pg')).pgStore`, which the config templates write: the fix renames the member.
async function dynamicImports(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-library-names', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-library-names', OLD_NAME, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      walk(ast, (node) => {
        if (node.type !== 'MemberExpression' || node.computed || node.property.type !== 'Identifier')
          return

        const loaded = unwrapped(node.object)
        const module = unwrapped(loaded.type === 'AwaitExpression' ? loaded.argument : loaded)
        const specifier = module.type === 'ImportExpression' ? unwrapped(module.source) : undefined

        if (specifier?.type !== 'Literal' || typeof specifier.value !== 'string' || !Object.hasOwn(LIBRARY_NAMES, specifier.value))
          return

        const names = LIBRARY_NAMES[specifier.value]!
        const old = node.property.name

        if (!Object.hasOwn(names, old))
          return

        const next = names[old]!

        report(base + node.property.start, base + node.property.end, `\`${old}\` is renamed \`${next}\` since ${SINCE}, and the old name works until ${UNTIL}`, `rename it to \`${next}\``, [{ start: base + node.property.start, end: base + node.property.end, text: next }])
      })
    }
  })
}

// The `sql` key of a `pgLoader({ ... })` literal, `source` since 1.91 as every Postgres store names its database: the fix renames the key, and a `source` set beside it is reported with no fix, as it wins.
export async function pgLoaderSource(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-library-names', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-library-names', PG_LOADER, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const loaders = importsOf(ast, source => source === CMS_PG, 'pgLoader')

      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        const { callee } = node
        const isLoader = callee.type === 'Identifier'
          ? loaders.locals.has(callee.name)
          : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier' && callee.property.name === 'pgLoader' && loaders.namespaces.has(callee.object.name)
        const given = isLoader && node.arguments[0] ? unwrapped(node.arguments[0]) : undefined

        if (given?.type !== 'ObjectExpression')
          return

        const plain = given.properties.filter(isPlain)
        const property = plain.find(one => keyName(one) === 'sql')

        if (!property)
          return

        const clash = plain.some(one => keyName(one) === 'source') || given.properties.some(one => one.type === 'SpreadElement')
        const { key } = property
        const edit = { start: base + key.start, end: base + (property.shorthand ? property.value.end : key.end), text: property.shorthand ? 'source: sql' : 'source' }

        report(base + key.start, base + key.end, `\`sql\` of \`pgLoader()\` is \`source\` since ${SINCE}, as every Postgres store names its database; the old key works until ${UNTIL}`, clash ? '`source` or a spread is set beside it, which may win: write `source` and drop `sql` by hand' : 'write `source`', clash ? null : [edit])
      })
    }
  })
}
