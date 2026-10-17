import type { Field } from './fields'
import type { CollectionInfo, CollectionLayout, FormLayout, ListLayout, RowAction } from './kay/contract'
import { fieldsOf } from './fields'

export const ROW_ACTIONS: readonly RowAction[] = ['move', 'publish', 'editOnPage', 'delete']
const ACTIONS = new Set<string>(ROW_ACTIONS)

// What a field named `#body` stands for, and `body` too unless the schema has a data field of that name.
export const BODY_ID = '#body'
// The kinds a list can show in a cell: not those holding structure.
const UNSHOWN = new Set<Field['kind']>(['list', 'group', 'json', 'custom'])

// The longest text a cell shows.
export const CELL_LIMIT = 80

export type FormItem = Field | 'body'

function strings(where: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || name === ''))
    throw new Error(`kayjs-cms: \`${where}\` takes a list of field names, got ${JSON.stringify(value)}`)

  return value as string[]
}

function distinct(where: string, names: string[]): void {
  const seen = new Set<string>()

  for (const name of names) {
    if (seen.has(name))
      throw new Error(`kayjs-cms: \`${where}\` names ${JSON.stringify(name)} twice`)

    seen.add(name)
  }
}

function plain(where: string, value: unknown, allowed?: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`kayjs-cms: \`${where}\` takes an object, got ${JSON.stringify(value)}`)

  const unknown = allowed && Object.keys(value).find(key => !allowed.includes(key))

  if (unknown !== undefined)
    throw new Error(`kayjs-cms: \`${where}\` has no option ${JSON.stringify(unknown)}; it takes ${allowed!.join(', ')}`)

  return value as Record<string, unknown>
}

function rowOf(where: string, row: unknown): string | string[] {
  return Array.isArray(row) ? strings(where, row) : strings(where, [row])[0]!
}

function checkForm(where: string, value: unknown): FormLayout {
  const { fields, hide } = plain(where, value, ['fields', 'hide'])

  if (fields !== undefined && !Array.isArray(fields))
    throw new Error(`kayjs-cms: \`${where}.fields\` takes a list of field names, or of lists of them for a row, got ${JSON.stringify(fields)}`)

  const rows = (fields as unknown[] | undefined)?.map((row, index) => rowOf(`${where}.fields[${index}]`, row))
  const hidden = hide === undefined ? undefined : strings(`${where}.hide`, hide)
  const placed = rows?.flat() ?? []

  distinct(`${where}.fields`, placed)
  distinct(`${where}.hide`, hidden ?? [])

  for (const name of placed) {
    if (hidden?.includes(name))
      throw new Error(`kayjs-cms: \`${where}\` both shows and hides ${JSON.stringify(name)}`)
  }

  return { fields: rows, hide: hidden }
}

function checkList(where: string, value: unknown): ListLayout {
  const { columns, actions } = plain(where, value, ['columns', 'actions'])
  const named = columns === undefined ? undefined : strings(`${where}.columns`, columns)
  const kept = actions === undefined ? undefined : strings(`${where}.actions`, actions)

  distinct(`${where}.columns`, named ?? [])
  distinct(`${where}.actions`, kept ?? [])

  for (const action of kept ?? []) {
    if (!ACTIONS.has(action))
      throw new Error(`kayjs-cms: \`${where}.actions\` names ${JSON.stringify(action)}; the row actions are ${ROW_ACTIONS.join(', ')}`)
  }

  return { columns: named, actions: kept as RowAction[] | undefined }
}

// The layouts `cms({ collections })` gave, checked as kay.config.ts loads: the shape alone, as the schemas are read later.
export function checkLayouts(collections: unknown): ReadonlyMap<string, CollectionLayout> {
  const layouts = new Map<string, CollectionLayout>()

  if (collections === undefined)
    return layouts

  for (const [name, value] of Object.entries(plain('cms({ collections })', collections))) {
    const where = `cms({ collections: { ${JSON.stringify(name)} } })`
    const { form, list } = plain(where, value, ['form', 'list'])

    layouts.set(name, { form: form === undefined ? undefined : checkForm(`${where}.form`, form), list: list === undefined ? undefined : checkList(`${where}.list`, list) })
  }

  return layouts
}

function bodyId(name: string, byName: ReadonlyMap<string, Field>): string {
  return name === 'body' && !byName.has('body') ? BODY_ID : name
}

// The rows of a form, each the fields shown side by side: the layout's first, then the rest of the schema's in its order, then the body. A name the schema lacks is skipped.
export function formRows(fields: Field[], hasBody: boolean, layout?: FormLayout): FormItem[][] {
  const byName = new Map(fields.map(field => [String(field.key), field]))
  const hidden = new Set((layout?.hide ?? []).map(name => bodyId(name, byName)))
  const placed = new Set<string>()
  const item = (id: string): FormItem | undefined => {
    if (id === BODY_ID)
      return hasBody ? 'body' : undefined

    return byName.get(id)
  }
  const take = (name: string): FormItem[] => {
    const id = bodyId(name, byName)
    const found = hidden.has(id) || placed.has(id) ? undefined : item(id)

    if (found === undefined)
      return []

    placed.add(id)

    return [found]
  }

  const rows = (layout?.fields ?? []).map(row => (Array.isArray(row) ? row : [row]).flatMap(take)).filter(row => row.length > 0)
  const rest = [...fields.map(field => String(field.key)), BODY_ID].flatMap(take).map(found => [found])

  return [...rows, ...rest]
}

// The columns of a list: the named fields the schema has, once each, of a kind a cell can show.
export function listColumns(fields: Field[], layout?: ListLayout): Field[] {
  const byName = new Map(fields.map(field => [String(field.key), field]))
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
    return value === true ? '✓' : ''

  if (field.kind === 'select')
    return clipped(field.options.find(option => Object.is(option.raw, value))?.label ?? String(value))

  if (field.kind === 'date')
    return String(value).slice(0, 10)

  if (field.kind === 'image' || field.kind === 'file')
    return clipped(String(value).split('/').at(-1) ?? '')

  return typeof value === 'object' ? '' : clipped(String(value))
}

// What the layouts name that the collections lack, once they are loaded: a line each, for the boot's log.
export function layoutProblems(listed: Pick<CollectionInfo, 'name' | 'schema'>[], layouts: ReadonlyMap<string, CollectionLayout>): string[] {
  const lines: string[] = []

  for (const [name, layout] of layouts) {
    const found = listed.find(collection => collection.name === name)

    if (!found) {
      lines.push(`cms({ collections }) names ${name}, which is no collection of the site`)

      continue
    }

    const fields = fieldsOf(found.schema)
    const keys = new Set(fields.map(field => String(field.key)))
    const named = [...(layout.form?.fields ?? []).flat(), ...layout.form?.hide ?? []].filter(field => field !== 'body' && field !== BODY_ID)

    for (const field of named) {
      if (!keys.has(field))
        lines.push(`${name}'s form names ${field}, which its schema lacks`)
    }

    for (const field of layout.list?.columns ?? []) {
      const kind = fields.find(candidate => String(candidate.key) === field)?.kind

      if (kind === undefined)
        lines.push(`${name}'s list names the column ${field}, which its schema lacks`)
      else if (UNSHOWN.has(kind))
        lines.push(`${name}'s list names the column ${field}, a ${kind} field a cell cannot show`)
    }
  }

  return lines
}
