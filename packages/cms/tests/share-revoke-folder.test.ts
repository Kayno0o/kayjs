import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { s } from 'kay'
import { collection } from 'kay/content'
import { scratchDir } from 'kay/test'
import { registerCollections } from '../../../src/content/edit'
import { contentPlace, setContentPlace } from '../../../src/content/load'
import { configure } from '../src/settings'
import { revokeShares, sharesRevokedAt } from '../src/share-revoke'

const original = contentPlace()
let restore: ReturnType<typeof registerCollections>
let dir = ''

beforeEach(async () => {
  dir = await scratchDir('share-revoke-')
  await mkdir(join(dir, 'posts'), { recursive: true })
  await mkdir(join(dir, '.git'), { recursive: true })
  setContentPlace(dir, dir)
  configure({})
  restore = registerCollections([['posts', collection(join(dir, 'posts'), { schema: s.Object({ title: s.String() }) })]])
})

afterEach(() => {
  registerCollections(restore)
  setContentPlace(original.root, original.base)
})

test('revoking the links of a folder entry writes .cms/shares/<collection>/<slug>.json through the saver, and a link made before is refused', async () => {
  const issued = Date.now()
  const saved: { repoPath: string, text: string | undefined, message: string }[] = []

  configure({ files: { save: async (change) => {
    saved.push({ repoPath: change.repoPath, text: change.text, message: change.message })
    await Bun.write(change.absolute, change.text ?? '')

    return undefined
  } } })

  expect(await sharesRevokedAt({ collection: 'posts', slug: 'first' })).toBeUndefined()
  await revokeShares({ collection: 'posts', slug: 'first' })

  expect(saved.map(({ repoPath, message }) => [repoPath, message])).toEqual([['.cms/shares/posts/first.json', 'content(posts): revoke the share links of first']])

  const at = await sharesRevokedAt({ collection: 'posts', slug: 'first' })

  expect(JSON.parse(saved[0]!.text!)).toEqual({ at })
  // What core compares a link's issue time with: older than this is refused.
  expect(issued).toBeLessThan(at!)
  expect(await sharesRevokedAt({ collection: 'posts', slug: 'second' })).toBeUndefined()
  expect(await sharesRevokedAt({ collection: 'posts', slug: 'first', locale: 'fr' })).toBeUndefined()
})
