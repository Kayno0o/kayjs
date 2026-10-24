import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { s } from 'kay'
import { collection } from 'kay/content'
import { notifications } from 'kay/server'
import { scratchDir } from 'kay/test'
import { registerCollections, registerEditSite } from '../../../src/content/edit'
import { contentPlace, setContentPlace } from '../../../src/content/load'
import { sqliteLoader } from '../src/loaders/sqlite'
import { readReview, reviewsOf, writeReview } from '../src/review'
import { approveEntry, sendBackEntry, submitEntry } from '../src/reviewing'
import { revisionsOf } from '../src/revisions'
import { configure, settings } from '../src/settings'
import { deleteEntry, entryOf, findCollection, publishEntry, renameEntry, saveEntry } from '../src/store'

const schema = s.Object({ title: s.String(), draft: s.Optional(s.Boolean()) })
const original = contentPlace()
let count = 0
let restore: ReturnType<typeof registerCollections>

const writer = { name: 'Wanda', id: 'writer-1', reviewers: ['reviewer-1', 'reviewer-2'] }
const reviewer = { name: 'Rex', id: 'reviewer-1', reviewers: [] }

// The same entry in a folder collection and in a loaded one: a fresh table each test.
beforeEach(async () => {
  const dir = await scratchDir('review-')

  await mkdir(join(dir, 'posts'), { recursive: true })
  await mkdir(join(dir, 'plain'), { recursive: true })
  await mkdir(join(dir, '.git'), { recursive: true })
  setContentPlace(dir, dir)
  registerEditSite({ urls: async () => undefined, locales: ['en'], defaultLocale: 'en' })
  configure({})

  const table = `notes_${++count}`

  restore = registerCollections([
    ['posts', collection(join(dir, 'posts'), { schema, draft: 'draft' })],
    ['notes', collection(sqliteLoader({ name: 'notes', database: ':memory:', table }), { schema, draft: 'draft' })],
    ['nodraft', collection(join(dir, 'plain'), { schema })],
    ['bare', collection({ name: 'bare', load: () => [{ slug: 'a', data: { title: 'A' } }], save: () => undefined }, { schema, draft: 'draft' })],
  ])
})

afterEach(async () => {
  registerCollections(restore)
  setContentPlace(original.root, original.base)

  for (const id of ['writer-1', 'reviewer-1', 'reviewer-2'])
    await notifications.erase(id)
})

// An approval of the entry as it stands, as a reviewer who has just opened it sends it.
async function approve(ref: { collection: string, slug: string }) {
  return approveEntry(ref, reviewer, undefined, (await entryOf(ref))?.version)
}

async function draft(name: string, slug = 'first'): Promise<{ collection: string, slug: string }> {
  expect(await saveEntry({ collection: name, slug, data: { title: 'One', draft: true } }, { create: true })).toMatchObject({ saved: true })

  return { collection: name, slug }
}

