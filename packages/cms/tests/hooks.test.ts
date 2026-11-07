import type { BeforeSaveEvent, SaveEvent } from '../src/settings'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { refuse, s } from 'kay'
import { collection } from 'kay/content'
import { memoryFiles } from 'kay/server'
import { scratchDir } from 'kay/test'
import { registerCollections, registerEditSite } from '../../../src/content/edit'
import { contentPlace, setContentPlace } from '../../../src/content/load'
import { setupStorage } from '../../../src/server/storage'
import { activityOf } from '../src/activity'
import { sqliteLoader } from '../src/loaders/sqlite'
import { mediaIndex } from '../src/media'
import { approveEntry, submitEntry } from '../src/reviewing'
import { configure } from '../src/settings'
import { deleteEntry, entryOf, publishEntry, renameEntry, saveEntry } from '../src/store'

const schema = s.Object({ title: s.String(), summary: s.Optional(s.String()), updatedBy: s.Optional(s.String()), draft: s.Optional(s.Boolean()) })
const original = contentPlace()
// Where kay sends what it and its libraries log, as the app's `log` setting says.
const LOG_SINK = Symbol.for('kay.log')
const global = globalThis as { [LOG_SINK]?: unknown }
const sink = global[LOG_SINK]
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))
let count = 0
let restore: ReturnType<typeof registerCollections>
let logged: unknown[][]

// The same entry in a folder collection and in a loaded one, which keeps an activity log.
beforeEach(async () => {
  const dir = await scratchDir('hooks-')

  await mkdir(join(dir, 'posts'), { recursive: true })
  await mkdir(join(dir, '.git'), { recursive: true })
  setContentPlace(dir, dir)
  registerEditSite({ urls: async () => undefined, locales: ['en'], defaultLocale: 'en' })
  setupStorage(memoryFiles(), '.kay/cache')
  logged = []
  global[LOG_SINK] = (...args: unknown[]) => logged.push(args)
  configure({})
  restore = registerCollections([
    ['posts', collection(join(dir, 'posts'), { schema, draft: 'draft' })],
    ['notes', collection(sqliteLoader({ name: 'notes', database: ':memory:', table: `hooks_${++count}` }), { schema, draft: 'draft' })],
  ])
})

afterEach(() => {
  registerCollections(restore)
  setContentPlace(original.root, original.base)
  global[LOG_SINK] = sink
})

const ada = { name: 'Ada', email: 'ada@example.com' }

