import type { DraftEntry } from '../src/kay/contract'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

// kayjs-ui's toasts alone, as its entry also loads icons only kay's build resolves.
const toastModule = join(dirname(Bun.resolveSync('@kaynooo/kayjs-ui/package.json', import.meta.dir)), 'src/toast.ts')
const { toasts } = await import(toastModule) as typeof import('../../ui/src/toast')

void mock.module('@kaynooo/kayjs-ui', async () => import(toastModule))

const { default: entriesApi } = await import('../src/api/entries')
const { default: filesApi } = await import('../src/api/files')
const { createDrafts } = await import('../src/drafts')
const { deleteSaved, deleteUnusedUploadsInChunks, saveDraft } = await import('../src/editor/save')

// What kay's build gives an API module's default export in the browser: where it is served.
Object.assign(entriesApi, { [Symbol.for('kay.api')]: '/api/cms/entries' })
Object.assign(filesApi, { [Symbol.for('kay.api')]: '/api/cms/files' })

const post: DraftEntry = { collection: 'posts', slug: 'hello', data: { title: 'Hello' } }

interface Sent { method: string, url: string, body: { data: Record<string, unknown>, version?: string, create?: boolean } }

// The entries API answering each save after `wait`, with `answer`, recording what was sent.
function server(answer: (body: Sent['body'], count: number) => unknown, wait = 20) {
  const sent: Sent[] = []

  spyOn(globalThis, 'fetch').mockImplementation((async (_input: string | URL | Request, init?: RequestInit) => {
    const body = (init?.body === undefined ? {} : JSON.parse(String(init.body))) as Sent['body']

    sent.push({ method: init?.method ?? 'GET', url: String(_input), body })
    await Bun.sleep(wait)

    return Response.json(answer(body, sent.length))
  }) as typeof fetch)

  return sent
}

function opened() {
  const drafts = createDrafts({ show: async () => ({}), delay: 1000 })

  drafts.open(post, 'v1')

  return drafts
}

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.()
  toasts.set([])
})

describe('saveDraft', () => {
  it('waits for a save on its way rather than sending the same version again, then saves the edits typed meanwhile once', async () => {
    const sent = server((body, count) => ({ saved: true, version: `v${count + 1}` }))
    const drafts = opened()

    drafts.set(post, 'title', 'First')

    const first = saveDraft(drafts, post)

    drafts.set(post, 'title', 'Second')

    const second = saveDraft(drafts, post)
    const third = saveDraft(drafts, post)

    expect(await Promise.all([first, second, third])).toEqual([true, true, true])
    expect(sent.map(({ body }) => [body.data.title, body.version])).toEqual([['First', 'v1'], ['Second', 'v2']])
    expect(drafts.changed(post)).toBe(false)
    expect(drafts.version(post)).toBe('v3')
  })

  it('sends a second click with no new edit nowhere', async () => {
    const sent = server(() => ({ saved: true, version: 'v2' }))
    const drafts = opened()

    drafts.set(post, 'title', 'Once')
    await Promise.all([saveDraft(drafts, post), saveDraft(drafts, post)])

    expect(sent).toHaveLength(1)
  })

  it('toasts and keeps a refusal of the whole entry, and the fields a schema refused as such', async () => {
    server(body => body.data.title === ''
      ? { issues: [{ collection: 'posts', slug: 'hello', path: 'title', message: 'Required' }] }
      : { issues: [{ collection: 'posts', slug: 'hello', path: '', message: 'This entry was saved since you opened it' }], conflict: { version: 'f00d' } }, 1)
    const drafts = opened()

    drafts.set(post, 'title', 'Mine')
    expect(await saveDraft(drafts, post)).toBe(false)
    expect(drafts.refusal(post)).toEqual({ message: 'This entry was saved since you opened it', conflict: { version: 'f00d' } })
    expect(toasts().map(toast => toast.message)).toEqual(['Not saved: This entry was saved since you opened it'])

    drafts.set(post, 'title', '')
    expect(await saveDraft(drafts, post)).toBe(false)
    expect(drafts.issues(post, 'title').map(issue => issue.message)).toEqual(['Required'])
    expect(toasts().at(-1)?.message).toBe('Not saved: some fields need fixing')
  })
})

describe('saveDraft targets', () => {
  it('saves the edits of a join under its own slug and locale rather than the running save\'s', async () => {
    const sent = server((_body, count) => ({ saved: true, version: `v${count + 1}` }))
    const drafts = opened()

    drafts.set(post, 'title', 'First')

    const first = saveDraft(drafts, post, { slug: 'a' })

    drafts.set(post, 'title', 'Second')

    const second = saveDraft(drafts, post, { slug: 'b', locale: 'fr' })

    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(sent.map(({ url, body }) => [url, body.data.title])).toEqual([['/api/cms/entries/posts/a', 'First'], ['/api/cms/entries/posts/b', 'Second']])
  })

  it('writes the edits kept over a deleted file as a new entry, so a file made meanwhile is not written over', async () => {
    const sent = server(() => ({ saved: true, version: 'v2' }))
    const drafts = opened()

    drafts.set(post, 'title', 'Mine')
    drafts.refuse(post, { message: 'saved since', conflict: { version: null } })
    drafts.keepEdits(post)

    expect(await saveDraft(drafts, post)).toBe(true)
    expect(sent.map(({ body }) => [body.create, body.version])).toEqual([[true, undefined]])

    drafts.set(post, 'title', 'Mine again')
    await saveDraft(drafts, post)
    expect(sent.map(({ body }) => [body.create, body.version])).toEqual([[true, undefined], [false, 'v2']])
  })
})

describe('deleteSaved', () => {
  it('names the version it is given, and reads none when it has none', async () => {
    const sent = server(() => ({ saved: true }))

    expect(await deleteSaved(post, 'v1')).toBe(true)
    expect(await deleteSaved(post)).toBe(true)
    expect(sent.map(({ method, url }) => [method, url])).toEqual([['DELETE', '/api/cms/entries/posts/hello?version=v1'], ['DELETE', '/api/cms/entries/posts/hello']])
  })
})

describe('deleting unused uploads', () => {
  function deleting(failOn?: number) {
    const sent: string[][] = []

    spyOn(globalThis, 'fetch').mockImplementation((async (_input: string | URL | Request, init?: RequestInit) => {
      const { keys } = JSON.parse(String(init?.body)) as { keys: string[] }

      sent.push(keys)

      return sent.length === failOn ? new Response('down', { status: 500 }) : Response.json({ deleted: keys, kept: [] })
    }) as typeof fetch)

    return sent
  }

  it('sends 250 keys as requests of 100, 100 and 50', async () => {
    const sent = deleting()

    expect(await deleteUnusedUploadsInChunks(Array.from({ length: 250 }, (_, index) => `k${index}`))).toBe(true)
    expect(sent.map(keys => keys.length)).toEqual([100, 100, 50])
  })

  it('stops at the first request that fails', async () => {
    const sent = deleting(2)

    expect(await deleteUnusedUploadsInChunks(Array.from({ length: 250 }, (_, index) => `k${index}`))).toBe(false)
    expect(sent.map(keys => keys.length)).toEqual([100, 100])
  })
})
