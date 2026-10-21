// The checks a fence takes once parsed, beside what analyzing it reports: a schema field with no bound, a stylesheet imported for its text without asking, a page setting outside `page`.

import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic, Fix } from './ast'
import type { PageSettings, ParsedFence, SeparateSetting, ServerAnalysis } from './script'
import { isSecret } from '../runtime/form'
import { eachNode } from './each-node'
import { PAGE } from './page-settings'
import { loadTraverse } from './rewrite'
import { parseFence } from './script'

// A line break before a line with text: a blank line moving into `page` stays blank.
const LINE_WITH_TEXT = /\n(?=[^\n])/g
const NON_SPACE_OR_NEWLINE = /\S|\n/

// Settings exported under their own names, with a fix moving every one it can into `page` at once: each diagnostic carries the same fix, applied once.
export function separatePageSettings(source: string, server: ServerAnalysis): Diagnostic[] {
  const { separate } = server

  // A fence naming a value `page` itself, as a paginated list often does, renames it before `page` can hold the settings.
  const taken = !server.page && (server.data.some(data => data.name === PAGE) || server.imports.some(binding => binding.local === PAGE))
  const movable = taken ? [] : separate.filter(setting => setting.movable && !server.page?.settings.has(setting.name))
  const fix = movable.length > 0 ? moveIntoPage(source, server.page, movable) : undefined

  return separate.map((setting) => {
    if (server.page?.settings.has(setting.name))
      return { ...setting.local, message: `\`${setting.name}\` is set twice, in \`page\` and on its own`, help: 'keep the one in `page`' }

    return {
      ...setting.local,
      message: `\`${setting.name}\` is a setting of \`page\`, not an export of its own`,
      note: 'one `export const page = { ... }` holds every setting of a page, typed and completed in the editor',
      help: taken ? `rename the fence's own \`page\`, then move it into \`export const page = { ${setting.name}: ... }\`` : `move it into \`export const page = { ${setting.name}: ... }\``,
      fixes: fix && movable.includes(setting) ? [fix] : [],
    }
  })
}

function moveIntoPage(source: string, page: PageSettings | undefined, settings: SeparateSetting[]): Fix {
  const entries = settings.map(setting => `${setting.name}: ${indentValue(setting.value)}`)
  const removals = settings.map(setting => ({ start: setting.statement.start, end: lineEnd(source, setting.statement.end), text: '' }))
  const title = `Move ${settings.length === 1 ? 'it' : 'them'} into \`page\``

  if (!page) {
    const [first, ...rest] = removals
    const single = entries.length === 1 && !entries[0]!.includes('\n')
    const text = single ? `export const page = { ${entries[0]} }\n` : `export const page = {\n${entries.map(entry => `  ${entry},\n`).join('')}}\n`

    return { title, edits: [{ ...first!, text }, ...rest], safe: true }
  }

  const inside = source.slice(page.object.start + 1, page.object.end - 1)
  const multiLine = inside.includes('\n')
  const trimmed = inside.trimEnd()
  const end = page.object.start + 1 + trimmed.length
  let text: string

  if (trimmed.trim() === '')
    text = multiLine ? `\n${entries.map(entry => `  ${entry},`).join('\n')}` : ` ${entries.join(', ')} `
  else if (multiLine)
    text = `${trimmed.endsWith(',') ? '' : ','}\n${entries.map(entry => `  ${entry},`).join('\n')}`
  else
    text = `${trimmed.endsWith(',') ? '' : ','} ${entries.join(', ')}`

  return { title, edits: [{ start: end, end, text }, ...removals], safe: true }
}

// A value moving into `page` one level deeper, unless a template literal's own lines would change with it.
function indentValue(value: string): string {
  return value.includes('`') ? value : value.replaceAll(LINE_WITH_TEXT, '\n  ')
}

// Past the line break ending a statement, so its line goes with it.
function lineEnd(source: string, end: number): number {
  const at = source.slice(end).search(NON_SPACE_OR_NEWLINE)

  return at !== -1 && source[end + at] === '\n' ? end + at + 1 : end
}

// What the quick fix bounds a string field to: room for a title or a name.
const SUGGESTED_MAX_LENGTH = 200

