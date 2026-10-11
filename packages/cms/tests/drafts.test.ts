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
    drafts.markSaved(post)

    expect(drafts.changed(post)).toBe(false)
    drafts.reset(post)
    expect(drafts.value(post, 'title')).toBe('Saved title')
  })

  it('shows the issues a save was refused with', () => {
    const { drafts } = setup()

    drafts.report([{ collection: 'posts', slug: 'hello', path: '', message: 'hello already exists' }])

    expect(drafts.issues(post, '').map(issue => issue.message)).toEqual(['hello already exists'])
  })
})
