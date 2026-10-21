import type { IconProps } from 'kay/icons'
import type { Field } from './fields'
import type { CollectionInfo, FormLayout, GivenLayout, ListLayout, RowAction } from './kay/contract'
import { wording } from 'kay/words'
import { fieldsOf, pairedFields } from './fields'

export const ROW_ACTIONS: readonly RowAction[] = ['move', 'publish', 'unpublish', 'duplicate', 'editOnPage', 'delete']
const ACTIONS = new Set<string>(ROW_ACTIONS)

// What a field named `#body` stands for, and `body` too unless the schema has a data field of that name.
export const BODY_ID = '#body'
// The kinds a list can show in a cell: not those holding structure.
const UNSHOWN = new Set<Field['kind']>(['list', 'lines', 'tags', 'group', 'json', 'custom'])

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
export function checkLayouts(collections: unknown): ReadonlyMap<string, GivenLayout> {
  const layouts = new Map<string, GivenLayout>()

  if (collections === undefined)
    return layouts

  for (const [name, value] of Object.entries(plain('cms({ collections })', collections))) {
    const where = `cms({ collections: { ${JSON.stringify(name)} } })`
    const { form, list, group, order, icon } = plain(where, value, ['form', 'list', 'group', 'order', 'icon'])

    if (group !== undefined && (typeof group !== 'string' || group.trim() === ''))
      throw new Error(`kayjs-cms: \`${where}.group\` takes a heading, got ${JSON.stringify(group)}`)

    if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order)))
      throw new Error(`kayjs-cms: \`${where}.order\` takes a number, got ${JSON.stringify(order)}`)

    if (icon !== undefined && (typeof icon !== 'object' || icon === null || typeof (icon as { viewBox?: unknown }).viewBox !== 'string'))
      throw new Error(`kayjs-cms: \`${where}.icon\` takes an icon imported from \`~icons/<prefix>/<name>\`, got ${JSON.stringify(icon)}`)

    layouts.set(name, { group, order, icon: icon as IconProps | undefined, form: form === undefined ? undefined : checkForm(`${where}.form`, form), list: list === undefined ? undefined : checkList(`${where}.list`, list) })
  }

  return layouts
}

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
  const hidden = new Set((layout?.hide ?? []).map(name => bodyId(name, new Map(fields.map(field => [String(field.key), field])))))
  const named = [...(layout?.fields ?? []).flat(), ...layout?.hide ?? []].filter(name => !fields.some(field => String(field.key) === name) && resolve(fields, name) !== undefined)
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

      if (field.kind === 'group')
        walk(`${at}.`, field.fields)
      else if (field.kind === 'list' && field.item.kind === 'group')
        walk(`${at}.`, field.item.fields)
    }
  }

  for (const { name, schema } of listed)
    walk(`${name}: `, fieldsOf(schema))

  return lines
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
    const named = [...(layout.form?.fields ?? []).flat(), ...layout.form?.hide ?? []].filter(field => field !== 'body' && field !== BODY_ID)

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
