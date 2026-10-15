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
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'action' || !node.arguments[0])
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

const KAY_SCHEMA_T = /\{[^}]*\bt\b[^}]*\}\s*from\s*['"]kay['"]/

// `t` imported from 'kay', the schema builder's name before `s`.
// The fix renames it throughout the fence, or imports `s as t` where `s` is taken or `t` is read where the fix cannot reach, such as a template (`renamable` false).
export function deprecatedSchemaNames(fence: ParsedFence, renamable = true): Diagnostic[] {
  if (!KAY_SCHEMA_T.test(fence.code))
    return []

  const diagnostics: Diagnostic[] = []
  const span = fence.shift

  // Babel gives no scopes to a fence declaring a name twice, which the type check reports already.
  try {
    loadTraverse()(fence.ast, {
      ImportSpecifier(path: NodePath<t.ImportSpecifier>) {
        const { imported, local } = path.node
        const declaration = path.parent as t.ImportDeclaration

        if (declaration.source.value !== 'kay' || imported.type !== 'Identifier' || imported.name !== 't')
          return

        const references = local.name === 't' ? path.scope.getBinding('t')?.referencePaths ?? [] : []
        const rename = renamable && local.name === 't' && !path.scope.hasBinding('s') && references.every(reference => !reference.scope.hasBinding('s'))
        let edits = [{ ...span(imported), text: 's' }]

        if (local.name === 't')
          edits = rename ? [path.node, ...references.map(reference => reference.node)].map(node => ({ ...span(node), text: 's' })) : [{ ...span(path.node), text: 's as t' }]

        diagnostics.push({
          ...span(imported),
          code: 'deprecated-schema-name',
          message: '`t` from \'kay\' is `s` now',
          note: '`t` is left to translations, which every template reads without an import',
          help: 'import `s` and build schemas with `s.Object(...)`',
          fixes: [{ title: rename ? 'Rename it `s`' : 'Import `s`', edits, safe: true }],
          checkOnly: true,
        })
      },
    })
  }
  catch {
    return []
  }

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
  if (!KAY_SCHEMA_T.test(source) && !CSS_BINDING.test(source))
    return []

  const module = parseFence(source, { start: 0, end: source.length }, [])

  return module ? [...deprecatedSchemaNames(module), ...cssImportsWithoutText(module)] : []
}
