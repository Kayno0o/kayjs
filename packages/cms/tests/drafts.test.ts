import type { DurationText } from 'kay'
import type { DraftEntry, DraftResult } from '../src/kay/contract'
import { describe, expect, it } from 'bun:test'
import { createDrafts } from '../src/drafts'
import { BODY } from '../src/markers'

const post: DraftEntry = { collection: 'posts', slug: 'hello', data: { title: 'Hello', tags: ['a'] }, body: '# Hello' }

function setup(answer: (entries: DraftEntry[]) => Promise<DraftResult> = async () => ({}), delay: DurationText = '5ms') {
  const calls: DraftEntry[][] = []
  const drafts = createDrafts({
    delay,
    show: async (entries) => {
      calls.push(entries)

      return answer(entries)
    },
  })

  drafts.open(post)

  return { drafts, calls }
}

const settled = async () => Bun.sleep(20)

describe('opening an entry again', () => {
  it('shows the current copy and version of an entry with no edits', () => {
    const { drafts } = setup()

    drafts.open({ ...post, data: { title: 'Saved elsewhere', tags: ['a'] } }, 'v2')

    expect([drafts.value(post, 'title'), drafts.version(post), drafts.changed(post)]).toEqual(['Saved elsewhere', 'v2', false])
  })

  it('keeps the edits and the version they were made from, so the next save meets the conflict', () => {
    const { drafts } = setup()

    drafts.open(post, 'v1')
    drafts.set(post, 'title', 'Mine')
    drafts.open({ ...post, data: { title: 'Saved elsewhere', tags: ['a'] } }, 'v2')

    expect([drafts.value(post, 'title'), drafts.version(post), drafts.changed(post)]).toEqual(['Mine', 'v1', true])
  })
})

describe('opening from an effect, as the page editor does', () => {
  it('keeps a save and the edits typed after it when the effect runs again, and takes a copy it is offered anew', async () => {
    const { effect, signal, flush } = await import('kay')
    const drafts = createDrafts({ show: async () => ({}) })
    const source = signal({ entry: post, version: 'v1' })

    effect(() => {
      const offer = source()

      drafts.open(offer.entry, offer.version)
    })
    flush()

    drafts.set(post, 'title', 'Saved')
    drafts.markSaved(post, drafts.entry(post)!, 'v2')
    flush()
    expect([drafts.value(post, 'title'), drafts.version(post), drafts.changed(post)]).toEqual(['Saved', 'v2', false])

    drafts.set(post, 'title', 'Typed after')
    flush()
    expect([drafts.value(post, 'title'), drafts.changed(post)]).toEqual(['Typed after', true])

    drafts.reset(post)
    source.set({ entry: { ...post, data: { title: 'Offered anew', tags: ['a'] } }, version: 'v3' })
    flush()
    expect([drafts.value(post, 'title'), drafts.version(post)]).toEqual(['Offered anew', 'v3'])
  })
})

describe('createDrafts', () => {
  it('reads the delay as a duration, and refuses a bare number', async () => {
    const { drafts, calls } = setup(undefined, '5ms')

    drafts.set(post, 'title', 'Hel')
    await settled()
    expect(calls).toHaveLength(1)
    expect(() => setup(undefined, 5 as never).drafts.set(post, 'title', 'Hel')).toThrow('takes its unit')
  })

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

  it('keeps the issues of a refused save through a render scheduled before it, until the next edit renders', async () => {
    const { drafts, calls } = setup(async () => ({ issues: [] }))
    const refusal = { collection: 'posts', slug: 'hello', path: '', message: 'would run as the site' }

    drafts.set(post, 'title', 'Hel')
    drafts.report([refusal])
    await settled()

    expect(calls).toHaveLength(1)
    expect(drafts.issues(post, '').map(issue => issue.message)).toEqual(['would run as the site'])

    drafts.set(post, 'title', 'Hell')
    await settled()

    expect(calls).toHaveLength(2)
    expect(drafts.issues(post, '')).toEqual([])
  })
})

