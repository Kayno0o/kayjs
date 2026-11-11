import type { Field } from './fields'
import type { CollectionInfo, FormLayout, GivenLayout, ListLayout, RowAction, ToolbarAction } from './kay/contract'
import { wording } from 'kay/words'
import { fieldsOf, pairedFields } from './fields'

export const ROW_ACTIONS: readonly RowAction[] = ['move', 'publish', 'unpublish', 'duplicate', 'rename', 'editOnPage', 'delete']

// MarkdownEditor's buttons, which tests/layout.test.ts holds to kayjs-ui's list; kept here because kay.config.ts loads this file, which must not pull kayjs-ui's index and its components.
export const TOOLBAR_BUTTONS: readonly ToolbarAction[] = ['bold', 'italic', 'heading', 'bulletList', 'numberedList', 'link', 'image']

// What a field named `#body` stands for, and `body` too unless the schema has a data field of that name.
export const BODY_ID = '#body'
// The kinds a list can show in a cell: not those holding structure.
const UNSHOWN = new Set<Field['kind']>(['list', 'lines', 'tags', 'group', 'json', 'custom'])

// The longest text a cell shows.
export const CELL_LIMIT = 80

export type FormItem = Field | 'body'

function bodyId(name: string, byName: ReadonlyMap<string, Field>): string {
  return name === 'body' && !byName.has('body') ? BODY_ID : name
}

// The field a layout name stands for: a top-level key, else a dotted path down through groups, `address.street`.
export function resolve(fields: Field[], name: string): Field | undefined {
  const exact = fields.find(field => String(field.key) === name)

  if (exact !== undefined || !name.includes('.'))
    return exact

  const [head, ...rest] = name.split('.')
  const group = fields.find(field => String(field.key) === head)

  return group?.kind === 'group' ? resolve(group.fields, rest.join('.')) : undefined
}

// The fields without the nested ones the layout names, each group copied on the way and dropped when the cut leaves it empty.
function without(fields: Field[], cut: ReadonlySet<string>, parent = ''): Field[] {
  return fields.flatMap((field): Field[] => {
    const at = parent === '' ? String(field.key) : `${parent}.${field.key}`

    if (cut.has(at))
      return []

    if (field.kind !== 'group')
      return [field]

    const kept = without(field.fields, cut, at)

    return kept.length === 0 && field.fields.length > 0 ? [] : [{ ...field, fields: kept }]
  })
}

// The rows of a form, each the fields shown side by side: the layout's first, then the rest of the schema's in its order, then the body. A name the schema lacks is skipped. A dotted name reaches a field inside a group, which the group then leaves out and which carries its path as `at`.
export function formRows(fields: Field[], hasBody: boolean, layout?: FormLayout): FormItem[][] {
  const hidden = new Set((layout?.exclude ?? []).map(name => bodyId(name, new Map(fields.map(field => [String(field.key), field])))))
  const named = [...(layout?.fields ?? []).flat(), ...layout?.exclude ?? []].filter(name => !fields.some(field => String(field.key) === name) && resolve(fields, name) !== undefined)
  const cut = new Set(named)
  const kept = without(fields, cut)
  const byName = new Map(kept.map(field => [String(field.key), field]))
  const placed = new Set<string>()
  const item = (id: string): FormItem | undefined => {
    if (id === BODY_ID)
      return hasBody ? 'body' : undefined

    if (cut.has(id)) {
      const found = resolve(fields, id)

      return found && { ...found, at: id }
    }

    return byName.get(id)
  }
  const inHidden = (id: string) => [...hidden].some(name => id === name || id.startsWith(`${name}.`))
  const take = (name: string): FormItem[] => {
    const id = bodyId(name, byName)
    const found = inHidden(id) || placed.has(id) ? undefined : item(id)

    if (found === undefined)
      return []

    placed.add(id)

    return [found]
  }

  const rows = (layout?.fields ?? []).map(row => (Array.isArray(row) ? row : [row]).flatMap(take)).filter(row => row.length > 0)
  const rest = [...kept.map(field => String(field.key)), BODY_ID].flatMap(take).map(found => [found])

  return [...rows, ...rest]
}

// The columns of a list: the named fields the schema has, once each, of a kind a cell can show.
export function listColumns(fields: Field[], layout?: ListLayout): Field[] {
  // A field an image pairs with itself is no field of the form, but its value is a row's like any other.
  const byName = new Map([...[...pairedFields(fields).values()].map(({ field }) => field), ...fields].map(field => [String(field.key), field]))
  const shown = new Set<Field>()

  for (const name of layout?.columns ?? []) {
    const field = byName.get(name)

    if (field && !UNSHOWN.has(field.kind))
      shown.add(field)
  }

  return [...shown]
}