describe.each(['posts', 'notes'])('review in %s', (name) => {
  test('a draft sent for review is in review, with the writer and the step kept', async () => {
    const ref = await draft(name)
    const sent = await submitEntry(ref, writer)

    expect(sent).toMatchObject({ saved: true, review: { status: 'review', by: 'Wanda', events: [{ verb: 'submit', by: 'Wanda' }] } })
    expect(JSON.stringify(sent)).not.toContain('writer-1')
    expect((await readReview(ref))?.status).toBe('review')
    expect([...(await reviewsOf(name)).keys()]).toEqual(['first'])
    expect((await findCollection(name))?.review).toBe(true)
  })

  test('refuses what is not a draft, or already in review', async () => {
    const ref = await draft(name)

    expect(await publishEntry(ref)).toMatchObject({ saved: true })
    expect(await submitEntry(ref, writer)).toMatchObject({ issues: [{ message: 'Only a draft can be sent for review' }] })
    expect(await saveEntry({ ...ref, data: { title: 'One', draft: true } })).toMatchObject({ saved: true })
    expect(await submitEntry(ref, writer)).toMatchObject({ saved: true })
    expect(await submitEntry(ref, writer)).toMatchObject({ issues: [{ message: 'first is in review already' }] })
    expect(await submitEntry({ ...ref, slug: 'nothing' }, writer)).toMatchObject({ issues: [{ key: 'slug' }] })
  })

  test('an approval publishes the draft, keeps the step, and tells the writer', async () => {
    const ref = await draft(name)

    await submitEntry(ref, writer)

    const approved = await approve(ref)

    expect(approved).toMatchObject({ saved: true, review: { status: 'approved', events: [{ verb: 'submit' }, { verb: 'approve', by: 'Rex' }] }, entry: { data: { draft: false } } })
    expect((await entryOf(ref))?.draft).toBe(false)
    expect((await notifications.list('writer-1')).map(note => note.title)).toEqual(['Rex approved One'])
    expect(await approve(ref)).toMatchObject({ issues: [{ message: 'first is not in review' }] })
  })

  test('a send-back needs a note, returns the draft to its writer who hears the note, and a new submission goes on', async () => {
    const ref = await draft(name)

    await submitEntry(ref, writer)
    expect(await sendBackEntry(ref, '  ', reviewer)).toMatchObject({ issues: [{ message: 'Say what to change in a note' }] })
    expect(await sendBackEntry(ref, 'x'.repeat(1001), reviewer)).toMatchObject({ issues: [{ message: 'The note is longer than 1000 characters' }] })

    const back = await sendBackEntry(ref, ' Shorter title ', reviewer)

    expect(back).toMatchObject({ saved: true, review: { status: 'sent-back', events: [{ verb: 'submit' }, { verb: 'send-back', by: 'Rex', note: 'Shorter title' }] } })
    expect((await entryOf(ref))?.draft).toBe(true)
    expect((await notifications.list('writer-1')).map(note => note.title)).toEqual(['Rex sent One back: Shorter title'])
    expect(await sendBackEntry(ref, 'again', reviewer)).toMatchObject({ issues: [{ message: 'first is not in review' }] })
    expect(await submitEntry(ref, writer)).toMatchObject({ saved: true, review: { status: 'review', events: [{ verb: 'submit' }, { verb: 'send-back' }, { verb: 'submit' }] } })
  })

  test('a submission is told to the reviewers it was given, and a notification links the entry', async () => {
    const ref = await draft(name)

    await submitEntry(ref, writer)

    for (const id of ['reviewer-1', 'reviewer-2']) {
      const [note] = await notifications.list(id)

      expect(note).toMatchObject({ title: 'Wanda sent One for review', url: `/admin/collections/${name}/first` })
    }

    expect(await notifications.list('writer-1')).toEqual([])
  })

  test('a publisher publishing the draft ends its review, and a delete or a rename takes it along', async () => {
    const ref = await draft(name)

    await submitEntry(ref, writer)
    expect(await saveEntry({ ...ref, data: { title: 'One', draft: false } })).toMatchObject({ saved: true })
    expect(await readReview(ref)).toMatchObject({ status: 'approved', events: [{ verb: 'submit' }, { verb: 'publish' }] })

    const other = await draft(name, 'second')

    await submitEntry(other, writer)
    expect(await renameEntry(other, 'third')).toMatchObject({ saved: true })
    expect(await readReview(other)).toBeUndefined()
    expect(await readReview({ ...other, slug: 'third' })).toMatchObject({ status: 'review' })
    expect(await deleteEntry({ ...other, slug: 'third' })).toMatchObject({ saved: true })
    expect(await readReview({ ...other, slug: 'third' })).toBeUndefined()
  })
})

