import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const PERSISTED = /\bpersisted\b/
const FROM_KAY = (source: string) => source === 'kay'
const HELP = 'call `persisted.local()`, `persisted.session()` or `persisted.query()`, and `persisted()` for a cookie'
// The entry that keeps a value where the option said, none for the cookie `persisted()` is.
const ENTRIES: Record<string, string> = { local: '.local', query: '.query', cookie: '' }
const COMMENT = /\/[*/]/

type ObjectNode = NodeOfType<'ObjectExpression'>
type Property = Extract<ObjectNode['properties'][number], { type: 'Property' }>

// `storage` in the options of `persisted()`, an entry of its own since 1.101: `persisted(name, value, { storage: 'local' })` is `persisted.local(name, value)`, `'session'` and `'query'` likewise, and `'cookie'` is `persisted(name, value)`, the default.
// Found on a call of `persisted` imported from `kay`, or read off `import * as`, in the options object written in the call; the fix moves the call to the entry and drops the property. A `storage` that is not a literal, an object spreading another, or options that hold a key the entry refuses (`maxAge` or `sync` of a query, `maxAge` of a web storage) are reported with no fix.
export async function persistedStorage(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-persisted-storage', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-persisted-storage', PERSISTED, ({ source, parsed, report }) => {
    for (const { ast, base } of parsed) {
      const { locals, namespaces } = importsOf(ast, FROM_KAY, 'persisted')

      if (locals.size === 0 && namespaces.size === 0)
        continue

      const isPersisted = (callee: Node): boolean => callee.type === 'Identifier'
        ? locals.has(callee.name)
        : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'persisted'

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || !isPersisted(node.callee))
          return

        const argument = node.arguments[2]

        if (argument?.type !== 'ObjectExpression' || node.arguments.some(one => one.type === 'SpreadElement'))
          return

        const storage = argument.properties.find((property): property is Property => property.type === 'Property' && keyName(property) === 'storage')

        if (!storage)
          return

        const named = storage.value.type === 'Literal' && typeof storage.value.value === 'string' && Object.hasOwn(ENTRIES, storage.value.value) ? storage.value.value : undefined
        const refused = argument.properties.some(property => property.type === 'SpreadElement' || property.computed || (property.type === 'Property' && refuses(named, keyName(property))))
        const edits = named === undefined || storage.computed || storage.shorthand || storage.method || refused ? null : fixOf(node, argument, storage, ENTRIES[named]!, base)
        // A comment in a range the fix removes would be lost with it.
        const lost = edits?.some(edit => COMMENT.test(source.slice(edit.start, edit.end)))

        report(base + storage.start, base + storage.end, '`storage` of `persisted()` is deprecated since 1.101: each storage has its own entry', HELP, lost ? null : edits)
      })
    }
  })
}

// Whether the entry for `storage` refuses the option `key`, which the old overloads refused too.
function refuses(storage: string | undefined, key: string | undefined): boolean {
  if (storage === 'query')
    return key === 'maxAge' || key === 'sync'

  return (storage === 'local' || storage === 'session') && key === 'maxAge'
}

function fixOf(call: NodeOfType<'CallExpression'>, options: ObjectNode, storage: Property, entry: string, base: number): Edit[] {
  const at = options.properties.indexOf(storage)
  const before = options.properties[at - 1]
  const after = options.properties[at + 1]
  const edits: Edit[] = []

  if (entry !== '')
    edits.push({ start: base + call.callee.end, end: base + call.callee.end, text: entry })

  if (options.properties.length === 1)
    edits.push({ start: base + call.arguments[1]!.end, end: base + options.end, text: '' })
  else if (after)
    edits.push({ start: base + storage.start, end: base + after.start, text: '' })
  else
    edits.push({ start: base + before!.end, end: base + storage.end, text: '' })

  return edits
}
