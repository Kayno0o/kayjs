import type { IconProps } from 'kay/icons'
import type { FormLayout, GivenLayout, ListLayout, RowAction, ToolbarAction } from './kay/contract'
import { configError } from 'kay/library'
import { ROW_ACTIONS, TOOLBAR_BUTTONS } from './layout'

const ACTIONS = new Set<string>(ROW_ACTIONS)

function strings(where: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || name === ''))
    throw configError('cms', 'layout', `\`${where}\` takes a list of field names, got ${JSON.stringify(value)}`)

  return value as string[]
}

function distinct(where: string, names: string[]): void {
  const seen = new Set<string>()

  for (const name of names) {
    if (seen.has(name))
      throw configError('cms', 'layout', `\`${where}\` names ${JSON.stringify(name)} twice`)

    seen.add(name)
  }
}

function plain(where: string, value: unknown, allowed?: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw configError('cms', 'layout', `\`${where}\` takes an object, got ${JSON.stringify(value)}`)

  const unknown = allowed && Object.keys(value).find(key => !allowed.includes(key))

  if (unknown !== undefined)
    throw configError('cms', 'layout', `\`${where}\` has no option ${JSON.stringify(unknown)}; it takes ${allowed!.join(', ')}`)

  return value as Record<string, unknown>
}

function rowOf(where: string, row: unknown): string | string[] {
  return Array.isArray(row) ? strings(where, row) : strings(where, [row])[0]!
}

function checkBody(where: string, value: unknown): NonNullable<FormLayout['body']> {
  const { label, hint } = plain(where, value, ['label', 'hint'])

  for (const [key, text] of Object.entries({ label, hint })) {
    if (text !== undefined && (typeof text !== 'string' || text.trim() === ''))
      throw configError('cms', 'layout', `\`${where}.${key}\` takes a text, got ${JSON.stringify(text)}`)
  }

  return { label: label as string | undefined, hint: hint as string | undefined }
}

function checkToolbar(where: string, value: unknown): boolean | ToolbarAction[] {
  if (typeof value === 'boolean')
    return value

  if (!Array.isArray(value) || value.some(name => typeof name !== 'string'))
    throw configError('cms', 'layout', `\`${where}\` takes true, false or a list of buttons (${TOOLBAR_BUTTONS.join(', ')}), got ${JSON.stringify(value)}`)

  const names = value as string[]

  distinct(where, names)

  for (const name of names) {
    if (!(TOOLBAR_BUTTONS as readonly string[]).includes(name))
      throw configError('cms', 'layout', `\`${where}\` names ${JSON.stringify(name)}; the buttons are ${TOOLBAR_BUTTONS.join(', ')}`)
  }

  return names as ToolbarAction[]
}

function checkForm(where: string, value: unknown): FormLayout {
  const { fields, exclude, body, toolbar, previewClass } = plain(where, value, ['fields', 'exclude', 'body', 'toolbar', 'previewClass'])

  if (previewClass !== undefined && (typeof previewClass !== 'string' || previewClass.trim() === ''))
    throw configError('cms', 'layout', `\`${where}.previewClass\` takes the classes of the site's Markdown, such as "prose", got ${JSON.stringify(previewClass)}`)

  if (fields !== undefined && !Array.isArray(fields))
    throw configError('cms', 'layout', `\`${where}.fields\` takes a list of field names, or of lists of them for a row, got ${JSON.stringify(fields)}`)

  const rows = (fields as unknown[] | undefined)?.map((row, index) => rowOf(`${where}.fields[${index}]`, row))
  const hidden = exclude === undefined ? undefined : strings(`${where}.exclude`, exclude)
  const placed = rows?.flat() ?? []

  distinct(`${where}.fields`, placed)
  distinct(`${where}.exclude`, hidden ?? [])

  for (const name of placed) {
    if (hidden?.includes(name))
      throw configError('cms', 'layout', `\`${where}\` both shows and hides ${JSON.stringify(name)}`)
  }

  return { fields: rows, exclude: hidden, body: body === undefined ? undefined : checkBody(`${where}.body`, body), toolbar: toolbar === undefined ? undefined : checkToolbar(`${where}.toolbar`, toolbar), previewClass }
}

function checkList(where: string, value: unknown): ListLayout {
  const { columns, actions } = plain(where, value, ['columns', 'actions'])
  const named = columns === undefined ? undefined : strings(`${where}.columns`, columns)
  const kept = actions === undefined ? undefined : strings(`${where}.actions`, actions)

  distinct(`${where}.columns`, named ?? [])
  distinct(`${where}.actions`, kept ?? [])

  for (const action of kept ?? []) {
    if (!ACTIONS.has(action))
      throw configError('cms', 'layout', `\`${where}.actions\` names ${JSON.stringify(action)}; the row actions are ${ROW_ACTIONS.join(', ')}`)
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
    const { form, list, group, order, icon, history } = plain(where, value, ['form', 'list', 'group', 'order', 'icon', 'history'])

    if (group !== undefined && (typeof group !== 'string' || group.trim() === ''))
      throw configError('cms', 'layout', `\`${where}.group\` takes a heading, got ${JSON.stringify(group)}`)

    if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order)))
      throw configError('cms', 'layout', `\`${where}.order\` takes a number, got ${JSON.stringify(order)}`)

    if (icon !== undefined && (typeof icon !== 'object' || icon === null || typeof (icon as { viewBox?: unknown }).viewBox !== 'string'))
      throw configError('cms', 'layout', `\`${where}.icon\` takes an icon imported from \`~icons/<prefix>/<name>\`, got ${JSON.stringify(icon)}`)

    if (history !== undefined && history !== false)
      throw configError('cms', 'layout', `\`${where}.history\` takes \`false\` to keep no history for the collection, got ${JSON.stringify(history)}`)

    layouts.set(name, { group, order, history, icon: icon as IconProps | undefined, form: form === undefined ? undefined : checkForm(`${where}.form`, form), list: list === undefined ? undefined : checkList(`${where}.list`, list) })
  }

  return layouts
}
