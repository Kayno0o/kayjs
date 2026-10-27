import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { keyName } from '../compiler/object-literal'
import { parseKay } from '../compiler/parser'
import { importsOf, walk } from './ast'

const SOURCE_FILE = /(?:(?<!\.d)\.tsx?|\.kay)$/
const AUTH_PACKAGE = '@kaynooo/kayjs-auth'
// Members every AuthStore has, which tell a store from any object holding an `attempts`.
const STORE_KEYS = ['users', 'identities', 'tokens']
// What follows a property to the end of its line: its comma and a comment.
const LINE_REST = /^[ \t]*(?:,[ \t]*)?(?:\/\/[^\n]*)?\r?\n/
const NEWLINE = /^\r?\n/

interface Edit { start: number, end: number, text: string }

// The `attempts` counter of a kayjs-auth store written by the app, the contract before 1.81: a store counts in `rates`, a kay `RateStore`, or leaves counting to the app's `store.rates`. The counter is still read until 1.84.
// A store is an object literal holding `users`, `identities` and `tokens` in a file importing from the library. The fix drops `attempts: memoryAuthStore().attempts`, which counted in memory as kayjs-auth now does on its own, and the import it leaves unread; any other counter may be the app's only count shared by its processes, so it is reported without one.
export async function authAttempts(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-auth-attempts', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!source.includes(AUTH_PACKAGE) || !source.includes('attempts'))
      continue

    const parsed = file.endsWith('.kay') ? parseKay(source) : undefined
    const spans = parsed ? [parsed.script, parsed.server, parsed.module].filter(span => span !== undefined) : [{ start: 0, end: source.length }]

    for (const { start: base, end } of spans) {
      const text = source.slice(base, end)
      let ast: t.File

      try {
        ast = parse(text, { sourceType: 'module', plugins: file.endsWith('.ts') ? ['typescript'] : ['typescript', 'jsx'], errorRecovery: true })
      }
      catch {
        continue
      }

      if (!ast.program.body.some(statement => statement.type === 'ImportDeclaration' && statement.source.value.startsWith(AUTH_PACKAGE)))
        continue

      const { locals, namespaces } = importsOf(ast, from => from === AUTH_PACKAGE, 'memoryAuthStore')

      walk(ast, (node) => {
        if (node.type !== 'ObjectExpression')
          return

        const names = new Set(node.properties.flatMap(property => property.type === 'SpreadElement' || property.computed ? [] : [keyName(property as t.ObjectProperty)]))
        const index = node.properties.findIndex(property => property.type === 'ObjectProperty' && keyName(property) === 'attempts')

        if (index === -1 || !STORE_KEYS.every(key => names.has(key)))
          return

        const property = node.properties[index] as t.ObjectProperty
        const memory = memoryCounter(property.value, locals, namespaces)
        const edits = memory === undefined ? undefined : [removal(text, node.properties, index), ...unreadImport(ast, text, memory)].map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end }))

        found.push({
          file,
          ...positionAt(source, base + property.key.start!),
          end: base + property.key.end!,
          message: '`attempts` of a kayjs-auth store is the counter before 1.81: kayjs-auth counts in the store\'s `rates`, else the app\'s `store.rates`, else memory',
          help: memory === undefined ? 'give the store `rates`, a kay RateStore with `peek` and `reset` over the same database, or drop `attempts` to count in the app\'s `store.rates`' : 'drop it: kayjs-auth counts in memory itself when the app keeps no `store.rates`',
          code: 'deprecated-auth-attempts',
          severity: level === 'warn' ? 'warning' : 'error',
          ...edits && { fixes: [{ title: 'Drop attempts', edits, safe: true }] },
        })
      })
    }
  }

  return found
}

// The local name of `memoryAuthStore` when `value` is `memoryAuthStore().attempts`, so the counter lived in memory.
function memoryCounter(value: t.Node, locals: Set<string>, namespaces: Set<string>): string | undefined {
  if (value.type !== 'MemberExpression' || value.computed || value.property.type !== 'Identifier' || value.property.name !== 'attempts' || value.object.type !== 'CallExpression')
    return undefined

  const callee = value.object.callee

  if (callee.type === 'Identifier' && locals.has(callee.name))
    return callee.name

  return callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'memoryAuthStore' ? '' : undefined
}

// A property on lines of its own goes with those lines: the comments above it, its comma and a comment ending its line.
// One sharing its line goes with its comma, up to the next member or the comments above it, so what follows keeps its place.
function removal(text: string, properties: t.ObjectExpression['properties'], index: number): Edit {
  const property = properties[index]!
  const next = properties[index + 1]
  const onOwnLine = (at: number) => text.slice(text.lastIndexOf('\n', at - 1) + 1, at).trim() === ''
  const start = property.leadingComments?.find(comment => onOwnLine(comment.start!))?.start ?? property.start!
  const rest = LINE_REST.exec(text.slice(property.end!))

  if (onOwnLine(start) && rest)
    return { start: text.lastIndexOf('\n', start - 1) + 1, end: property.end! + rest[0].length, text: '' }

  if (next)
    return { start: property.start!, end: next.leadingComments?.[0]?.start ?? next.start!, text: '' }

  const previous = properties[index - 1]

  return { start: previous?.end ?? property.start!, end: property.end!, text: '' }
}

// The import of `memoryAuthStore` once the dropped counter was its only read: the specifier, or the whole import when it was alone.
function unreadImport(ast: t.File, text: string, local: string): Edit[] {
  if (local === '')
    return []

  let reads = 0

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration')
      continue

    walk(statement, (node) => {
      if (node.type === 'Identifier' && node.name === local)
        reads++
    })
  }

  // The call being dropped is the one read left.
  if (reads > 1)
    return []

  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== AUTH_PACKAGE)
      continue

    const index = statement.specifiers.findIndex(specifier => specifier.local.name === local)

    if (index === -1)
      continue

    if (statement.specifiers.length === 1)
      return [{ start: statement.start!, end: statement.end! + (NEWLINE.exec(text.slice(statement.end!))?.[0].length ?? 0), text: '' }]

    const specifier = statement.specifiers[index]!
    const next = statement.specifiers[index + 1]

    return [next ? { start: specifier.start!, end: next.start!, text: '' } : { start: statement.specifiers[index - 1]!.end!, end: specifier.end!, text: '' }]
  }

  return []
}
