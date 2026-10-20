import type { ScreenCollection, StoredEntry } from '../../../src/kay/contract'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { testSite } from 'kay/test'

await testSite({ root: join(import.meta.dir, '..') })

// kayjs-ui's toasts alone, as its entry also loads icons only kay's build resolves.
const toastModule = join(dirname(Bun.resolveSync('@kaynooo/kayjs-ui/package.json', import.meta.dir)), 'src/toast.ts')
const { toasts } = await import(toastModule) as typeof import('../../../../ui/src/toast')

void mock.module('@kaynooo/kayjs-ui', async () => import(toastModule) as Promise<Record<string, unknown>>)

const { createEntryForm } = await import('../../../src/form')
const { deleteMessage } = await import('../../../src/listing')
const { isSaveShortcut, saveShortcut } = await import('../../../src/editor/shortcut')

const talks: ScreenCollection = { name: 'talks', kind: 'folder', localized: false, components: [], publishField: 'at', draftField: 'draft', schema: { properties: { title: { type: 'string' }, at: { type: 'string', format: 'date-time' }, draft: { type: 'boolean' } } } }
const ahead = new Date(Date.now() + 86_400_000).toISOString()
const talk = (data: Record<string, unknown>) => ({ slug: 'talk', data, draft: false, version: 'v1', url: '/talks/talk' }) as StoredEntry

interface Sent { method: string, body: { data: Record<string, unknown>, version?: string } }

// The entries API answering after `wait` with `answer`, recording what was sent.
function server(answer: (count: number) => unknown, wait = 10) {
  const sent: Sent[] = []

  spyOn(globalThis, 'fetch').mockImplementation((async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: init?.method ?? 'GET', body: init?.body === undefined ? {} : JSON.parse(String(init.body)) } as Sent)
    await Bun.sleep(wait)

    return Response.json(answer(sent.length))
  }) as typeof fetch)

  return sent
}

const refused = { issues: [{ collection: 'talks', slug: 'talk', path: '', message: 'Forgejo did not answer' }] }

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.()
  toasts.set([])
})

describe('Save', () => {
  test('waits for an edit on a saved entry, and a new entry can always be created', () => {
    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk' }) })

    expect([form.dirty(), form.canSave()]).toEqual([false, false])
    form.drafts.set(form.entry, 'title', 'Other')
    expect([form.dirty(), form.canSave()]).toEqual([true, true])
    form.reset()
    expect([form.dirty(), form.canSave()]).toEqual([false, false])
    expect(createEntryForm({ prefix: '/admin', collection: talks }).canSave()).toBe(true)
  })

  test('sends nothing when asked with nothing to save', async () => {
    const sent = server(() => ({ saved: true, version: 'v2' }))
    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk' }) })

    await form.save()
    expect(sent).toHaveLength(0)
  })

  test('is busy while the save is on its way, then says when it was saved and whether the site must rebuild', async () => {
    server(() => ({ saved: true, version: 'v2', commit: { sha: 'abc' } }))

    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk' }) })

    form.drafts.set(form.entry, 'title', 'Other')

    const saving = form.save()

    expect([form.saving(), form.canSave(), form.savedAt()]).toEqual([true, false, undefined])
    await saving
    expect([form.saving(), form.dirty(), form.savedAt()?.rebuilding]).toEqual([false, false, true])
    expect(Date.now() - form.savedAt()!.at).toBeLessThan(5000)
  })

  test('says a save needing no rebuild is live', async () => {
    server(() => ({ saved: true, version: 'v2' }))

    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk' }) })

    form.drafts.set(form.entry, 'title', 'Other')
    await form.save()
    expect(form.savedAt()?.rebuilding).toBe(false)
  })

  test('keeps no saved time for a refused save', async () => {
    server(() => refused)

    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk' }) })

    form.drafts.set(form.entry, 'title', 'Other')
    await form.save()
    expect([form.savedAt(), form.dirty()]).toEqual([undefined, true])
  })
})

describe('the save shortcut', () => {
  const key = (init: Partial<Record<'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing', unknown>>) => ({ key: 's', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as Parameters<typeof isSaveShortcut>[0]

  test.each([
    [{ ctrlKey: true }, true],
    [{ metaKey: true }, true],
    [{ ctrlKey: true, key: 'S' }, true],
    [{}, false],
    [{ ctrlKey: true, shiftKey: true }, false],
    [{ ctrlKey: true, altKey: true }, false],
    [{ ctrlKey: true, key: 'a' }, false],
    [{ ctrlKey: true, isComposing: true }, false],
  ])('%j is %p', (init, expected) => {
    expect(isSaveShortcut(key(init))).toBe(expected)
  })

  test('saves and keeps the browser from saving the page', async () => {
    const target = new EventTarget()
    let saved = 0

    saveShortcut(() => saved++, target)
    await Bun.sleep(5)

    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 's', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })

    target.dispatchEvent(event)
    expect([saved, event.defaultPrevented]).toEqual([1, true])

    const other = Object.assign(new Event('keydown', { cancelable: true }), { key: 'x', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })

    target.dispatchEvent(other)
    expect([saved, other.defaultPrevented]).toEqual([1, false])
  })
})

