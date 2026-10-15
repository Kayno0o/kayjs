import type { DraftEntry, DraftResult } from '../src/kay/contract'
import { describe, expect, it } from 'bun:test'
import { createDrafts } from '../src/drafts'
import { BODY } from '../src/markers'

const post: DraftEntry = { collection: 'posts', slug: 'hello', data: { title: 'Hello', tags: ['a'] }, body: '# Hello' }

function setup(answer: (entries: DraftEntry[]) => Promise<DraftResult> = async () => ({})) {
  const calls: DraftEntry[][] = []
  const drafts = createDrafts({
    delay: 5,
    show: async (entries) => {
      calls.push(entries)

      return answer(entries)
    },
  })

  drafts.open(post)

  return { drafts, calls }
}

const settled = () => Bun.sleep(20)

describe('createDrafts', () => {
  it('renders the page once typing pauses, with every changed entry', async () => {
    const { drafts, calls } = setup()

    drafts.set(post, 'title', 'Hel')
    drafts.set(post, 'title', 'Hello there')
    drafts.set(post, BODY, '# Hi')
    await settled()

    expect(calls).toEqual([[{ ...post, data: { title: 'Hello there', tags: ['a'] }, body: '# Hi' }]])
    expect(drafts.value(post, 'title')).toBe('Hello there')
    expect(drafts.value(post, BODY)).toBe('# Hi')
    expect(drafts.changed(post)).toBe(true)
  })

  it('counts an edit typed back to the saved text as no change', async () => {
    const { drafts, calls } = setup()

    drafts.set(post, 'tags.0', 'b')
    drafts.set(post, 'tags.0', 'a')
    await settled()

    expect(drafts.changed(post)).toBe(false)
    expect(calls).toEqual([[]])
  })

  it('drops the edits on reset and renders the saved page', async () => {
    const { drafts, calls } = setup()

    drafts.set(post, 'title', 'Other')
    drafts.reset(post)
    await settled()

    expect(drafts.value(post, 'title')).toBe('Hello')
    expect(calls).toEqual([[]])
  })

  it('keeps a draft when the entry is opened again', () => {
    const { drafts } = setup()

    drafts.set(post, 'title', 'Kept')
    drafts.open(post)

    expect(drafts.value(post, 'title')).toBe('Kept')
  })

  it('hands each field the issues of its own path', async () => {
    const { drafts } = setup(async () => ({ issues: [{ collection: 'posts', slug: 'hello', path: 'title', message: 'Too short' }, { collection: 'posts', slug: 'other', path: 'title', message: 'Elsewhere' }] }))

    drafts.set(post, 'title', '')
    await settled()

    expect(drafts.issues(post, 'title').map(issue => issue.message)).toEqual(['Too short'])
    expect(drafts.issues(post, 'tags')).toEqual([])
    expect(drafts.issues(post)).toHaveLength(1)
  })

  it('tells the body\'s issues from a data field named body and from the entry\'s own', async () => {
    const { drafts } = setup(async () => ({ issues: [
      { collection: 'posts', slug: 'hello', path: '', body: true, message: 'Unknown component Chart' },
      { collection: 'posts', slug: 'hello', path: 'body', message: 'Data field' },
      { collection: 'posts', slug: 'hello', path: '', message: 'Needs a locale' },
    ] }))

    drafts.set(post, BODY, '<Chart />')
    await settled()

    expect(drafts.issues(post, BODY).map(issue => issue.message)).toEqual(['Unknown component Chart'])
    expect(drafts.issues(post, 'body').map(issue => issue.message)).toEqual(['Data field'])
    expect(drafts.issues(post, '').map(issue => issue.message)).toEqual(['Needs a locale'])
  })

  it('keeps only the answer of the latest render, ignoring an aborted one', async () => {
    const answers: ((result: DraftResult) => void)[] = []
    const failures: ((error: unknown) => void)[] = []
    const { drafts } = setup(async () => new Promise<DraftResult>((resolve, reject) => {
      answers.push(resolve)
      failures.push(reject)
    }))

    drafts.set(post, 'title', 'A')
    await settled()
    drafts.set(post, 'title', 'AB')
    await settled()

    expect(drafts.rendering()).toBe(true)
    failures[0]?.(new DOMException('aborted', 'AbortError'))
    answers[1]?.({ issues: [{ collection: 'posts', slug: 'hello', path: 'title', message: 'Latest' }] })
    await settled()

    expect(drafts.rendering()).toBe(false)
    expect(drafts.failure()).toBeUndefined()
    expect(drafts.issues(post, 'title').map(issue => issue.message)).toEqual(['Latest'])
  })

  it('reports a render that failed for another reason', async () => {
    const { drafts } = setup(async () => {
      throw new Error('Server down')
    })

    drafts.set(post, 'title', 'X')
    await settled()

    expect(drafts.failure()).toBe('Server down')
  })

  it('refuses an edit to an entry it never opened', () => {
    const { drafts } = setup()

    expect(() => drafts.set({ collection: 'posts', slug: 'nope' }, 'title', 'X')).toThrow('posts:nope was never opened')
  })
})

