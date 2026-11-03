import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { hookNames } from '../src/check/hook-names'
import { scratchDir } from './scratch'

async function run(files: Record<string, string>) {
  const root = await scratchDir('hook-names-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await hookNames(root, {})

    await applySafeFixes(root, found)

    return { found, after: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) as Record<string, string> }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-hook-names', () => {
  it('renames onFailed in queue(), workflow() and mailer({ queue }), a shorthand becoming onError: onFailed', async () => {
    const source = [
      'import { queue, workflow } from \'kay/server\'',
      'import { mailer } from \'@kaynooo/kayjs-mail\'',
      'const onFailed = () => undefined',
      'export const a = queue(\'a\', run, { attempts: 2, onFailed: ({ error }) => report(error) })',
      'export const b = workflow(\'b\', run, { onFailed })',
      'export const c = mailer({ from: \'a@b.c\', queue: { onFailed: () => undefined } })',
      '',
    ].join('\n')
    const { found, after } = await run({ 'src/a.ts': source })

    expect(found).toHaveLength(3)
    expect(after['src/a.ts']).toBe(source.replace('onFailed: ({ error })', 'onError: ({ error })').replace('{ onFailed })', '{ onError: onFailed })').replace('queue: { onFailed:', 'queue: { onError:'))
  })

  it('reports a key beside onError with no fix, and leaves a queue that is not kay\'s alone', async () => {
    const both = 'import { queue } from \'kay/server\'\nexport const a = queue(\'a\', run, { onError: x, onFailed: y })\n'
    const other = 'import { queue } from \'./mine\'\nexport const a = queue(\'a\', run, { onFailed: y })\n'
    const { found, after } = await run({ 'src/a.ts': both, 'src/b.ts': other })

    expect(found).toHaveLength(1)
    expect(found[0]!.fixes).toBeUndefined()
    expect(after['src/a.ts']).toBe(both)
    expect(after['src/b.ts']).toBe(other)
  })

  it('renames a method-form key and a string key, through an aliased or namespace import', async () => {
    const source = [
      'import { queue as q, workflow } from \'kay/server\'',
      'import * as server from \'kay/server\'',
      'export const a = q(\'a\', run, { async onFailed() {} })',
      'export const b = server.queue(\'b\', run, { \'onFailed\': () => undefined })',
      'export const c = workflow(\'c\', run, { "onFailed": () => undefined })',
      '',
    ].join('\n')
    const { found, after } = await run({ 'src/a.ts': source })

    expect(found).toHaveLength(3)
    expect(after['src/a.ts']).toBe(source.replace('async onFailed()', 'async onError()').replace('\'onFailed\'', '\'onError\'').replace('"onFailed"', '"onError"'))
  })

  it('finds the options in a .kay fence', async () => {
    const source = '--- server\nimport { queue } from \'kay/server\'\n\nexport const sync = queue(\'sync\', () => undefined, { onFailed: () => undefined })\n---\np x\n'
    const { found, after } = await run({ 'src/routes/index.kay': source })

    expect(found).toHaveLength(1)
    expect(after['src/routes/index.kay']).toBe(source.replace('onFailed', 'onError'))
  })

  it('leaves an options object held in a variable alone', async () => {
    const source = 'import { queue } from \'kay/server\'\nconst options = { onFailed: () => undefined }\nexport const a = queue(\'a\', run, options)\nexport const b = queue(\'b\', run, { ...options })\n'

    expect((await run({ 'src/a.ts': source })).found).toEqual([])
  })

  it('honours kay-allow', async () => {
    const source = 'import { queue } from \'kay/server\'\n// kay-allow deprecated-hook-names\nexport const a = queue(\'a\', run, { onFailed: y })\n'

    expect((await run({ 'src/a.ts': source })).found).toEqual([])
  })
})
