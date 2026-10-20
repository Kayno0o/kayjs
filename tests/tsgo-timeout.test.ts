import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { splitListing, typecheck, withoutSummary } from '../src/check/tsgo'
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

describe('bun check output', () => {
  it('splits the files it lists from the diagnostics, a message line that is not a path staying in its message', () => {
    const stdout = 'src/a.ts(1,2): error TS2322: Type \'{ a: 1; }\' is not assignable.\n  Types of property differ:\n}\nbundled:///libs/lib.es5.d.ts\n/app/src/a.ts\n/app/node_modules/x/index.d.ts\n'

    expect(splitListing(stdout)).toEqual({
      output: 'src/a.ts(1,2): error TS2322: Type \'{ a: 1; }\' is not assignable.\n  Types of property differ:\n}\n',
      listed: ['/app/src/a.ts', '/app/node_modules/x/index.d.ts'],
    })
  })

  it('drops its summary from stderr and keeps any other line it prints', () => {
    expect(withoutSummary('note: Stopped before type checking 3 files. Fix the errors above to see the rest.\nFound 2 errors in 1 file, checked 0 files [3.00ms]\n\n  2  src/a.ts:1\n')).toBe('')
    expect(withoutSummary('✓ No type errors in 2 files [14.00ms]\n')).toBe('')
    expect(withoutSummary('Found 1 error, checked 0 files [0.00ms]\nwarning: something new\n')).toBe('warning: something new')
  })
})
