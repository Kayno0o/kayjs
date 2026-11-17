import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { actionOptions } from '../src/check/action-options'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function fixed(source: string, path = 'src/a.ts'): Promise<{ text: string, found: number }> {
  const root = await scratchDir('action-options-')

  try {
    await Bun.write(join(root, path), source)

    const found = await actionOptions(root, {})

    await applySafeFixes(root, found)

    return { text: await Bun.file(join(root, path)).text(), found: found.length }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

const head = 'import { action, s } from \'kay\'\n\n'

describe('deprecated-action-options', () => {
  it('moves the schema and the options into the first argument', async () => {
    const { text, found } = await fixed(`${head}export const a = action({ n: s.int() }, ({ n }) => n, { maxSize: '1mb', guards: [g] })\n`)

    expect(found).toBe(1)
    expect(text).toBe(`${head}export const a = action({ input: { n: s.int() }, maxSize: '1mb', guards: [g] }, ({ n }) => n)\n`)
  })

  it('moves the options of a handler-only action before it', async () => {
    const { text } = await fixed(`${head}export const a = action(() => 1, { guards: [g] })\n`)

    expect(text).toBe(`${head}export const a = action({ guards: [g] }, () => 1)\n`)
  })

  it('spreads options that are not an object literal', async () => {
    const { text } = await fixed(`${head}export const a = action(schema, handler, shared)\n`)

    expect(text).toBe(`${head}export const a = action({ input: schema, ...shared }, handler)\n`)
  })

  it('leaves the new forms and an action of another module alone', async () => {
    const { found } = await fixed(`${head}export const a = [action({ input: {}, maxSize: '1mb' }, () => 1), action({ n: s.int() }, () => 1), action(() => 1)]\n`)
    const other = await fixed('import { action } from \'./mine\'\n\nexport const a = action(s, h, {})\n')

    expect(found).toBe(0)
    expect(other.found).toBe(0)
  })

  it('reads the fence of a .kay file', async () => {
    const { text } = await fixed(`--- server\n${head}export const a = action({}, () => 1, { maxSize: '1mb' })\n---\np x\n`, 'src/pages/a.kay')

    expect(text).toContain('action({ input: {}, maxSize: \'1mb\' }, () => 1)')
  })
})
