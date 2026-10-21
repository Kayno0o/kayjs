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
