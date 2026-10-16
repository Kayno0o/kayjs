// The checks a fence takes once parsed, beside what analyzing it reports: a schema field with no bound, a renamed import, a stylesheet imported for its text without asking, a page setting outside `page`.

import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic, Fix } from './ast'
import type { PageSettings, ParsedFence, SeparateSetting, ServerAnalysis } from './script'
import { isSecret } from '../runtime/form'
import { PAGE } from './page-settings'
import { loadTraverse } from './rewrite'
import { eachNode, parseFence } from './script'

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

// Names that changed entry point: kay's own entries each hold one kind of name (`kay` what browser code may run, `kay/server` what only the server does, a topic's entry its topic), and these were elsewhere.
const MOVED_IMPORTS = [{ name: 'invalidatePage', from: 'kay/server', to: 'kay/cache' }]
const MOVED_NAME = new RegExp(`\\b(?:${MOVED_IMPORTS.map(({ name }) => name).join('|')})\\b`)

interface Edit { start: number, end: number, text: string }
type Moving = t.ImportDeclaration | t.ExportNamedDeclaration
type NamedSpecifier = t.ImportSpecifier | t.ExportSpecifier

const COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\//y
const ONLY_COMMA = /^\s*,\s*$/

// The index of the first comma between two offsets that no comment holds.
function commaBetween(code: string, from: number, to: number): number {
  for (let index = from; index < to; index++) {
    if (code[index] === ',')
      return index

    if (code[index] === '/') {
      COMMENT.lastIndex = index
      const comment = COMMENT.exec(code)

      if (comment)
        index += comment[0].length - 1
    }
  }

  return -1
}

// The edits taking one specifier out of the braces, leaving the comments around it where they were.
function removeSpecifier(code: string, specifiers: t.Node[], index: number): Edit[] {
  const specifier = specifiers[index]!
  const next = specifiers[index + 1]
  const previous = specifiers[index - 1]
  const own = { start: specifier.start!, end: specifier.end!, text: '' }

  if (next) {
    if (ONLY_COMMA.test(code.slice(specifier.end!, next.start!)))
      return [{ ...own, end: next.start! }]

    const comma = commaBetween(code, specifier.end!, next.start!)

    return comma === -1 ? [own] : [own, { start: comma, end: comma + 1, text: '' }]
  }

  if (previous && ONLY_COMMA.test(code.slice(previous.end!, specifier.start!)))
    return [{ ...own, start: previous.end! }]

  return [own]
}

// The comments written between two offsets of the fence, as written.
function commentsIn(fence: ParsedFence, start: number, end: number): string[] {
  return (fence.ast.comments ?? []).filter(comment => comment.start! >= start && comment.end! <= end).map(comment => fence.code.slice(comment.start, comment.end))
}

function isNamed(specifier: t.Node): specifier is NamedSpecifier {
  return specifier.type === 'ImportSpecifier' || specifier.type === 'ExportSpecifier'
}

