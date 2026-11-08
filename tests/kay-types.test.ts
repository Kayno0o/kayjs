import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { kayTypes } from './kay-types'

test('maps every export of kay that has types to a declaration file that exists', async () => {
  const { exports } = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as { exports: Record<string, string | { types?: string }> }
  const typed = Object.entries(exports).filter(([, target]) => typeof target === 'object' && target.types !== undefined).map(([subpath]) => subpath === '.' ? 'kay' : `kay/${subpath.slice(2)}`)
  const paths = await kayTypes()

  expect(Object.keys(paths).toSorted()).toEqual(typed.toSorted())

  for (const [name, [file]] of Object.entries(paths)) {
    expect(file, name).toEndWith('.d.ts')
    expect(existsSync(file!), file).toBe(true)
  }
}, 120_000)