describe('the issues of a refused save', () => {
  const issue = (path: string, message: string) => ({ collection: 'posts', slug: 'hello', path, message })

  it('lose only the edited field\'s own on an edit, whatever the render answers', async () => {
    const { drafts } = setup()

    drafts.report([issue('title', 'Title is required'), issue('tags', 'Tags is not valid'), issue('', 'Entry level')])
    drafts.set(post, 'title', 'Hel')
    await settled()

    expect(drafts.issues(post).map(found => found.message)).toEqual(['Tags is not valid', 'Entry level'])

    drafts.set(post, 'tags', ['b'])
    await settled()

    expect(drafts.issues(post).map(found => found.message)).toEqual(['Entry level'])
  })

  it('lose the body\'s only to an edit of the body, not to a data field named body', () => {
    const { drafts } = setup()

    drafts.report([{ ...issue('', 'Unknown component'), body: true }, issue('body', 'Data field')])
    drafts.set(post, 'body', 'x')

    expect(drafts.issues(post).map(found => found.message)).toEqual(['Unknown component'])

    drafts.set(post, BODY, 'y')

    expect(drafts.issues(post)).toEqual([])
  })

  it('are replaced by a render that names issues, as the page\'s preview does, and kept by one that names none', async () => {
    const { drafts } = setup(async () => ({ issues: [issue('tags', 'Fresh')] }))

    drafts.report([issue('title', 'Stale'), issue('tags', 'Older')])
    drafts.set(post, 'title', 'Hel')
    await settled()

    expect(drafts.issues(post).map(found => found.message)).toEqual(['Fresh'])
  })

  it('go one by one with the slug\'s dismissed alone', () => {
    const { drafts } = setup()

    drafts.report([{ ...issue('', 'taken'), key: 'slug' }, { ...issue('', 'bad locale'), key: 'locale' }])
    drafts.dismissWhere(post, found => found.key === 'slug')

    expect(drafts.issues(post, '').map(found => found.message)).toEqual(['bad locale'])
  })

  it('go with a reset, and a text that does not parse is forgotten with it', () => {
    const { drafts } = setup()

    drafts.report([issue('title', 'x')])
    drafts.block(post, 'meta', 'Meta is not valid JSON')
    drafts.reset(post)

    expect([drafts.issues(post), drafts.blocked(post)]).toEqual([[], []])
  })

  it('remember the fields whose text does not parse, until it does', () => {
    const { drafts } = setup()

    drafts.block(post, 'meta', 'bad')
    drafts.block(post, 'other', 'worse')
    drafts.block(post, 'meta', undefined)

    expect(drafts.blocked(post)).toEqual([{ path: 'other', message: 'worse' }])
    expect(drafts.blocked(post, 'meta')).toEqual([])
  })

  it('names the entries with edits the page does not show, as the schema refuses them', async () => {
    const { drafts } = setup(async () => ({ issues: [{ collection: 'posts', slug: 'hello', path: 'title', message: 'Too short' }] }))

    expect(drafts.stale()).toEqual([])
    drafts.set(post, 'title', '')
    await settled()
    expect(drafts.stale().map(entry => entry.slug)).toEqual(['hello'])
    drafts.reset(post)
    await settled()
    expect(drafts.stale()).toEqual([])
  })

  it('says it is rendering from the edit to the answer', async () => {
    let answer: (result: DraftResult) => void = () => undefined
    const { drafts } = setup(async () => new Promise<DraftResult>((resolve) => {
      answer = resolve
    }))

    expect(drafts.rendering()).toBe(false)
    drafts.set(post, 'title', 'A')
    await settled()
    expect(drafts.rendering()).toBe(true)
    answer({})
    await settled()
    expect(drafts.rendering()).toBe(false)
  })

  it('shows the edits again on request, and renders nothing when there are none', async () => {
    const { drafts, calls } = setup()

    drafts.reapply()
    await settled()
    expect(calls).toEqual([])
    drafts.set(post, 'title', 'Kept')
    await settled()
    drafts.reapply()
    await settled()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual([{ ...post, data: { title: 'Kept', tags: ['a'] } }])
  })

  it('compares an edit with the saved text of the entry saved last', async () => {
    const { drafts } = setup()

    drafts.set(post, 'title', 'Saved')
    drafts.markSaved(post, drafts.entry(post) as DraftEntry)
    expect(drafts.changed(post)).toBe(false)
    drafts.set(post, 'title', 'Hello')
    expect(drafts.changed(post)).toBe(true)
    drafts.set(post, 'title', 'Saved')
    expect(drafts.changed(post)).toBe(false)
  })
})