function kindOf(node: Moving): string | null | undefined {
  return node.type === 'ImportDeclaration' ? node.importKind : node.exportKind
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
  const visit = (node: t.Node, scope: NodePath['scope'] | undefined): void => {
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      const { property } = node
      const moved = movedBy(node.object, memberName(property, node.computed), scope)

      if (moved)
        found.push({ key: property, moved })
    }
    else if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern') {
      for (const property of node.id.properties) {
        if (property.type !== 'ObjectProperty')
          continue

        const moved = movedBy(node.init, memberName(property.key, property.computed), scope)

        if (moved)
          found.push({ key: property.key, moved })
      }
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

// A name imported, re-exported, read off a namespace or destructured from one from the entry it left. The fix points the whole statement at the new entry when the name is alone in it, merges the name into the statement already naming that entry, else takes it out and adds a statement after it; a namespace read is reported with no fix, as none renames it safely, and only where the namespace binding is the one in scope.
export function deprecatedImports(fence: ParsedFence): Diagnostic[] {
  if (!MOVED_NAME.test(fence.code))
    return []

  const span = fence.shift
  const code = fence.code
  const body = fence.ast.program.body
  const diagnostics: Diagnostic[] = []
  const namespaces = new Map<t.ImportNamespaceSpecifier, typeof MOVED_IMPORTS>()

  for (const node of body) {
    if (node.type !== 'ImportDeclaration' && !(node.type === 'ExportNamedDeclaration' && node.source))
      continue

    const source = node.source!.value
    const keyword = node.type === 'ImportDeclaration' ? 'import' : 'export'
    const named = (node.specifiers as t.Node[]).filter(isNamed)
    const others = node.specifiers.length - named.length

    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier')
          namespaces.set(specifier, MOVED_IMPORTS.filter(({ from }) => from === source))
      }
    }

    for (const [index, specifier] of named.entries()) {
      const name = specifier.type === 'ImportSpecifier' ? specifier.imported : specifier.local
      const imported = name.type === 'Identifier' ? name.name : name.value
      const moved = MOVED_IMPORTS.find(entry => entry.name === imported && entry.from === source)

      if (!moved)
        continue

      const written = code.slice(specifier.start!, specifier.end!)
      const kind = kindOf(node) === 'type' ? 'type ' : ''
      // A statement of the same kind already naming the new entry takes the name into its braces.
      const target = body.find((other): other is Moving => other !== node && other.type === node.type && (other).source?.value === moved.to && kindOf(other) === kindOf(node) && (other).specifiers.some(isNamed))
      const targetLast = target?.specifiers.filter(isNamed).at(-1)
      const whole = named.length === 1 && others === 0
      let edits: Edit[]

      if (whole && !target) {
        edits = [{ ...span(node.source!), text: `'${moved.to}'` }]
      }
      else if (whole) {
        // The comments written inside the statement stay, ahead of the import the name went into.
        edits = [{ ...span({ start: node.start!, end: node.end! + (code[node.end!] === '\n' ? 1 : 0) } as t.Node), text: commentsIn(fence, node.start!, node.end!).map(comment => `${comment}\n`).join('') }]
      }
      else if (named.length === 1) {
        // A default import stays, and the braces go with the only name in them, their comments with them.
        const braces = { start: node.specifiers.find(entry => !isNamed(entry))!.end!, end: code.lastIndexOf('}', node.source!.start!) + 1 }

        edits = [{ ...span(braces as t.Node), text: commentsIn(fence, braces.start, braces.end).map(comment => comment.startsWith('//') ? ` ${comment}\n` : ` ${comment}`).join('') }]
      }
      else {
        edits = removeSpecifier(code, named, index).map(edit => ({ ...span(edit as unknown as t.Node), text: '' }))
      }

      const already = target?.specifiers.filter(isNamed).some(entry => code.slice(entry.start!, entry.end!) === written)

      if (targetLast && !already)
        edits.push({ ...span({ start: targetLast.end!, end: targetLast.end! } as t.Node), text: `, ${written}` })
      else if (!target && !whole)
        edits.push({ ...span({ start: node.end!, end: node.end! } as t.Node), text: `\n${keyword} ${kind}{ ${written} } from '${moved.to}'` })

      diagnostics.push({
        ...span(specifier),
        code: 'deprecated-import',
        message: `\`${moved.name}\` is ${keyword === 'import' ? 'imported' : 're-exported'} from '${moved.to}' now, not '${moved.from}'`,
        note: `'${moved.to}' holds the helpers of the same job, \`invalidate\` beside it`,
        help: `${keyword} it from '${moved.to}'`,
        fixes: [{ title: `${keyword === 'import' ? 'Import' : 'Export'} it from '${moved.to}'`, edits, safe: true }],
        checkOnly: true,
      })
    }
  }

  for (const { key, moved } of namespaceReads(fence, namespaces)) {
    diagnostics.push({
      ...span(key),
      code: 'deprecated-import',
      message: `\`${moved.name}\` is imported from '${moved.to}' now, not '${moved.from}'`,
      note: `'${moved.to}' holds the helpers of the same job, \`invalidate\` beside it`,
      help: `import it from '${moved.to}' by name`,
      checkOnly: true,
    })
  }

  return diagnostics
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

// The checks a plain module takes, parsed only when one of them may find something.
export function moduleChecks(source: string): Diagnostic[] {
  if (!CSS_BINDING.test(source) && !MOVED_NAME.test(source))
    return []

  const whole = { start: 0, end: source.length }
  const recovered = parseFence(source, whole, [], false)

  // Babel's own recovery keeps every statement for the checks; a module it cannot read, or whose scopes it cannot build, is read again with its broken statements blanked.
  try {
    if (recovered)
      return [...deprecatedImports(recovered), ...cssImportsWithoutText(recovered)]
  }
  catch {}

  const module = parseFence(source, whole, [])

  return module ? [...deprecatedImports(module), ...cssImportsWithoutText(module)] : []
}
