import type { Field } from './fields'
import type { CollectionInfo } from './kay/contract'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fieldsOf } from './fields'

const KAY_FILE = /\.kay$/

function customKinds(fields: Field[]): string[] {
  return fields.flatMap((field) => {
    if (field.kind === 'custom')
      return [field.name]

    if (field.kind === 'list')
      return customKinds([field.item])

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
