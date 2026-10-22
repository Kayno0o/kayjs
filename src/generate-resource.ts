const NAME = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i
const FIELD = /^([a-z][a-z0-9]*):([a-z]+)$/i
const CAMEL_BREAK = /([a-z0-9])([A-Z])/g
const SEPARATORS = /[-_\s]+/
// A word ending in a single `s` (`news`, `ideas`, `menus`) is a plural already, unless it is one of the singular words below or ends in `ss` (`class`).
const PLURAL_S = /[^s]s$/
const SINGULAR_S = new Set(['alias', 'analysis', 'atlas', 'axis', 'basis', 'bias', 'bonus', 'bus', 'campus', 'canvas', 'census', 'chaos', 'crisis', 'diagnosis', 'focus', 'gas', 'genus', 'iris', 'lens', 'nexus', 'plus', 'radius', 'status', 'syllabus', 'thesis', 'virus'])
// Irregular words, each to its plural; a plural maps to itself.
const IRREGULAR = new Map([['person', 'people'], ['people', 'people'], ['child', 'children'], ['children', 'children'], ['man', 'men'], ['men', 'men'], ['woman', 'women'], ['women', 'women'], ['mouse', 'mice'], ['mice', 'mice'], ['foot', 'feet'], ['feet', 'feet'], ['tooth', 'teeth'], ['teeth', 'teeth']])
const PLURAL_ES = /(?:[sxz]|ch|sh)$/
const PLURAL_IES = /[^aeiou]y$/
const LINE_BREAK = /\r?\n/
// Names a column, a local of the generated files or an import of theirs would collide with, besides the words JavaScript reserves.
const TAKEN = new Set(['action', 'columns', 'create', 'ctx', 'db', 'fields', 'id', 'input', 'props', 'remove', 's', 'update', 'values', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'eval', 'arguments', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield'])
const TAKEN_PASCAL = new Set(['Button', 'Column', 'Database', 'FormDialog', 'FormField', 'Object', 'SaveForm', 'Table'])

type FieldType = 'string' | 'text' | 'int' | 'float' | 'boolean'

interface Field {
  name: string
  label: string
  type: FieldType
}

interface TypeDescription {
  // The pg-orm column, the schema of the action, a sample value for the test and what the list shows for it.
  column: string
  schema: string
  sample: string
  // The sample as a form posts it, text.
  posted: string
  shown: string
}

// The range of a 4-byte column, which a bare integer schema would let a post exceed.
const INT4 = '{ minimum: -2147483648, maximum: 2147483647 }'

const TYPES: Record<FieldType, TypeDescription> = {
  string: { column: 'f.varchar(200)', schema: 's.String({ minLength: 1, maxLength: 200 })', sample: '\'First\'', posted: '\'First\'', shown: 'First' },
  text: { column: 'f.text()', schema: 's.String({ minLength: 1, maxLength: 10_000 })', sample: '\'Some text\'', posted: '\'Some text\'', shown: 'Some text' },
  int: { column: 'f.integer()', schema: `s.Integer(${INT4})`, sample: '42', posted: '\'42\'', shown: '42' },
  float: { column: 'f.doublePrecision()', schema: 's.Number()', sample: '4.25', posted: '\'4.25\'', shown: '4.25' },
  boolean: { column: 'f.boolean().default(false)', schema: 's.Boolean()', sample: 'true', posted: '\'on\'', shown: 'true' },
}

const ALIASES: Record<string, FieldType> = { string: 'string', text: 'text', int: 'int', integer: 'int', float: 'float', number: 'float', boolean: 'boolean', bool: 'boolean' }

export interface ResourceProject {
  tailwind: boolean
  tests: boolean
  // Whether kayjs-ui is installed, which the pages are then drawn with.
  ui: boolean
  auth: boolean
  // Whether `src/auth.ts` exports the app's own `auth` (the form before `auth()` alone), which a test imports to sign in; else `authTest` of kayjs-auth does.
  authModule?: boolean | undefined
}

interface Names {
  // `Blog post` and `Blog posts`.
  label: string
  plural: string
  // The table's name and its pg-orm export: `blog_post`, `BlogPost`, and the file `blog-post`.
  table: string
  pascal: string
  slug: string
  // The row's variable and the list's: `blogPost`, `blogPosts`.
  row: string
  rows: string
  // The component drawing the list with kayjs-ui: `blog-posts-table`, `BlogPostsTable`.
  tableFile: string
  tableComponent: string
  // The route folder: `blog-posts`.
  folder: string
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

function pluralOf(word: string): string {
  const irregular = IRREGULAR.get(word)

  if (irregular !== undefined)
    return irregular

  if (PLURAL_S.test(word) && !SINGULAR_S.has(word))
    return word

  if (PLURAL_ES.test(word))
    return `${word}es`

  return PLURAL_IES.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`
}

function wordsOf(name: string): string[] {
  return name.replace(CAMEL_BREAK, '$1 $2').split(SEPARATORS).map(word => word.toLowerCase())
}

function namesOf(name: string, pluralName?: string): Names {
  if (pluralName !== undefined && !NAME.test(pluralName))
    throw new Error(`kay generate: \`${pluralName}\` is not a plural for a resource: write letters and digits, separated by \`-\` or \`_\`, such as \`ideas\` or \`blog-posts\``)

  if (!NAME.test(name))
    throw new Error(`kay generate: \`${name}\` is not a name for a resource: write letters and digits, separated by \`-\` or \`_\`, such as \`post\` or \`blog-post\``)

  const words = wordsOf(name)
  const plurals = pluralName === undefined ? [...words.slice(0, -1), pluralOf(words.at(-1)!)] : wordsOf(pluralName)
  const camel = (list: string[]) => list.map((word, index) => index === 0 ? word : capitalize(word)).join('')
  const names: Names = {
    label: capitalize(words.join(' ')),
    plural: capitalize(plurals.join(' ')),
    table: words.join('_'),
    pascal: words.map(capitalize).join(''),
    slug: words.join('-'),
    row: camel(words),
    rows: camel(plurals) === camel(words) ? `${camel(words)}List` : camel(plurals),
    tableFile: `${plurals.join('-')}-table`,
    tableComponent: `${plurals.map(capitalize).join('')}Table`,
    folder: plurals.join('-'),
  }

  if (TAKEN.has(names.row) || TAKEN.has(names.rows) || TAKEN_PASCAL.has(names.pascal))
    throw new Error(`kay generate: \`${name}\` names something the generated files use: write another name for the resource`)

  return names
}

// The fields `name:type` write, each a distinct word the generated files do not use themselves.
export function parseFields(specs: readonly string[]): Field[] {
  if (specs.length === 0)
    throw new Error('kay generate: a resource has at least one field: write `name:type`, such as `title:string`, with the types string, text, int, float and boolean')

  const fields: Field[] = []

  for (const spec of specs) {
    const [, name, kind] = FIELD.exec(spec) ?? []
    const type = ALIASES[kind?.toLowerCase() ?? '']

    if (name === undefined || type === undefined)
      throw new Error(`kay generate: \`${spec}\` is not a field: write \`name:type\` with a type among string, text, int, float and boolean`)

    if (TAKEN.has(name))
      throw new Error(`kay generate: \`${name}\` cannot be a field, the generated files use it: write another name`)

    if (fields.some(field => field.name === name))
      throw new Error(`kay generate: the field \`${name}\` is written twice`)

    fields.push({ name, type, label: capitalize(wordsOf(name).join(' ')) })
  }

  return fields
}

function tableFile(names: Names, fields: readonly Field[]): string {
  const columns = fields.map(field => `  ${field.name}: ${TYPES[field.type].column},`).join('\n')

  return `import { defineTable } from '@kaynooo/pg-orm'\n\nexport const ${names.pascal} = defineTable('${names.table}', f => ({\n  id: f.serial().primaryKey(),\n${columns}\n}))\n`
}

function actionsFile(names: Names, fields: readonly Field[]): string {
  const schemas = fields.map(field => `  ${field.name}: ${TYPES[field.type].schema},`).join('\n')
  const list = `/${names.folder}`

  return `--- server
import { s } from 'kay'
import { db } from '../../db'
import { ${names.pascal} } from '../../db/${names.slug}'

const fields = {
${schemas}
}

export const create = action(s.Object(fields), async (input, ctx) => {
  await db.repo(${names.pascal}).write.insertOne(input)

  return ctx.redirect('${list}')
})

export const update = action(s.Object({ id: s.Integer(${INT4}), ...fields }), async ({ id, ...values }, ctx) => {
  await db.repo(${names.pascal}).write.updateOne(values, { id })

  return ctx.redirect('${list}')
})

export const remove = action(s.Object({ id: s.Integer(${INT4}) }), async ({ id }, ctx) => {
  await db.repo(${names.pascal}).write.deleteOne({ id })

  return ctx.redirect('${list}')
})
`
}

// The controls of the create and edit forms, one per field, indented by `depth` levels; `row` fills them with a row's values.
function controls(fields: readonly Field[], ui: boolean, row: string | undefined, depth: number): string[] {
  const pad = '  '.repeat(depth)
  const lines: string[] = []

  for (const { name, label, type } of fields) {
    const value = row === undefined ? '' : ` value={${row}.${name}}`
    const checked = row === undefined ? '' : ` checked={${row}.${name}}`
    const step = type === 'int' ? '1' : 'any'

    if (ui) {
      lines.push(`${pad}FormField(label="${label}" name="${name}"${type === 'boolean' ? '' : ' required'})`)

      if (type === 'boolean')
        lines.push(`${pad}  input(type="checkbox" name="${name}"${checked})`)
      else if (type === 'text')
        lines.push(`${pad}  textarea.kui-field-input(name="${name}" rows="6" maxlength="10000" required)`, ...row === undefined ? [] : [`${pad}    | {${row}.${name}}`])
      else if (type === 'string')
        lines.push(`${pad}  input.kui-field-input(name="${name}" maxlength="200" required${value})`)
      else
        lines.push(`${pad}  input.kui-field-input(type="number" name="${name}" step="${step}" required${value})`)

      continue
    }

    lines.push(`${pad}label`)

    if (type === 'boolean') {
      lines.push(`${pad}  input(field="${name}" type="checkbox"${checked})`, `${pad}  | ${label}`)
    }
    else {
      lines.push(`${pad}  | ${label}`)

      if (type === 'text')
        lines.push(`${pad}  textarea(field="${name}" rows="6")`, ...row === undefined ? [] : [`${pad}    | {${row}.${name}}`])
      else
        lines.push(`${pad}  input(field="${name}"${type === 'string' ? '' : ` type="number" step="${step}"`}${value})`)
    }

    lines.push(`${pad}error ${name}`)
  }

  return lines
}

function listPage(names: Names, fields: readonly Field[], project: ResourceProject): string {
  const { row, rows, pascal, plural, label, folder, slug } = names
  const heading = `h1${project.tailwind ? '.text-2xl.font-bold' : ''} ${plural}`
  const server = `--- server\nimport { db } from '../../db'\nimport { ${pascal} } from '../../db/${slug}'\n\nconst ${rows} = await db.repo(${pascal}).read.findMany(q => q.orderBy('id', 'desc'))\n`
  const first = fields[0]!
  const edit = `a(href={\`/${folder}/\${${row}.id}/edit\`}) {${row}.${first.name}}`

  if (project.ui) {
    return `${server}--- script
import ${names.tableComponent} from '../../components/${names.tableFile}.kay'
import New${pascal} from '../../components/new-${slug}.kay'
---
head
  title ${plural}
div${project.tailwind ? '.flex.flex-wrap.items-center.justify-between.gap-4' : ''}
  ${heading}
  New${pascal}
${names.tableComponent}(rows={${rows}})
`
  }

  const head = fields.map(field => `        th ${field.label}`).join('\n')
  const cells = fields.map((field, index) => index === 0 ? `          td\n            ${edit}` : `          td {${row}.${field.name}}`).join('\n')

  return `${server}---
head
  title ${plural}
${heading}
a(href="/${folder}/new") New ${label.toLowerCase()}
if ${rows}.length === 0
  p No ${plural.toLowerCase()} yet.
else
  table
    thead
      tr
${head}
    tbody
      for ${row} of ${rows} key={${row}.id}
        tr
${cells}
`
}

// The table is an island of its own: a page with a server fence sends an island no function, and its cell is one.
function tableComponent(names: Names, fields: readonly Field[]): string {
  const { row, pascal, plural, folder, slug } = names
  const columns = fields.map(({ name, label, type }, index) => `  { key: '${name}', header: '${label}', sortValue: true${index === 0 ? ', cell: true' : ''}${type === 'int' || type === 'float' ? ', numeric: true' : ''} },`).join('\n')

  return `---
// kay-island
import type { Column } from '@kaynooo/kayjs-ui'
import type { InferEntity } from '@kaynooo/pg-orm'
import type { ${pascal} } from '../db/${slug}'
import Table from '@kaynooo/kayjs-ui/table.kay'

type Row = InferEntity<typeof ${pascal}>

const { rows } = props<{ rows: Row[] }>()

const columns: Column<Row>[] = [
${columns}
]
---
Table(columns={columns} rows={rows} rowKey="id")
  @cell(${row})
    a(href={\`/${folder}/\${${row}.id}/edit\`}) {${row}.${fields[0]!.name}}
  @empty
    p No ${plural.toLowerCase()} yet.
`
}

function newPage(names: Names, fields: readonly Field[], project: ResourceProject): string {
  const { label, folder } = names
  const heading = `h1${project.tailwind ? '.text-2xl.font-bold' : ''} New ${label.toLowerCase()}`

  return `--- server\nimport { create } from './_actions.kay'\n---\nhead\n  title New ${label.toLowerCase()}\n${heading}\nform(action={create})\n${controls(fields, false, undefined, 1).join('\n')}\n  button Create\na(href="/${folder}") Back\n`
}

function editPage(names: Names, fields: readonly Field[], project: ResourceProject): string {
  const { row, pascal, label, folder, slug } = names
  const heading = `h1${project.tailwind ? '.text-2xl.font-bold' : ''} Edit ${label.toLowerCase()}`
  const server = `--- server\nimport { db } from '../../../db'\nimport { ${pascal} } from '../../../db/${slug}'\nimport { remove, update } from '../_actions.kay'\n\nconst ${row} = await db.repo(${pascal}).read.findById(ctx.params.id) ?? ctx.notFound()\n`
  const head = `head\n  title Edit ${label.toLowerCase()}\n${heading}\n`
  const removal = `form(action={remove.with({ id: ${row}.id })})\n  button Delete\na(href="/${folder}") Back\n`

  if (project.ui)
    return `${server}--- script\nimport FormField from '@kaynooo/kayjs-ui/form-field.kay'\nimport SaveForm from '@kaynooo/kayjs-ui/save-form.kay'\n---\n${head}SaveForm(action={update} failure="Could not save the ${label.toLowerCase()}" saved="Saved.")\n  input(type="hidden" name="id" value={${row}.id})\n${controls(fields, true, row, 1).join('\n')}\n${removal}`

  return `${server}---\n${head}form(action={update.with({ id: ${row}.id })})\n${controls(fields, false, row, 1).join('\n')}\n  button Save\n${removal}`
}

function createDialog(names: Names, fields: readonly Field[]): string {
  const label = names.label.toLowerCase()

  return `---
import Button from '@kaynooo/kayjs-ui/button.kay'
import FormDialog from '@kaynooo/kayjs-ui/form-dialog.kay'
import FormField from '@kaynooo/kayjs-ui/form-field.kay'
import { signal } from 'kay'
import { create } from '../routes/${names.folder}/_actions.kay'

const writing = signal(false)
---
Button(label="New ${label}" tone="accent" icon="plus" onClick={() => writing.set(true)})
FormDialog(open={writing()} title="New ${label}" action={create} submitLabel="Create" failure="Could not create the ${label}" onOpenChange={open => writing.set(open)})
${controls(fields, true, undefined, 1).join('\n')}
`
}

function testFile(names: Names, fields: readonly Field[], project: ResourceProject): string {
  const { folder, plural } = names
  const label = names.label.toLowerCase()
  // The first field a list shows as text: a boolean's `true` could match anything.
  const shown = fields.find(field => field.type !== 'boolean') ?? fields[0]!
  const textual = (field: Field) => field.type === 'string' || field.type === 'text'
  // A blank field is an empty text or, for a number or a boolean, a word.
  const value = (field: Field, posted: boolean, blank?: Field) => {
    if (field !== blank)
      return TYPES[field.type][posted ? 'posted' : 'sample']

    return textual(field) ? '\'\'' : '\'abc\' as never'
  }
  const object = (posted: boolean, blank?: Field, id = '') => `{ ${id}${fields.map(field => `${field.name}: ${value(field, posted, blank)}`).join(', ')} }`
  const blank = fields.find(field => textual(field)) ?? fields.find(field => field.type !== 'boolean') ?? fields[0]!
  const person = `{ email: 'ada@example.com', username: 'Ada' }`
  const signIn = project.auth ? `  await ${project.authModule ? `auth.signInAs(site, ${person})` : `authTest(site).signInAs(${person})`}\n` : ''
  const imports = `${project.auth && !project.authModule ? 'import { authTest } from \'@kaynooo/kayjs-auth/test\'\n' : ''}import { expect, it } from 'bun:test'\nimport { testSite } from 'kay/test'\n${project.authModule ? 'import { auth } from \'../src/auth\'\n' : ''}import { db } from '../src/db'\nimport { ${names.pascal} } from '../src/db/${names.slug}'\nimport { create, remove, update } from '../src/routes/${folder}/_actions.kay'\n`
  const refusal = `\nit('refuses a ${label} with ${textual(blank) ? 'an empty' : 'an invalid'} ${blank.label.toLowerCase()}', async () => {\n${signIn}  const refused = await site.refusal(create, ${object(false, blank)})\n\n  expect(refused.status).toBe(422)\n})\n`

  const listed = shown.type === 'boolean' ? `expect(page.text()).not.toContain('No ${plural.toLowerCase()} yet.')` : `expect(page.text()).toContain('${TYPES[shown.type].shown}')`
  const newest = `(await db.repo(${names.pascal}).read.findMany(q => q.orderBy('id', 'desc')))[0]!`

  return `${imports}\nconst site = await testSite()\n\nit('lists the ${plural.toLowerCase()} created', async () => {\n${signIn}  const page = await site.submit(create, ${object(true)}, { from: '/${folder}' })\n\n  ${listed}\n})\n\nit('edits and deletes a ${label}', async () => {\n${signIn}  await site.submit(create, ${object(true)}, { from: '/${folder}' })\n\n  const id = String(${newest}.id)\n\n  await site.submit(update, ${object(true, undefined, 'id, ')}, { from: \`/${folder}/\${id}/edit\` })\n\n  expect((await site.visit(\`/${folder}/\${id}/edit\`)).status).toBe(200)\n\n  await site.submit(remove, { id }, { from: \`/${folder}/\${id}/edit\` })\n\n  expect((await site.visit(\`/${folder}/\${id}/edit\`)).status).toBe(404)\n})\n${refusal}`
}

// The files `kay generate resource <name> <field:type>...` writes: the pg-orm table, the actions, the list and edit pages, a new page or, with kayjs-ui, a dialog on the list, and a test of the list and of a refused create. `table` is what `src/db/tables.ts` imports and lists.
export function resourceFiles(name: string, specs: readonly string[], project: ResourceProject, pluralName?: string): { files: Record<string, string>, table: { name: string, file: string } } {
  const names = namesOf(name, pluralName)
  const fields = parseFields(specs)
  const routes = `src/routes/${names.folder}`
  const files: Record<string, string> = {
    [`src/db/${names.slug}.ts`]: tableFile(names, fields),
    [`${routes}/_actions.kay`]: actionsFile(names, fields),
    [`${routes}/index.kay`]: listPage(names, fields, project),
    [`${routes}/[id=integer]/edit.kay`]: editPage(names, fields, project),
  }

  if (project.ui) {
    files[`src/components/${names.tableFile}.kay`] = tableComponent(names, fields)
    files[`src/components/new-${names.slug}.kay`] = createDialog(names, fields)
  }
  else {
    files[`${routes}/new.kay`] = newPage(names, fields, project)
  }

  if (project.tests)
    files[`tests/${names.folder}.test.ts`] = testFile(names, fields, project)

  return { files, table: { name: names.pascal, file: `./${names.slug}` } }
}

const TABLES = /(export const tables = \[)([^\]]*)\]/
const RELATIVE_IMPORT = /^import\s.*from\s+'(\.\/[^']*)'/
const ANY_IMPORT = /^(?:import\s.*\sfrom\s.*|\}\s*from\s.*)$/
const COMPLEX_LIST = /\[|\/\/|\/\*/
const REST_OF_LINE = /^[;\t ]*(?:\r?\n|$)/
const TRAILING_COMMA = /,\s*$/
const TRAILING_SPACE = /\s*$/

function relativeImport(line: string): string | undefined {
  return RELATIVE_IMPORT.exec(line)?.[1]
}

// The text of `src/db/tables.ts` with the table imported and listed, or `undefined` when it has no `export const tables = [...]` to extend. A table it mentions already throws.
export function withTable(text: string, table: { name: string, file: string }): string | undefined {
  const match = TABLES.exec(text)

  // A list holding a comment or an index is left to be edited by hand, as is a line going on after the closing bracket.
  if (match === null || COMPLEX_LIST.test(match[2]!) || !REST_OF_LINE.test(text.slice(match.index + match[0].length)))
    return undefined

  if (new RegExp(`\\b${table.name}\\b`).test(text))
    throw new Error(`kay generate: nothing was written, src/db/tables.ts already mentions \`${table.name}\``)

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const inner = match[2]!
  const tail = TRAILING_SPACE.exec(inner)?.[0] ?? ''
  const kept = inner.slice(0, inner.length - tail.length).replace(TRAILING_COMMA, '')
  const listed = `${match[1]}${kept === '' ? '' : `${kept}, `}${table.name}${tail}]`
  const lines = `${text.slice(0, match.index)}${listed}${text.slice(match.index + match[0].length)}`.split(LINE_BREAK)
  const line = `import { ${table.name} } from '${table.file}'`
  const before = lines.findIndex(entry => (relativeImport(entry) ?? '').localeCompare(table.file) > 0 && relativeImport(entry) !== undefined)

  if (before !== -1) {
    lines.splice(before, 0, line)

    return lines.join(eol)
  }

  const last = lines.findLastIndex(entry => relativeImport(entry) !== undefined)
  const lastImport = last === -1 ? lines.findLastIndex(entry => ANY_IMPORT.test(entry)) : last

  lines.splice(lastImport + 1, 0, ...lastImport === -1 ? [line, ''] : [line])

  return lines.join(eol)
}
