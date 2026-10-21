import type { DraftEntry } from '../src/kay/contract'
import { describe, expect, it, spyOn } from 'bun:test'
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
    before.flush()

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
    first.flush()
    second.open(post, 'v1')

    expect(second.value(post, 'title')).toBe('From the first tab')
  })

  it('forgets the draft once saved, reset, or typed back to the saved text', () => {
    const storage = memoryStorage()
    const drafts = pageOf(storage)

    drafts.open(post, 'v1')
    drafts.set(post, 'title', 'Mine')
    drafts.flush()
    expect(storage.length).toBe(1)
    drafts.markSaved(post, drafts.entry(post)!, 'v2')
    expect(storage.length).toBe(0)

    drafts.set(post, 'title', 'Again')
    drafts.reset(post)
    expect(storage.length).toBe(0)

    drafts.set(post, 'title', 'Again')
    drafts.flush()
    drafts.set(post, 'title', 'Mine')
    expect(storage.length).toBe(0)
  })

  it('keeps the draft when a save fails, and the edits typed while one saves', () => {
    const storage = memoryStorage()
    const drafts = pageOf(storage)

    drafts.open(post, 'v1')
    drafts.set(post, 'title', 'Sent')
    drafts.flush()
    drafts.refuse(post, { message: 'Forgejo did not answer' })
    expect(storage.length).toBe(1)

    const sent = drafts.entry(post)!

    drafts.set(post, 'title', 'Sent, then more')
    drafts.flush()
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
    before.flush()

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
    before.flush()
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
    drafts.flush()
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

describe('kept drafts of an entry with no version', () => {
  it('restores the edits while the saved copy is the one they were made from, and drops them once it changed', () => {
    const storage = memoryStorage()
    const before = pageOf(storage)

    before.open(post)
    before.set(post, 'title', 'Mine')
    before.flush()

    const same = pageOf(storage)

    same.open({ ...post, data: { title: 'Hello' } })
    expect([same.value(post, 'title'), same.recovery(post)?.restored]).toEqual(['Mine', true])

    const moved = pageOf(storage)

    moved.open({ ...post, data: { title: 'Saved elsewhere' } })
    expect([moved.value(post, 'title'), moved.changed(post), moved.recovery(post)?.restored, storage.length]).toEqual(['Saved elsewhere', false, false, 0])
  })

  it('keeps a hash of the saved copy, not the copy', () => {
    const storage = memoryStorage()
    const body = 'A long Markdown body. '.repeat(50)
    const before = pageOf(storage)

    before.open({ ...post, body })
    before.set(post, 'title', 'Mine')
    before.flush()

    const kept = JSON.parse(storage.getItem('kcms:draft:posts:hello')!) as { base: unknown }

    expect(kept.base).toBeTypeOf('string')
    expect(storage.getItem('kcms:draft:posts:hello')!.split(body).length - 1).toBe(1)

    const same = pageOf(storage)

    same.open({ ...post, body })
    expect(same.recovery(post)?.restored).toBe(true)

    const moved = pageOf(storage)

    moved.open({ ...post, body: `${body}!` })
    expect(moved.recovery(post)?.restored).toBe(false)
  })

  it('drops a draft kept with no record of its saved copy', () => {
    const storage = memoryStorage()

    storage.setItem('kcms:draft:posts:hello', JSON.stringify({ entry: { ...post, data: { title: 'Old' } }, at: Date.now() }))

    const after = pageOf(storage)

    after.open(post)
    expect([after.value(post, 'title'), after.recovery(post)?.restored, storage.length]).toEqual(['Hello', false, 0])
  })
})

describe('writing the kept draft', () => {
  it('writes once per pause rather than on every keystroke', async () => {
    const storage = memoryStorage()
    const writes = spyOn(storage, 'setItem')
    const drafts = createDrafts({ show: async () => ({}), delay: '10ms', keep: browserKeeper(() => storage) })

    drafts.open(post, 'v1')

    for (const title of ['H', 'He', 'Hel'])
      drafts.set(post, 'title', title)

    expect(writes).not.toHaveBeenCalled()
    await Bun.sleep(40)
    expect(writes).toHaveBeenCalledTimes(1)
    expect((JSON.parse(storage.getItem('kcms:draft:posts:hello')!) as { entry: DraftEntry }).entry.data.title).toBe('Hel')
  })
})

describe('taking the other save after a conflict', () => {
  it('adopts the stored copy and version, dropping the edits and the refusal', () => {
    const storage = memoryStorage()
    const drafts = pageOf(storage)

    drafts.open(post, 'v1')
    drafts.set(post, 'title', 'Mine')
    drafts.flush()
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
