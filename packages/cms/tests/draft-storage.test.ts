import type { DraftEntry } from '../src/kay/contract'
import { describe, expect, it } from 'bun:test'
import { browserKeeper, KEEP_FOR } from '../src/draft-storage'
import { createDrafts } from '../src/drafts'
import { BODY } from '../src/markers'

const post: DraftEntry = { collection: 'posts', slug: 'hello', data: { title: 'Hello' }, body: '# Hello' }

function memoryStorage(): Storage {
  const items = new Map<string, string>()

  return {
    get length() { return items.size },
    clear: () => items.clear(),
    getItem: key => items.get(key) ?? null,
    key: at => [...items.keys()][at] ?? null,
    removeItem: key => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

function pageOf(storage: Storage, now = () => Date.now()) {
  return createDrafts({ show: async () => ({}), delay: '1ms', keep: browserKeeper(() => storage, now) })
}

describe('drafts kept in the browser', () => {
  it('offers the edits back after a reload, as the page left them', () => {
    const storage = memoryStorage()
    const before = pageOf(storage)

    before.open(post, 'v1')
    before.set(post, 'title', 'Hello there')

    const after = pageOf(storage)

    after.open(post, 'v1')
    expect(after.value(post, 'title')).toBe('Hello there')
    expect(after.changed(post)).toBe(true)
    expect(after.recovery(post)?.restored).toBe(true)
    expect(after.anyChanged()).toBe(true)
  })

  it('shares a draft between two tabs, the later one opening with what the first typed', () => {
    const storage = memoryStorage()
    const first = pageOf(storage)
    const second = pageOf(storage)

    first.open(post, 'v1')
    first.set(post, 'title', 'From the first tab')
    second.open(post, 'v1')

    expect(second.value(post, 'title')).toBe('From the first tab')
  })

  it('forgets the draft once saved, reset, or typed back to the saved text', () => {
    const storage = memoryStorage()
    const drafts = pageOf(storage)

    drafts.open(post, 'v1')
    drafts.set(post, 'title', 'Mine')
    expect(storage.length).toBe(1)
    drafts.markSaved(post, drafts.entry(post)!, 'v2')
    expect(storage.length).toBe(0)

    drafts.set(post, 'title', 'Again')
    drafts.reset(post)
    expect(storage.length).toBe(0)

    drafts.set(post, 'title', 'Again')
    drafts.set(post, 'title', 'Mine')
    expect(storage.length).toBe(0)
  })

  it('keeps the draft when a save fails, and the edits typed while one saves', () => {
    const storage = memoryStorage()
    const drafts = pageOf(storage)

    drafts.open(post, 'v1')
    drafts.set(post, 'title', 'Sent')
    drafts.refuse(post, { message: 'Forgejo did not answer' })
    expect(storage.length).toBe(1)

    const sent = drafts.entry(post)!

    drafts.set(post, 'title', 'Sent, then more')
    drafts.markSaved(post, sent, 'v2')

    const after = pageOf(storage)

    after.open({ ...post, data: { title: 'Sent' } }, 'v2')
    expect(after.value(post, 'title')).toBe('Sent, then more')
  })

  it('does not restore a draft older than the stored entry, and says so', () => {
    const storage = memoryStorage()
    const before = pageOf(storage)

    before.open(post, 'v1')
    before.set(post, 'title', 'Stale')

    const after = pageOf(storage)

    after.open({ ...post, data: { title: 'Saved by someone else' } }, 'v2')
    expect(after.value(post, 'title')).toBe('Saved by someone else')
    expect(after.changed(post)).toBe(false)
    expect(after.recovery(post)?.restored).toBe(false)
    expect(storage.length).toBe(0)
  })

  it('drops a draft past its time, and one that is not a draft', () => {
    const storage = memoryStorage()
    let now = 1_000_000
    const before = pageOf(storage, () => now)

    before.open(post, 'v1')
    before.set(post, 'title', 'Old')
    now += KEEP_FOR + 1

    const after = pageOf(storage, () => now)

    after.open(post, 'v1')
    expect(after.changed(post)).toBe(false)
    expect(after.recovery(post)).toBeUndefined()

    storage.setItem('kcms:draft:posts:hello', '{"nonsense":true}')
    pageOf(storage).open(post, 'v1')
    expect(storage.length).toBe(0)
  })

  it('forgets every draft when edits are discarded', () => {
    const storage = memoryStorage()
    const drafts = pageOf(storage)
    const other: DraftEntry = { collection: 'posts', slug: 'other', data: { title: 'Other' } }

    storage.setItem('unrelated', 'kept')
    drafts.open(post, 'v1')
    drafts.open(other, 'v1')
    drafts.set(post, 'title', 'Mine')
    drafts.set(other, 'title', 'Mine too')
    drafts.discardAll()

    expect(drafts.anyChanged()).toBe(false)
    expect(drafts.value(post, 'title')).toBe('Hello')
    expect(storage.length).toBe(1)

    // A draft of an entry this page never opened goes too.
    storage.setItem('kcms:draft:posts:elsewhere', '{}')
    drafts.discardAll()
    expect(storage.length).toBe(1)
  })

  it('works with no storage, or storage that throws', () => {
    const throwing = { ...memoryStorage(), getItem: () => {
      throw new Error('blocked')
    }, setItem: () => {
      throw new Error('full')
    }, removeItem: () => {
      throw new Error('blocked')
    } } as Storage

    for (const get of [() => undefined, () => throwing]) {
      const drafts = createDrafts({ show: async () => ({}), keep: browserKeeper(get) })

      drafts.open(post, 'v1')
      drafts.set(post, 'title', 'Mine')
      drafts.discardAll()
      expect(drafts.value(post, 'title')).toBe('Hello')
    }
  })
})

describe('taking the other save after a conflict', () => {
  it('adopts the stored copy and version, dropping the edits and the refusal', () => {
    const storage = memoryStorage()
    const drafts = pageOf(storage)

    drafts.open(post, 'v1')
    drafts.set(post, 'title', 'Mine')
    drafts.refuse(post, { message: 'saved since', conflict: { version: 'v2' } })
    drafts.adopt(post, { ...post, data: { title: 'Theirs' } }, 'v2')

    expect([drafts.value(post, 'title'), drafts.version(post), drafts.changed(post), drafts.refusal(post), storage.length]).toEqual(['Theirs', 'v2', false, undefined, 0])
  })

  it('lists the fields both sides changed from the copy the edits were made from', () => {
    const drafts = pageOf(memoryStorage())

    const base = { ...post, data: { title: 'Hello', tags: ['a', 'b'], seo: { description: 'x' }, intro: 'i' }, body: '# Hello' }

    drafts.open(base, 'v1')
    drafts.set(post, 'tags.1', 'c')
    drafts.set(post, 'seo.description', 'y')
    drafts.set(post, BODY, '# Mine')

    // They changed the title, the description and the body; only the last two were changed here too.
    expect(drafts.differences(post, { ...base, data: { ...base.data, title: 'Theirs', seo: { description: 'z' } }, body: '# Theirs' })).toEqual(['seo.description', BODY])
  })
})
