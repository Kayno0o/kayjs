import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { s } from '../src/runtime/schema'
import { testSite } from '../src/test'

const MB = 1024 * 1024
const site = await testSite({ root: 'tests/fixtures/file-sizes', islands: false, security: false })
const actions = await import(join(import.meta.dir, 'fixtures/file-sizes/src/routes/index.kay')) as {
  upload: Action<{ file: File }, number>
  own: Action<{ file: File }, number>
  many: Action<{ files: File[] }, number>
}

afterAll(async () => {
  await site.close()
})

const bytes = (size: number) => new File([new Uint8Array(size)], 'photo.bin')

describe('a file field\'s size', () => {
  it('reads kay\'s spelling and hands Elysia bytes', () => {
    expect(s.File({ maxSize: '2mb' })).toMatchObject({ maxSize: 2 * MB })
    expect(s.File({ minSize: '1kb', maxSize: 512 })).toMatchObject({ minSize: 1024, maxSize: 512 })
    expect(s.Files({ maxSize: '1.5mb', maxItems: 2 })).toMatchObject({ maxSize: 1.5 * MB, maxItems: 2 })
    expect(s.File()).not.toHaveProperty('maxSize')
    expect(() => s.File({ maxSize: '2m' as '2mb' })).toThrow('s.File({ maxSize })')
    expect(() => s.File({ maxSize: 0 })).toThrow('s.File({ maxSize })')
  })

  it('raises the action\'s body limit when the action sets none, so the limit is written once', async () => {
    const taken = await site.submit(actions.upload, { file: bytes(1.5 * MB) }, { from: '/' })

    expect(taken.html).not.toContain('Too large')
    expect((await site.submit(actions.upload, { file: bytes(3 * MB) }, { from: '/' })).html).toContain('413 Too large to send')
  })

  it('leaves an action\'s own maxSize alone, lower than its field\'s', async () => {
    expect((await site.submit(actions.own, { file: bytes(1.5 * MB) }, { from: '/' })).html).toContain('413 Too large to send; 1 MB at most')
  })

  it('counts every file a Files field takes', async () => {
    expect((await site.submit(actions.many, { files: [bytes(0.9 * MB), bytes(0.9 * MB), bytes(0.9 * MB)] }, { from: '/' })).html).not.toContain('Too large')
    expect((await site.submit(actions.many, { files: [bytes(MB), bytes(MB), bytes(MB), bytes(MB)] }, { from: '/' })).html).toContain('Too large to send')
  })
})