describe('Publish', () => {
  test('saves the draft flag alone and shows the entry published', async () => {
    const sent = server(() => ({ saved: true, version: 'v2' }))
    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk', draft: true }) })

    await form.publish()
    expect(sent.map(({ body }) => body.data)).toEqual([{ title: 'Talk', draft: false }])
    expect([form.isDraft(), form.dirty()]).toEqual([false, false])
  })

  test('refuses over edits not saved, sending nothing and keeping them', async () => {
    const sent = server(() => ({ saved: true, version: 'v2' }))
    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk', draft: true }) })

    form.drafts.set(form.entry, 'title', 'Half typ')
    await form.publish()
    expect(sent).toHaveLength(0)
    expect([form.isDraft(), form.drafts.value(form.entry, 'title')]).toEqual([true, 'Half typ'])
    expect(toasts().map(toast => toast.message)).toEqual(['You have unsaved changes. Save or cancel them first, so this does not save them too.'])
  })

  test('puts the form back to a draft when the save is refused or fails', async () => {
    server(() => refused)

    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk', draft: true }) })

    await form.publish()
    expect([form.isDraft(), form.dirty()]).toEqual([true, false])

    spyOn(globalThis, 'fetch').mockImplementation((async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch)
    await form.publish()
    expect([form.isDraft(), form.dirty()]).toEqual([true, false])
  })

  test('does nothing for a collection with no draft field or a new entry', async () => {
    const sent = server(() => ({ saved: true }))

    await createEntryForm({ prefix: '/admin', collection: { ...talks, draftField: undefined }, entry: talk({ title: 'Talk' }) }).publish()
    await createEntryForm({ prefix: '/admin', collection: talks }).publish()
    expect(sent).toHaveLength(0)
  })
})

describe('Unpublish', () => {
  test('turns a published entry back to a draft', async () => {
    const sent = server(() => ({ saved: true, version: 'v2' }))
    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk', draft: false }) })

    await form.unpublish()
    expect(sent.map(({ body }) => body.data)).toEqual([{ title: 'Talk', draft: true }])
    expect([form.isDraft(), form.dirty()]).toEqual([true, false])
  })

  test('keeps it published when refused, and refuses over unsaved edits', async () => {
    const sent = server(() => refused)
    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk' }) })

    await form.unpublish()
    expect([form.isDraft(), form.dirty()]).toEqual([false, false])
    form.drafts.set(form.entry, 'title', 'Edit')
    await form.unpublish()
    expect(sent).toHaveLength(1)
  })
})

describe('a scheduled entry', () => {
  test('is published now by dating it now, and keeps its date when the save is refused', async () => {
    const sent = server(() => ({ saved: true, version: 'v2' }))
    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk', at: ahead }) })

    expect(form.scheduled()).toBeDefined()
    await form.publishNow()
    expect(Date.parse(String(sent[0]!.body.data.at))).toBeLessThanOrEqual(Date.now())
    expect(form.scheduled()).toBeUndefined()

    server(() => refused)

    const refusedForm = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk', at: ahead }) })

    await refusedForm.publishNow()
    expect([refusedForm.drafts.value(refusedForm.entry, 'at'), refusedForm.dirty()]).toEqual([ahead, false])
  })

  test('is unscheduled by clearing its date', async () => {
    const sent = server(() => ({ saved: true, version: 'v2' }))
    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk', at: ahead }) })

    await form.unschedule()
    expect(sent[0]!.body.data).toEqual({ title: 'Talk' })
    expect([form.scheduled(), form.dirty()]).toEqual([undefined, false])
  })

  test('is left alone with unsaved edits', async () => {
    const sent = server(() => ({ saved: true }))
    const form = createEntryForm({ prefix: '/admin', collection: talks, entry: talk({ title: 'Talk', at: ahead }) })

    form.drafts.set(form.entry, 'title', 'Edit')
    await form.unschedule()
    await form.publishNow()
    expect(sent).toHaveLength(0)
  })
})

describe('the delete confirmation', () => {
  test('names the entry, and warns that the page of one that has a page goes', () => {
    expect(deleteMessage('My talk')).toBe('Delete My talk? This cannot be undone.')
    expect(deleteMessage('My talk', '/talks/my-talk')).toBe('Delete My talk? This cannot be undone. Its page /talks/my-talk stops answering, and links to it break.')
  })
})
