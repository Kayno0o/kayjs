import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { schemaType } from '../src/check/schema-type'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('schema-type-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-schema-type', () => {
  it('renames the import of TSchema from kay/library and every use of it', async () => {
    const root = await project({ 'src/fields.ts': 'import type { Static, TSchema } from \'kay/library\'\n\nexport function check<Fields extends TSchema>(fields: Fields): Static<Fields> | TSchema {\n  return fields as never\n}\n' })

    try {
      const found = await schemaType(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]?.code).toBe('deprecated-schema-type')
      expect(found[0]?.fixes?.[0]?.safe).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/fields.ts')).text()).toBe('import type { Static, Schema } from \'kay/library\'\n\nexport function check<Fields extends Schema>(fields: Fields): Static<Fields> | Schema {\n  return fields as never\n}\n')
      expect(await schemaType(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports with no fix a file that has a Schema of its own', async () => {
    const root = await project({ 'src/own.ts': 'import type { TSchema } from \'kay/library\'\n\ninterface Schema { name: string }\n\nexport const own = (value: TSchema, mine: Schema) => [value, mine]\n' })

    try {
      const found = await schemaType(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]?.fixes).toBeUndefined()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves TSchema imported from elysia and Schema alone', async () => {
    const root = await project({ 'src/elysia.ts': 'import type { TSchema } from \'elysia\'\nimport type { Schema } from \'kay\'\n\nexport type Both = [TSchema, Schema]\n' })

    try {
      expect(await schemaType(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stays quiet at allow', async () => {
    const root = await project({ 'src/a.ts': 'import type { TSchema } from \'kay/library\'\nexport type A = TSchema\n' })

    try {
      expect(await schemaType(root, { lints: { 'deprecated-schema-type': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