// The row actions a list offers.
export function rowActions(layout?: ListLayout): ReadonlySet<RowAction> {
  return new Set(layout?.actions ?? ROW_ACTIONS)
}

function clipped(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > CELL_LIMIT ? `${line.slice(0, CELL_LIMIT - 1)}…` : line
}

// The text a list's cell shows for a field's value.
export function cellText(field: Field, value: unknown): string {
  if (value === undefined || value === null)
    return ''

  if (field.kind === 'boolean')
    return value === true ? wording('cms.table.yes', 'Yes') : wording('cms.table.no', 'No')

  if (field.kind === 'select')
    return clipped(field.options.find(option => Object.is(option.raw, value))?.label ?? String(value))

  if (field.kind === 'date')
    return String(value).slice(0, 10)

  if (field.kind === 'image' || field.kind === 'file')
    return clipped(String(value).split('/').at(-1) ?? '')

  return typeof value === 'object' ? '' : clipped(String(value))
}

// The fields a `when` waits for that are no sibling of theirs, a line each, for the boot's log: the field would stay hidden for good.
export function whenProblems(listed: Pick<CollectionInfo, 'name' | 'schema'>[]): string[] {
  const lines: string[] = []

  function walk(where: string, siblings: Field[]): void {
    // An image takes the fields it names as its alt text and size, which are siblings still.
    const keys = new Set(siblings.flatMap(field => [field, ...field.kind === 'image' ? [field.upload?.alt, field.upload?.width, field.upload?.height] : []]).flatMap(field => field === undefined ? [] : [String(field.key)]))

    for (const field of siblings) {
      const at = `${where}${String(field.key)}`

      if (field.when !== undefined && !keys.has(field.when))
        lines.push(`${at} waits for ${field.when} (fieldInput \`when\`), which is no field beside it, so it stays hidden`)

      if (field.kind === 'group') {
        walk(`${at}.`, field.fields)
      }
      else if (field.kind === 'list' && field.blocks !== undefined) {
        for (const block of field.blocks) walk(`${at}[${block.type}].`, block.fields)
      }
      else if (field.kind === 'list' && field.item.kind === 'group') {
        walk(`${at}.`, field.item.fields)
      }
    }
  }

  for (const { name, schema } of listed)
    walk(`${name}: `, fieldsOf(schema))

  return lines
}

// Why the boot stops when a layout words a body (`form.body`) for a collection that holds none, which would show nowhere.
export function bodylessLayout(listed: Pick<CollectionInfo, 'name' | 'body'>[], layouts: ReadonlyMap<string, GivenLayout>): string | undefined {
  for (const { name, body } of listed) {
    if (body === undefined && layouts.get(name)?.form?.body !== undefined)
      return `kayjs-cms: \`cms({ collections })\` sets \`${name}.form.body\`, but ${name} has no Markdown body to word: remove it, or give its entries a Markdown body`
  }

  return undefined
}

// What the layouts name that the collections lack, once they are loaded: a line each, for the boot's log.
export function layoutProblems(listed: Pick<CollectionInfo, 'name' | 'schema'>[], layouts: ReadonlyMap<string, GivenLayout>): string[] {
  const lines: string[] = []

  for (const [name, layout] of layouts) {
    const found = listed.find(collection => collection.name === name)

    if (!found) {
      lines.push(`cms({ collections }) names ${name}, which is no collection of the site`)

      continue
    }

    const fields = fieldsOf(found.schema)
    const named = [...(layout.form?.fields ?? []).flat(), ...layout.form?.exclude ?? []].filter(field => field !== 'body' && field !== BODY_ID)

    const paired = pairedFields(fields)

    for (const field of named) {
      if (resolve(fields, field) !== undefined)
        continue

      const image = paired.get(field)

      lines.push(image ? `${name}'s form names ${field}, which is the ${image.role} of its image ${image.image}: the form shows it there` : `${name}'s form names ${field}, which its schema lacks`)
    }

    for (const field of layout.list?.columns ?? []) {
      const kind = [...fields, ...[...paired.values()].map(({ field: sibling }) => sibling)].find(candidate => String(candidate.key) === field)?.kind

      if (kind === undefined)
        lines.push(`${name}'s list names the column ${field}, which its schema lacks`)
      else if (UNSHOWN.has(kind))
        lines.push(`${name}'s list names the column ${field}, a ${kind} field a cell cannot show`)
    }
  }

  return lines
}