describe('beforeSave', () => {
  for (const name of ['posts', 'notes']) {
    test(`changes what a ${name} entry is written with, and the schema checks the change`, async () => {
      configure({ beforeSave: ({ author, data }) => ({ data: { ...data, updatedBy: author?.name } }) })
      expect(await saveEntry({ collection: name, slug: 'one', data: { title: 'One' } }, { create: true, author: ada })).toMatchObject({ ok: true, saved: true })
      expect((await entryOf({ collection: name, slug: 'one' }))?.data).toMatchObject({ title: 'One', updatedBy: 'Ada' })

      configure({ beforeSave: () => ({ data: { title: 42 } }) })
      expect(await saveEntry({ collection: name, slug: 'one', data: { title: 'Two' } })).toMatchObject({ ok: false, error: { status: 422 }, issues: [{ path: 'title' }] })
      expect((await entryOf({ collection: name, slug: 'one' }))?.data).toMatchObject({ title: 'One' })
    })
  }

  test('is told the verb, the entry and the one stored before, with the context of kay hooks', async () => {
    const asked: BeforeSaveEvent[] = []

    configure({ beforeSave: (event) => {
      asked.push(event)
      expect(event.context).toHaveProperty('request')
    } })
    await saveEntry({ collection: 'notes', slug: 'one', data: { title: 'One', draft: true } }, { create: true, author: ada })
    await saveEntry({ collection: 'notes', slug: 'one', data: { title: 'Two', draft: true } })
    await publishEntry({ collection: 'notes', slug: 'one' }, ada)
    await renameEntry({ collection: 'notes', slug: 'one' }, 'two')
    await deleteEntry({ collection: 'notes', slug: 'two' })

    expect(asked.map(({ verb, slug, from, previous, data }) => [verb, slug, from, previous?.data.title, data.title, data.draft])).toEqual([
      ['add', 'one', undefined, undefined, 'One', true],
      ['update', 'one', undefined, 'One', 'Two', true],
      ['publish', 'one', undefined, 'Two', 'Two', false],
      ['rename', 'two', 'one', 'Two', 'Two', false],
      ['delete', 'two', undefined, 'Two', 'Two', false],
    ])
  })

  test('refuses with field errors, shown as a schema refusal and answered 422', async () => {
    configure({ beforeSave: ({ data }) => {
      if (data.summary === undefined)
        refuse('A summary is needed', { errors: { summary: 'required' } })
    } })

    for (const name of ['posts', 'notes']) {
      const outcome = await saveEntry({ collection: name, slug: 'one', data: { title: 'One' } }, { create: true })

      expect(outcome).toMatchObject({ ok: false, error: { status: 422, message: 'A summary is needed; required', errors: { '': 'A summary is needed', 'summary': 'required' } }, issues: [{ path: '', message: 'A summary is needed' }, { path: 'summary', message: 'required' }] })
      expect(await entryOf({ collection: name, slug: 'one' })).toBeUndefined()
    }
  })

  test('refuses a publish while a rule across the entry fails, and `false` is a 403', async () => {
    await saveEntry({ collection: 'notes', slug: 'one', data: { title: 'One', draft: true } }, { create: true })
    configure({ beforeSave: ({ verb }) => verb === 'publish' ? refuse('Write a summary first', { errors: { summary: 'required' } }) : undefined })
    expect(await publishEntry({ collection: 'notes', slug: 'one' })).toMatchObject({ ok: false, error: { status: 422 } })
    expect((await entryOf({ collection: 'notes', slug: 'one' }))?.draft).toBe(true)

    configure({ beforeSave: () => false })
    expect(await publishEntry({ collection: 'notes', slug: 'one' })).toMatchObject({ ok: false, error: { status: 403, message: 'Refused' }, issues: [{ path: '', message: 'Refused' }] })
  })

  test('refuses a delete and a rename, whatever the collection', async () => {
    for (const name of ['posts', 'notes']) {
      configure({})
      await saveEntry({ collection: name, slug: 'one', data: { title: 'One' } }, { create: true })
      configure({ beforeSave: ({ verb }) => verb === 'delete' || verb === 'rename' ? refuse('Locked', { status: 423 }) : undefined })
      expect(await deleteEntry({ collection: name, slug: 'one' })).toMatchObject({ ok: false, error: { status: 423, message: 'Locked' } })
      expect(await renameEntry({ collection: name, slug: 'one' }, 'two')).toMatchObject({ ok: false, error: { status: 423 } })
      expect(await entryOf({ collection: name, slug: 'one' })).toBeDefined()
      expect(await entryOf({ collection: name, slug: 'two' })).toBeUndefined()
    }
  })

  test('a throw that is not a refusal refuses with 500, is reported with its source and writes nothing', async () => {
    const failure = new Error('lookup down')

    configure({ beforeSave: () => {
      throw failure
    } })
    expect(await saveEntry({ collection: 'notes', slug: 'one', data: { title: 'One' } }, { create: true })).toMatchObject({ ok: false, error: { status: 500, message: 'Internal server error' } })
    expect(await entryOf({ collection: 'notes', slug: 'one' })).toBeUndefined()
    expect(logged).toContainEqual(['error', 'cms.beforeSave failed', failure, undefined, 'kay'])
  })

  test('a change that is not an object refuses with 500', async () => {
    configure({ beforeSave: () => ({ data: 'nope' as never }) })
    expect(await saveEntry({ collection: 'notes', slug: 'one', data: { title: 'One' } }, { create: true })).toMatchObject({ ok: false, error: { status: 500 } })
  })

  test('does not ask for a reorder', async () => {
    const asked: string[] = []

    configure({ beforeSave: ({ verb }) => {
      asked.push(verb)
    } })
    await saveEntry({ collection: 'posts', slug: 'one', data: { title: 'One' } }, { create: true })
    await saveEntry({ collection: 'posts', slug: 'one', data: { title: 'One', summary: 'x' } }, { verb: 'move' })
    expect(asked).toEqual(['add'])
  })
})

describe('order', () => {
  test('fourEyes refuses an approval before beforeSave is asked', async () => {
    const asked: string[] = []
    const writer = { name: 'Wanda', id: 'writer-1', reviewers: [] }

    configure({ fourEyes: true, beforeSave: ({ verb }) => {
      asked.push(verb)
    } })

    const ref = { collection: 'notes', slug: 'one' }

    await saveEntry({ ...ref, data: { title: 'One', draft: true } }, { create: true })
    await submitEntry(ref, writer)
    asked.length = 0
    expect(await approveEntry(ref, writer, undefined, (await entryOf(ref))?.version)).toMatchObject({ ok: false })
    expect(asked).toEqual([])
    expect(await approveEntry(ref, { name: 'Rex', id: 'reviewer-1', reviewers: [] }, undefined, (await entryOf(ref))?.version)).toMatchObject({ ok: true })
    expect(asked).toEqual(['publish'])
  })

  test('beforeSave is asked before the version check, so a stale save is refused with its changes already made', async () => {
    const asked: string[] = []

    await saveEntry({ collection: 'posts', slug: 'one', data: { title: 'One' } }, { create: true })

    const opened = (await entryOf({ collection: 'posts', slug: 'one' }))?.version

    await saveEntry({ collection: 'posts', slug: 'one', data: { title: 'Two' } }, { version: opened })
    configure({ beforeSave: ({ data }) => {
      asked.push(String(data.title))

      return { data: { ...data, updatedBy: 'hook' } }
    } })
    expect(await saveEntry({ collection: 'posts', slug: 'one', data: { title: 'Three' } }, { version: opened })).toMatchObject({ ok: false, error: { status: 409 } })
    expect(asked).toEqual(['Three'])
  })

  test('roles refuse a delete in the guard, before the route reaches beforeSave', async () => {
    const { default: devApi } = await import('../src/api/dev')
    const { default: apiGuard } = await import('../src/api/_guard')
    const asked: string[] = []

    Object.assign(devApi, { [Symbol.for('kay.api')]: '/_kay/cms/dev' })
    await saveEntry({ collection: 'notes', slug: 'one', data: { title: 'One' } }, { create: true })
    configure({
      guard: () => undefined,
      roles: { writer: [], admin: ['delete'] },
      member: () => ({ name: 'Wes', roles: ['writer'] }),
      beforeSave: ({ verb }) => {
        asked.push(verb)
      },
    })

    const url = new URL('http://site.test/_kay/cms/entries/notes/one')
    const ctx = { request: new Request(url, { method: 'DELETE' }), url, cookies: new Bun.CookieMap(''), locals: {}, deny: (status: number) => {
      throw new Error(`denied ${status}`)
    } }

    await expect(apiGuard(ctx as never)).rejects.toThrow('denied 403')
    expect(asked).toEqual([])
  })
})

