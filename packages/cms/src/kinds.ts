import type { Field } from './fields'
import type { CollectionInfo, JsonSchema } from './kay/contract'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fieldsOf, hintOf, itemFields } from './fields'

const KAY_FILE = /\.kay$/

function customKinds(fields: Field[]): string[] {
  return fields.flatMap((field) => {
    if (field.kind === 'custom')
      return [field.name]

    if (field.kind === 'list')
      return customKinds(itemFields(field))

    return field.kind === 'group' ? customKinds(field.fields) : []
  })
}

// The custom kinds the collections' schemas name that `available` has no component for, with the collections naming each.
export function missingKinds(listed: Pick<CollectionInfo, 'name' | 'schema'>[], available: ReadonlySet<string>): Map<string, string[]> {
  const missing = new Map<string, string[]>()

  for (const { name, schema } of listed) {
    for (const kind of customKinds(fieldsOf(schema))) {
      if (!available.has(kind) && !missing.get(kind)?.includes(name))
        missing.set(kind, [...missing.get(kind) ?? [], name])
    }
  }

  return missing
}

// A line for each custom kind a collection names with no `src/cms/fields/<kind>.kay` under `root`, which the editor falls back to JSON for.
// A project without a `src` folder, an executable say, holds no component to look for.
export function missingKindLines(root: string, listed: Pick<CollectionInfo, 'name' | 'schema'>[]): string[] {
  if (!existsSync(join(root, 'src')))
    return []

  const folder = join(root, 'src', 'cms', 'fields')
  const available = new Set(existsSync(folder) ? readdirSync(folder).filter(file => KAY_FILE.test(file)).map(file => file.replace(KAY_FILE, '')) : [])

  return [...missingKinds(listed, available)].map(([kind, names]) => `no editor for the ${kind} kind that ${names.join(', ')} uses: add src/cms/fields/${kind}.kay, until then it is edited as JSON`)
}

// A line for each `x-kay` that is neither a kind name nor an object with a `kind`, which the field ignores: the collection, the field's path and what to write instead.
export function hintProblems(listed: Pick<CollectionInfo, 'name' | 'schema'>[]): string[] {
  const lines: string[] = []

  function walk(collection: string, at: string, schema: JsonSchema): void {
    const raw: unknown = schema['x-kay']

    if (raw !== undefined && hintOf(raw) === undefined && at !== '')
      lines.push(`${collection}: ${at} has an \`x-kay\` that is neither a kind name nor \`{ kind }\`: set it with \`fieldInput\`, or remove it`)

    for (const [key, property] of Object.entries(schema.properties ?? {}))
      walk(collection, at === '' ? key : `${at}.${key}`, property)

    if (schema.items !== undefined && !Array.isArray(schema.items))
      walk(collection, `${at}[]`, schema.items)

    for (const variant of schema.anyOf ?? [])
      walk(collection, at, variant)
  }

  for (const { name, schema } of listed)
    walk(name, '', schema)

  return lines
}
