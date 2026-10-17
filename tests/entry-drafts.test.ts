import { expect, it, mock } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scratchDir } from './scratch'

const real = await import('node:fs/promises')

// A filesystem without hard links: `link` is refused as such a one refuses it.
await mock.module('node:fs/promises', () => ({ ...real, link: async () => {
  throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
} }))

const { createWhole } = await import('../src/server/entry-drafts')

it('creates a file whole on a filesystem without hard links', async () => {
  const file = join(await scratchDir('entry-drafts-'), 'a/b.md')

  await createWhole(file, 'text')
  expect(await Bun.file(file).text()).toBe('text')
  expect(await Array.fromAsync(new Bun.Glob('**/*.tmp').scan({ cwd: join(file, '..'), dot: true }))).toEqual([])
})

it('refuses to overwrite a file with the same error on a filesystem without hard links', async () => {
  const file = join(await scratchDir('entry-drafts-'), 'c.md')

  await writeFile(file, 'a person wrote this')
  await expect(createWhole(file, 'machine')).rejects.toMatchObject({ code: 'content-api-misuse', message: expect.stringContaining('never overwrites an entry') })
  expect(await Bun.file(file).text()).toBe('a person wrote this')
  expect(await Array.fromAsync(new Bun.Glob('**/*.tmp').scan({ cwd: join(file, '..'), dot: true }))).toEqual([])
})