// Where and what to insert to bound a string field: a new options object, the first property of an empty one, or a property before the others.
function maxLengthEdit(call: t.CallExpression, options: t.CallExpression['arguments'][number] | undefined): { at: number, text: string } {
  if (options === undefined)
    return { at: call.end! - 1, text: `{ maxLength: ${SUGGESTED_MAX_LENGTH} }` }

  if (options.type === 'ObjectExpression' && options.properties.length === 0)
    return { at: options.start! + 1, text: ` maxLength: ${SUGGESTED_MAX_LENGTH} ` }

  return { at: (options as t.ObjectExpression).properties[0]!.start!, text: `maxLength: ${SUGGESTED_MAX_LENGTH}, ` }
}

// A string field of an action's schema with no `maxLength` takes whatever a visitor posts into it, up to the request body limit. A secret, such as a password, is checked or hashed rather than kept or shown, so it needs none.
export function unboundedFields(server: ServerAnalysis | undefined): Diagnostic[] {
  const fence = server?.fence

  if (!fence?.code.includes('String'))
    return []

  const diagnostics: Diagnostic[] = []

  eachNode(fence.ast.program, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'action' || !node.arguments[0] || node.arguments[0].type === 'ArrowFunctionExpression' || node.arguments[0].type === 'FunctionExpression')
      return

    schemaStrings(node.arguments[0], undefined, (call, field) => {
      const options = call.arguments[0]
      const known = options === undefined || (options.type === 'ObjectExpression' && options.properties.every(property => property.type !== 'SpreadElement'))

      if (!known || (options?.type === 'ObjectExpression' && options.properties.some(property => property.type !== 'SpreadElement' && propertyKey(property) === 'maxLength')) || (field !== undefined && isSecret(field)))
        return

      const edit = maxLengthEdit(call, options)
      const at = fence.offset + edit.at

      diagnostics.push({
        ...fence.shift(call.callee),
        code: 'unbounded-string',
        message: `${field === undefined ? 'This string field' : `The string field ${field}`} has no maxLength`,
        note: 'it takes whatever a visitor posts, up to the request body limit',
        help: 'give it one',
        fixes: [{ title: `Give it a maxLength of ${SUGGESTED_MAX_LENGTH}`, edits: [{ start: at, end: at, text: edit.text }] }],
        checkOnly: true,
      })
    })
  })

  return diagnostics
}

// The name a property key writes: an identifier read as written unless computed, or a string literal.
function memberName(key: t.Node, computed: boolean): string | undefined {
  if (key.type === 'StringLiteral')
    return key.value

  return key.type === 'Identifier' && !computed ? key.name : undefined
}

interface Named { name: string }

// The names a namespace import hands out that moved, read off it (`server.invalidatePage`, `server['invalidatePage']`) or destructured from it (`const { invalidatePage } = server`), as the node writing the name.
// Babel's scopes tell the namespace from an inner binding of the same name; a fence giving it none, a name declared twice, is read by name alone.
function namespaceReads<Entry extends Named>(fence: ParsedFence, namespaces: Map<t.ImportNamespaceSpecifier, Entry[]>): { key: t.Node, moved: Entry }[] {
  if (namespaces.size === 0)
    return []

  const found: { key: t.Node, moved: Entry }[] = []
  const movedBy = (object: t.Node | null | undefined, name: string | undefined, scope: NodePath['scope'] | undefined): Entry | undefined => {
    if (object?.type !== 'Identifier')
      return undefined

    const bound = scope?.getBinding(object.name)?.path.node
    const specifier = [...namespaces.keys()].find(entry => scope ? entry === bound : entry.local.name === object.name)

    return specifier && namespaces.get(specifier)?.find(entry => entry.name === name)
  }
  const destructured = (pattern: t.ObjectPattern, init: t.Node | null | undefined, scope: NodePath['scope'] | undefined) => {
    for (const property of pattern.properties) {
      if (property.type !== 'ObjectProperty')
        continue

      const moved = movedBy(init, memberName(property.key, property.computed), scope)

      if (moved)
        found.push({ key: property.key, moved })
    }
  }
  const visit = (node: t.Node, scope: NodePath['scope'] | undefined): void => {
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      const { property } = node
      const moved = movedBy(node.object, memberName(property, node.computed), scope)

      if (moved)
        found.push({ key: property, moved })
    }
    else if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern') {
      destructured(node.id, node.init, scope)
    }
    // `({ invalidatePage } = server)` and a parameter defaulting to the namespace, `({ invalidatePage } = server) => {}`.
    else if ((node.type === 'AssignmentExpression' || node.type === 'AssignmentPattern') && node.left.type === 'ObjectPattern') {
      destructured(node.left, node.right, scope)
    }
  }

  try {
    loadTraverse()(fence.ast, { enter: (path: NodePath) => visit(path.node, path.scope) })
  }
  catch {
    found.length = 0

    for (const statement of fence.ast.program.body)
      eachNode(statement, (node) => { visit(node, undefined) })
  }

  return found
}