describe('saving', () => {
  it('takes the saved entry as the new baseline', () => {
    const { drafts } = setup()

    drafts.set(post, 'title', 'Saved title')
    drafts.markSaved(post, drafts.entry(post)!, 'v2')

    expect(drafts.changed(post)).toBe(false)
    expect(drafts.version(post)).toBe('v2')
    drafts.reset(post)
    expect(drafts.value(post, 'title')).toBe('Saved title')
  })

  it('keeps an edit typed while the save was on its way unsaved, to go with the next', () => {
    const { drafts } = setup()

    drafts.set(post, 'title', 'Sent')
    const sent = drafts.entry(post)!

    drafts.set(post, 'title', 'Sent, then more')
    drafts.markSaved(post, sent)

    expect(drafts.changed(post)).toBe(true)
    expect(drafts.value(post, 'title')).toBe('Sent, then more')
    drafts.reset(post)
    expect(drafts.value(post, 'title')).toBe('Sent')
  })

  it('keeps a refusal of the whole entry through renders, until it saves, resets or keeps its edits over a conflict', async () => {
    const { drafts } = setup(async () => ({ issues: [] }))

    drafts.set(post, 'title', 'Mine')
    drafts.refuse(post, { message: 'saved since', conflict: { version: 'f00d' } })
    drafts.set(post, 'title', 'Mine, typed on')
    await settled()
    expect(drafts.refusal(post)?.message).toBe('saved since')

    drafts.keepEdits(post)
    expect([drafts.refusal(post), drafts.version(post), drafts.value(post, 'title')]).toEqual([undefined, 'f00d', 'Mine, typed on'])

    drafts.refuse(post, { message: 'saved since', conflict: { version: null } })
    drafts.keepEdits(post)
    expect([drafts.version(post), drafts.recreating(post)]).toEqual([undefined, true])
    drafts.reset(post)
    expect(drafts.recreating(post)).toBe(false)

    drafts.set(post, 'title', 'Mine')
    drafts.refuse(post, { message: 'saved since', conflict: { version: null } })
    drafts.keepEdits(post)
    drafts.markSaved(post, drafts.entry(post)!, 'f00e')
    expect(drafts.recreating(post)).toBe(false)

    drafts.refuse(post, { message: 'Forgejo did not answer' })
    drafts.markSaved(post, drafts.entry(post)!, 'f00e')
    expect(drafts.refusal(post)).toBeUndefined()

    drafts.refuse(post, { message: 'Forgejo did not answer' })
    drafts.reset(post)
    expect(drafts.refusal(post)).toBeUndefined()
  })

  it('shows the issues a save was refused with', () => {
    const { drafts } = setup()

    drafts.report([{ collection: 'posts', slug: 'hello', path: '', message: 'hello already exists' }])

    expect(drafts.issues(post, '').map(issue => issue.message)).toEqual(['hello already exists'])
  })
})
