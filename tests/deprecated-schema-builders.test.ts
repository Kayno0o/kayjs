import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { schemaBuilders } from '../src/check/schema-builders'
import { scratchDir } from './scratch'

async function fixed(source: string, path = 'src/a.ts'): Promise<{ text: string, found: number }> {
  const root = await scratchDir('schema-builders-')

  try {
    await Bun.write(join(root, path), source)

    const found = await schemaBuilders(root, {})

    await applySafeFixes(root, found)

    return { text: await Bun.file(join(root, path)).text(), found: found.length }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

const head = 'import { action, defineEnv, s } from \'kay\'\n\n'

describe('deprecated-schema-builders', () => {
  it('renames a builder and the options that changed', async () => {
    const { text } = await fixed(`${head}export const a = [s.String({ minLength: 2, maxLength: 5 }), s.Integer({ minimum: 1 }), s.Array(s.String(), { maxItems: 3 }), s.Boolean(), s.Numeric({ title: 'Age' })]\n`)

    expect(text).toBe(`${head}export const a = [s.string({ min: 2, max: 5 }), s.int({ min: 1 }), s.list(s.string(), { max: 3 }), s.boolean(), s.number({ label: 'Age' })]\n`)
  })

  it('writes optional: true in the options of the field s.Optional wrapped', async () => {
    const { text } = await fixed(`${head}export const a = {\n  one: s.Optional(s.String()),\n  two: s.Optional(s.String({ maxLength: 4 })),\n  three: s.Optional(s.Array(s.String())),\n  four: s.Optional(s.Literal('a')),\n  five: s.Optional(s.Object({ x: s.Integer() })),\n  six: s.Optional(s.Object({})),\n}\n`)

    expect(text).toBe(`${head}export const a = {\n  one: s.string({ optional: true }),\n  two: s.string({ optional: true, max: 4 }),\n  three: s.list(s.string(), { optional: true }),\n  four: s.literal('a', { optional: true }),\n  five: s.object({ x: s.int() }, { optional: true }),\n  six: s.object({}, { optional: true }),\n}\n`)
  })

  it('drops the import of s once the record leaves it unread, and keeps it while something reads it', async () => {
    const some = await fixed('import { action, s } from \'kay\'\n\nexport const add = action(s.Object({}), () => 1)\n')

    expect(some.text).toBe('import { action } from \'kay\'\n\nexport const add = action({}, () => 1)\n')

    const sole = await fixed('import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(s.Object({}))\n')

    expect(sole.text).toBe('import { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv({})\n')

    const read = await fixed(`${head}export const add = action(s.Object({ n: s.String() }), () => 1)\n`)

    expect(read.text).toBe(`${head}export const add = action({ n: s.string() }, () => 1)\n`)
  })

  it('leaves an s.Optional around anything but a builder of s, which has no optional option to write', async () => {
    const { text, found } = await fixed(`${head}const own = s.Any()\n\nexport const a = { one: s.Optional(own), two: s.Optional(s.Nullable(s.String())) }\n`)

    // Only the s.String inside the Nullable, which renames on its own.
    expect(found).toBe(1)
    expect(text).toContain('s.Optional(own)')
    expect(text).toContain('s.Optional(s.Nullable(s.string()))')
  })

  it('writes the record of an s.Object that is the schema of an action or a defineEnv', async () => {
    const { text } = await fixed(`${head}export const add = action(s.Object({ name: s.String() }), ({ name }) => name)\nexport const env = defineEnv(s.Object({ PORT: s.Integer({ default: 3000 }) }))\nexport const nested = s.Object({ a: s.Object({ b: s.String() }) })\n`)

    expect(text).toBe(`${head}export const add = action({ name: s.string() }, ({ name }) => name)\nexport const env = defineEnv({ PORT: s.int({ default: 3000 }) })\nexport const nested = s.object({ a: s.object({ b: s.string() }) })\n`)
  })

  it('renames s.UnionEnum and s.UnionKeys to s.enum', async () => {
    const { text } = await fixed(`${head}export const a = [s.UnionEnum(['a', 'b']), s.UnionKeys({ a: 'A' }, { default: 'a' })]\n`)

    expect(text).toBe(`${head}export const a = [s.enum(['a', 'b']), s.enum({ a: 'A' }, { default: 'a' })]\n`)
  })

  it('writes the unit of a file size', async () => {
    const { text } = await fixed(`${head}export const a = [s.File({ maxSize: '2m' }), s.files({ minSize: '600k', maxSize: '2mb' })]\n`)

    expect(text).toBe(`${head}export const a = [s.file({ maxSize: '2mb' }), s.files({ minSize: '600kb', maxSize: '2mb' })]\n`)
  })

  it('reads the fences of a .kay file, and leaves an s that kay does not own alone', async () => {
    const kay = await fixed('--- server\nimport { action, s } from \'kay\'\n\nexport const add = action(s.Object({ n: s.Optional(s.Integer()) }), () => 1)\n---\np x\n', 'src/routes/index.kay')

    expect(kay.text).toBe('--- server\nimport { action, s } from \'kay\'\n\nexport const add = action({ n: s.int({ optional: true }) }, () => 1)\n---\np x\n')

    const other = await fixed('import { s } from \'./mine\'\n\nexport const a = s.String()\n')

    expect(other.found).toBe(0)
  })

  it('keeps the shorthand of a renamed option', async () => {
    const { text } = await fixed(`${head}const minLength = 3\nexport const a = s.String({ minLength })\n`)

    expect(text).toBe(`${head}const minLength = 3\nexport const a = s.string({ min: minLength })\n`)
  })
})