// What `kay/cache` exports to the server alone: the browser's entry has `cached` and `invalidate`, though the types of the one entry name every export.
const SERVER_ONLY_CACHE = ['invalidatePage', 'sqliteCache']

// A server-only name of `kay/cache` imported by a fence that runs in the browser, which the build refuses with a missing export.
export function serverOnlyImports(fence: ParsedFence): Diagnostic[] {
  if (!fence.code.includes('kay/cache'))
    return []

  const diagnostics: Diagnostic[] = []
  const namespaces = new Map<t.ImportNamespaceSpecifier, Named[]>()
  const report = (node: t.Node, name: string) => diagnostics.push({
    ...fence.shift(node),
    code: 'server-only-import',
    message: `\`${name}\` is exported to the server alone, and this code runs in the browser`,
    note: 'the browser\'s `kay/cache` has `cached` and `invalidate`',
    help: 'call it from a `--- server` fence or an action, and keep this import there',
    checkOnly: true,
  })

  for (const node of fence.ast.program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== 'kay/cache' || node.importKind === 'type')
      continue

    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        namespaces.set(specifier, SERVER_ONLY_CACHE.map(name => ({ name })))
      }
      else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type') {
        const name = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value

        if (SERVER_ONLY_CACHE.includes(name))
          report(specifier, name)
      }
    }
  }

  for (const { key, moved } of namespaceReads(fence, namespaces))
    report(key, moved.name)

  return diagnostics
}

const CSS_BINDING = /\bimport\b[^;'"]+from\s*['"][^'"\n]+\.css['"]/

// A stylesheet imported for a value with no `with { type: 'text' }`: kay types it as the text it gives with the attribute, which Bun gives only with it.
export function cssImportsWithoutText(fence: ParsedFence): Diagnostic[] {
  if (!CSS_BINDING.test(fence.code))
    return []

  return fence.ast.program.body.flatMap((node) => {
    if (node.type !== 'ImportDeclaration' || !node.source.value.endsWith('.css') || node.specifiers.length === 0 || node.importKind === 'type')
      return []

    if ((node.attributes ?? []).some(({ key, value }) => (key.type === 'Identifier' ? key.name : key.value) === 'type' && value.value === 'text'))
      return []

    return [{
      ...fence.shift(node),
      code: 'css-import-without-text',
      message: `${node.source.value} is imported for a value without \`with { type: 'text' }\``,
      note: 'Bun gives such an import its text only with the attribute',
      help: 'add `with { type: \'text\' }` for the file\'s text, or import it with no name for the page\'s stylesheets',
      checkOnly: true,
    }]
  })
}

// Every `s.String(...)` call in a schema, with the name of the field it types, the nearest property holding it.
function schemaStrings(node: t.Node | null | undefined, field: string | undefined, found: (call: t.CallExpression, field: string | undefined) => void): void {
  eachNode(node, (inner) => {
    if (inner.type === 'ObjectProperty')
      schemaStrings(inner.value, propertyKey(inner) ?? field, found)
    else if (inner.type === 'CallExpression' && inner.callee.type === 'MemberExpression' && inner.callee.property.type === 'Identifier' && inner.callee.property.name === 'String')
      found(inner, field)

    // A property's value is walked above, under the property's own name.
    return inner.type !== 'ObjectProperty'
  })
}

function propertyKey(property: t.ObjectProperty | t.ObjectMethod): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'StringLiteral' ? property.key.value : undefined
}

