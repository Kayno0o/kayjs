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

  it('honours kay-allow', async () => {
    const source = 'import { queue } from \'kay/server\'\n// kay-allow deprecated-hook-names\nexport const a = queue(\'a\', run, { onFailed: y })\n'

    expect((await run({ 'src/a.ts': source })).found).toEqual([])
  })
})