describe('review', () => {
  test('a loaded collection keeps its history entries apart from the review steps', async () => {
    const ref = await draft('notes')

    await submitEntry(ref, writer)
    await approve(ref)
    expect((await revisionsOf(ref)).map(revision => revision.verb)).toEqual(['add', 'publish'])
    expect((await readReview(ref))?.events.map(event => event.verb)).toEqual(['submit', 'approve'])
  })

  test('is unavailable to a collection with no draft flag or a loader with no hidden collection', async () => {
    expect(await saveEntry({ collection: 'nodraft', slug: 'first', data: { title: 'One' } }, { create: true })).toMatchObject({ saved: true })
    expect(await submitEntry({ collection: 'nodraft', slug: 'first' }, writer)).toMatchObject({ issues: [{ message: expect.stringContaining('cannot send entries for review') }] })
    expect(await submitEntry({ collection: 'bare', slug: 'a' }, writer)).toMatchObject({ issues: [{ message: expect.stringContaining('cannot send entries for review') }] })
    expect((await findCollection('nodraft'))?.review).toBeUndefined()
    expect((await findCollection('bare'))?.review).toBeUndefined()
  })

  test('a folder collection keeps its review as a file at the repository root, outside its entries', async () => {
    const ref = await draft('posts')

    await submitEntry(ref, writer)

    const written = new Bun.Glob('.cms/review/posts/*.json').scanSync({ cwd: contentPlace().root, dot: true })

    expect([...written]).toEqual(['.cms/review/posts/first.json'])
    expect((await entryOf(ref))?.data).toEqual({ title: 'One', draft: true })
  })

  test('survives a saver that commits instead of writing, which gets the file path and a message', async () => {
    const ref = await draft('posts')
    const saved: { repoPath: string, text: string | undefined, message: string }[] = []

    configure({ files: { save: async (change) => {
      saved.push({ repoPath: change.repoPath, text: change.text, message: change.message })

      return undefined
    } } })

    await submitEntry(ref, writer)
    expect(saved.map(({ repoPath, message }) => [repoPath, message])).toEqual([['.cms/review/posts/first.json', 'content(posts): submit first']])
    expect(JSON.parse(saved[0]!.text!)).toMatchObject({ status: 'review', by: 'Wanda' })
  })

  test('a folder review is written against the version of the file it read', async () => {
    const ref = await draft('posts')
    const bases: (string | null | undefined)[] = []

    configure({ files: { save: async (change) => {
      bases.push(change.base)

      return undefined
    } } })
    await submitEntry(ref, writer)
    expect(bases).toEqual([null])
  })

  test('a review file with a name that is not encoded leaves the other badges', async () => {
    const ref = await draft('posts')

    await submitEntry(ref, writer)
    await Bun.write(join(contentPlace().root, '.cms/review/posts/%.json'), '{}')
    expect([...(await reviewsOf('posts')).keys()]).toEqual(['first'])
  })

  test('an approval whose review cannot be kept leaves the published entry settled, not in review', async () => {
    const ref = await draft('posts')

    await submitEntry(ref, writer)

    const real = (await import('../src/settings')).settings().files

    configure({ files: { ...real, save: async (change) => {
      if (change.repoPath.startsWith('.cms/review'))
        throw new Error('forge down')

      return real.save(change)
    } } })
    expect(await approve(ref)).toMatchObject({ issues: [{ message: expect.stringContaining('could not be kept') }] })
    expect((await entryOf(ref))?.draft).toBe(false)
  })

  test('an approval is of the version sent for review: a change after it is refused until it is sent again', async () => {
    const ref = await draft('posts')

    await submitEntry(ref, writer)
    expect(await saveEntry({ ...ref, data: { title: 'Changed', draft: true } })).toMatchObject({ saved: true })
    expect(await approve(ref)).toMatchObject({ issues: [{ message: 'first changed after it was sent for review: it needs to be sent again' }] })
    expect((await entryOf(ref))?.draft).toBe(true)
    expect(await submitEntry(ref, writer)).toMatchObject({ saved: true })
    expect(await approve(ref)).toMatchObject({ saved: true, entry: { data: { title: 'Changed', draft: false } } })
  })

  test('an approval is of the version the reviewer opened', async () => {
    const ref = await draft('notes')

    await submitEntry(ref, writer)

    const opened = (await entryOf(ref))?.version

    expect(await approveEntry(ref, reviewer, undefined, undefined)).toMatchObject({ issues: [{ message: expect.stringContaining('changed since you opened it') }] })
    expect(await approveEntry(ref, reviewer, undefined, 'another-version')).toMatchObject({ issues: [{ message: 'first changed since you opened it: reload it to read what you approve' }] })
    expect((await entryOf(ref))?.draft).toBe(true)
    expect(await approveEntry(ref, reviewer, undefined, opened)).toMatchObject({ saved: true })
  })

  test('a review file changed after it was read is a conflict that keeps the other write', async () => {
    const ref = await draft('posts')
    const real = settings().files
    const file = join(contentPlace().root, '.cms/review/posts/first.json')

    configure({ files: { ...real, save: async (change) => {
      await mkdir(join(contentPlace().root, '.cms/review/posts'), { recursive: true })
      await Bun.write(file, '{"status":"sent-back","events":[]}')

      return real.save(change)
    } } })
    expect(await submitEntry(ref, writer)).toMatchObject({ issues: [{ message: expect.stringContaining('could not be kept') }] })
    expect(await Bun.file(file).json()).toMatchObject({ status: 'sent-back' })
  })

  test('no slug or collection name reaches outside the review folder', async () => {
    const root = join(contentPlace().root, '.cms', 'review')

    for (const [collection, slug, locale] of [['posts', '..', undefined], ['posts', '../../x', undefined], ['posts', 'a/b', 'en'], ['..', 'x', undefined], ['posts', '%2e%2e', undefined], ['posts', '.', undefined]] as const)
      await writeReview({ collection, slug, locale }, { status: 'review', events: [] })

    const written = [...new Bun.Glob('**/*').scanSync({ cwd: contentPlace().root, dot: true, onlyFiles: true })].filter(path => path.endsWith('.json'))

    expect(written).toHaveLength(6)
    expect(written.every(path => join(contentPlace().root, path).startsWith(`${root}/`))).toBe(true)
    expect([...(await reviewsOf('posts')).keys()].sort()).toEqual(['%2e%2e', '.', '..', '../../x', 'en/a/b'].sort())
  })
})