const AI_PACKAGE = '@kaynooo/kayjs-ai'
const ASYNC_KEYWORD = /^(?:(?:static|public|private|protected|override)\s+)*(async\s+)/

type FunctionNode = t.ArrowFunctionExpression | t.FunctionExpression | t.FunctionDeclaration | t.ObjectMethod | t.ClassMethod | t.ClassPrivateMethod

function isFunction(node: t.Node): node is FunctionNode {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'ObjectMethod' || node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod'
}

// What the function itself returns and whether it awaits, its inner functions left alone.
function returnsAndAwaits(fn: FunctionNode): { returned: t.Node[], awaits: boolean } {
  const returned: t.Node[] = fn.body.type === 'BlockStatement' ? [] : [fn.body]
  let awaits = false

  eachNode(fn.body, (node) => {
    if (isFunction(node))
      return false

    if (node.type === 'ReturnStatement' && node.argument)
      returned.push(node.argument)
    else if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await))
      awaits = true

    return true
  })

  return { returned, awaits }
}

// An `async` function returning `ask()` from kayjs-ai: the async function awaits the reply, which is a thenable, so the answer arrives as its whole text and the action or `await` block reading it never streams. Without an `await` in it, `async` can go; with one, the reply is returned as `.stream()`.
export function asyncReplies(fence: ParsedFence): Diagnostic[] {
  if (!fence.code.includes(AI_PACKAGE) || !fence.code.includes('async'))
    return []

  const names = new Set<string>()
  const namespaces = new Set<string>()

  for (const node of fence.ast.program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== AI_PACKAGE || node.importKind === 'type')
      continue

    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier')
        namespaces.add(specifier.local.name)
      else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === 'ask')
        names.add(specifier.local.name)
    }
  }

  if (names.size === 0 && namespaces.size === 0)
    return []

  const isAsk = (node: t.Node): node is t.CallExpression => node.type === 'CallExpression' && (node.callee.type === 'Identifier'
    ? names.has(node.callee.name)
    : node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier' && namespaces.has(node.callee.object.name) && node.callee.property.type === 'Identifier' && node.callee.property.name === 'ask')
  const diagnostics: Diagnostic[] = []

  eachNode(fence.ast.program, (node) => {
    if (!isFunction(node) || !node.async || ((node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') && node.generator))
      return

    const { returned, awaits } = returnsAndAwaits(node)
    const keyword = ASYNC_KEYWORD.exec(fence.code.slice(node.start!))

    for (const call of returned.filter(isAsk)) {
      diagnostics.push({
        ...fence.shift(call),
        code: 'async-reply',
        message: 'This `ask()` is returned from an `async` function, which awaits it: the answer arrives as its whole text, with no streaming',
        note: 'the reply is a thenable async iterable, and an action or an `await` block streams it only when it is returned as it is',
        help: awaits ? 'return `ask(...).stream()`, which an `async` function hands on as it is' : 'remove `async`',
        fixes: !awaits && keyword ? [{ title: 'Remove `async`', edits: [{ start: fence.offset + node.start! + keyword.index + keyword[0].length - keyword[1]!.length, end: fence.offset + node.start! + keyword[0].length, text: '' }], safe: true }] : [],
      })
    }
  })

  return diagnostics
}

// The checks a plain module takes, parsed only when one of them may find something.
// A module the browser bundle reaches (`browser`) is checked for the names the browser's entries lack as well.
export function moduleChecks(source: string, browser = false): Diagnostic[] {
  if (!CSS_BINDING.test(source) && !(browser && source.includes('kay/cache')) && !(source.includes(AI_PACKAGE) && source.includes('async')))
    return []

  const whole = { start: 0, end: source.length }
  const recovered = parseFence(source, whole, [], false)

  // Babel's own recovery keeps every statement for the checks; a module it cannot read, or whose scopes it cannot build, is read again with its broken statements blanked.
  try {
    if (recovered)
      return checksOf(recovered, browser)
  }
  catch {}

  const module = parseFence(source, whole, [])

  return module ? checksOf(module, browser) : []
}

function checksOf(module: ParsedFence, browser: boolean): Diagnostic[] {
  return [...cssImportsWithoutText(module), ...asyncReplies(module), ...browser ? serverOnlyImports(module) : []]
}
