import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { typecheck } from '../src/check/tsgo'
import { scratchDir } from './scratch'

describe('typecheck', () => {
  it('stops a bun check run that outlasts its timeout and says so', async () => {
    const root = await scratchDir('tsgo-timeout')

    await Bun.write(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['index.ts'] }))
    await Bun.write(join(root, 'index.ts'), 'export const value: number = 1\n')

    const stopped = await typecheck(root, 'tsconfig.json', undefined, '', 1)

    expect(stopped.code).not.toBe(0)
    expect(stopped.errors).toBe('kay: bun check did not finish within 0.001 s and was stopped')

    const run = await typecheck(root, 'tsconfig.json', undefined, '')

    expect(run).toEqual({ output: '', errors: '', code: 0 })
  })
})
