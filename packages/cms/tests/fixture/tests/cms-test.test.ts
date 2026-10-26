import type { CmsOptions } from '../../../src/settings'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { cms } from '../../../src/extension'
import { passwordGuard } from '../../../src/password'
import { cmsTest } from '../../../src/test'

const ROOT = join(import.meta.dir, '..')

async function siteWith(passwords: string | Record<string, string>) {
  const options: CmsOptions = { guard: passwordGuard(passwords) }
  const made = await testSite({ root: ROOT, extensions: [cms(options)] })

  cms(options)

  return made
}

test('signs in as an editor, saves an entry and reads back what was saved', async () => {
  const site = await siteWith('pw-editor')
  const editor = cmsTest(site)

  expect(await editor.signInAs()).toBe('editor')
  expect(await editor.entry('posts', 'written')).toBeUndefined()
  expect(await editor.save('posts', 'written', { title: 'Written in a test' }, { create: true, body: 'Hello.' })).toMatchObject({ saved: true })
  expect((await editor.entry('posts', 'written'))?.data).toMatchObject({ title: 'Written in a test' })
  expect((await editor.entry('posts', 'written'))?.body).toContain('Hello.')
})

test('answers the issues of a refused entry, and keeps the project\'s content as it was', async () => {
  const site = await siteWith('pw-editor')
  const editor = cmsTest(site)

  await editor.signInAs()

  expect(await editor.save('posts', 'too-long', { title: 'x'.repeat(41) }, { create: true })).toMatchObject({ issues: [{ collection: 'posts', slug: 'too-long' }] })
  expect(await editor.entry('posts', 'too-long')).toBeUndefined()
  expect(await Bun.file(join(ROOT, 'src/content/posts/written.md')).exists()).toBe(false)
})

test('a site that is not signed in cannot save or read, and says how to sign in', async () => {
  const site = await siteWith('pw-editor')
  const editor = cmsTest(site)

  await expect(editor.save('posts', 'anon', { title: 'No' })).rejects.toThrow('sign the site in first')
  await editor.signInAs()
  editor.signOut()
  await expect(editor.entry('posts', 'hello')).rejects.toThrow('sign the site in first')
})

test('a collection that does not exist is an error, not an empty answer', async () => {
  const site = await siteWith('pw-editor')
  const editor = cmsTest(site)

  await editor.signInAs()
  await expect(editor.save('nowhere', 'a', { title: 'A' })).rejects.toThrow('answered 404')
})

test('saves over an entry without naming its version, and refuses a stale one named', async () => {
  const site = await siteWith('pw-editor')
  const editor = cmsTest(site)

  await editor.signInAs()
  expect(await editor.save('posts', 'versioned', { title: 'One' }, { create: true })).toMatchObject({ saved: true, version: expect.any(String) })
  expect(await editor.save('posts', 'versioned', { title: 'Two' })).toMatchObject({ saved: true })
  expect(await editor.save('posts', 'versioned', { title: 'Three' }, { version: 'stale' })).toMatchObject({ issues: expect.any(Array) })
  expect((await editor.entry('posts', 'versioned'))?.data).toMatchObject({ title: 'Two' })
})

test('deletes and renames an entry, naming its version itself', async () => {
  const site = await siteWith('pw-editor')
  const editor = cmsTest(site)

  await editor.signInAs()
  await editor.save('posts', 'old-name', { title: 'Old' }, { create: true })
  expect(await editor.rename('posts', 'old-name', 'new-name')).toMatchObject({ saved: true, slug: 'new-name' })
  expect(await editor.entry('posts', 'old-name')).toBeUndefined()
  expect(await editor.delete('posts', 'new-name')).toMatchObject({ saved: true })
  expect(await editor.entry('posts', 'new-name')).toBeUndefined()
  expect(await editor.delete('posts', 'new-name', { version: 'stale' })).toMatchObject({ issues: expect.any(Array) })
})

test('a move in a collection with no order field is refused with its issues', async () => {
  const site = await siteWith('pw-editor')
  const editor = cmsTest(site)

  await editor.signInAs()
  expect(await editor.move('posts', 'hello', 'up')).toMatchObject({ issues: expect.any(Array) })
})

test('uploads a file and answers the path to keep', async () => {
  const site = await siteWith('pw-editor')
  const editor = cmsTest(site)

  await editor.signInAs()

  const upload = await editor.upload('posts', new File([await Bun.file(join(ROOT, 'src/outside.png')).arrayBuffer()], 'pic.png', { type: 'image/png' }))

  expect(upload.path).toStartWith('/_kay/files/cms-media/')
})