describe('onSave', () => {
  test('is told the entry as written and the one stored before, a delete the one it removed', async () => {
    const heard: SaveEvent[] = []

    configure({ beforeSave: ({ data }) => ({ data: { ...data, updatedBy: 'hook' } }), onSave: (event) => {
      heard.push(event)
    } })
    await saveEntry({ collection: 'notes', slug: 'one', data: { title: 'One' } }, { create: true })
    await saveEntry({ collection: 'notes', slug: 'one', data: { title: 'Two' } })
    await deleteEntry({ collection: 'notes', slug: 'one' })

    expect(heard.map(({ verb, data, previous }) => [verb, data, previous?.data])).toEqual([
      ['add', { title: 'One', updatedBy: 'hook' }, undefined],
      ['update', { title: 'Two', updatedBy: 'hook' }, { title: 'One', updatedBy: 'hook' }],
      ['delete', undefined, { title: 'Two', updatedBy: 'hook' }],
    ])
  })
})

describe('uploads', () => {
  async function send(name: string, bytes: Uint8Array<ArrayBuffer> = PNG, type = 'image/png'): Promise<Response> {
    const { default: filesApi } = await import('../src/api/files')
    const form = new FormData()

    form.append('file', new File([bytes], name, { type }))

    return (filesApi as unknown as { handle: (request: Request) => Promise<Response> }).handle(new Request('http://localhost/notes', { method: 'POST', body: form }))
  }

  test('beforeUpload scans the bytes and refuses with its status, storing nothing', async () => {
    const scanned: string[] = []

    configure({ beforeUpload: ({ name, type, size, bytes, collection }) => {
      scanned.push(`${collection} ${name} ${type} ${size} ${bytes.length}`)

      return bytes.length === PNG.length ? refuse('Virus found', { status: 451 }) : undefined
    } })

    const answer = await send('bad.png')

    expect(answer.status).toBe(451)
    expect(await answer.text()).toBe('Virus found')
    expect(scanned).toEqual([`notes bad.png image/png ${PNG.length} ${PNG.length}`])
    expect(await mediaIndex()).toEqual({})
  })

  test('beforeUpload renames and replaces the bytes, the result held to the rules again', async () => {
    const heard: unknown[] = []

    configure({ beforeUpload: ({ name }) => ({ name: `site-${name}`, bytes: new Uint8Array([...PNG, 0]) }), onUpload: (event) => {
      heard.push(event)
    } })

    const answer = await send('a.png')

    expect(answer.status).toBe(200)

    const [key, record] = Object.entries(await mediaIndex())[0]!

    expect(record).toMatchObject({ name: 'site-a.png', size: PNG.length + 1 })
    expect(heard).toMatchObject([{ collection: 'notes', key, path: expect.stringContaining('cms-media'), name: 'site-a.png', size: PNG.length + 1 }])

    configure({ beforeUpload: () => ({ bytes: new Uint8Array(0) }) })
    expect((await send('b.png')).status).toBe(400)
    configure({ beforeUpload: () => ({ name: 'b.html' }) })
    expect((await send('b.png')).status).toBe(415)
  })

  test('onUpload is told after the file is stored, the activity log keeps the upload, and a throw leaves the upload', async () => {
    const failure = new Error('cdn down')

    configure({ onUpload: () => {
      throw failure
    } })
    expect((await send('a.png')).status).toBe(200)
    expect(Object.keys(await mediaIndex())).toHaveLength(1)
    expect(logged).toContainEqual(['error', 'cms.onUpload failed', failure, undefined, 'kay'])
    expect((await activityOf('notes')).map(event => [event.verb, event.slug.startsWith('cms-media/')])).toEqual([['upload', true]])
  })

  test('a beforeUpload that throws refuses with 500 and stores nothing', async () => {
    configure({ beforeUpload: () => {
      throw new Error('scanner down')
    } })
    expect((await send('a.png')).status).toBe(500)
    expect(await mediaIndex()).toEqual({})
  })
})
