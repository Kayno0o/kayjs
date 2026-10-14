import type { DraftEntry } from '../src/kay/contract'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

// kayjs-ui's toasts alone, as its entry also loads icons only kay's build resolves.
const toastModule = join(dirname(Bun.resolveSync('@kaynooo/kayjs-ui/package.json', import.meta.dir)), 'src/toast.ts')
const { toasts } = await import(toastModule) as typeof import('../../ui/src/toast')

void mock.module('@kaynooo/kayjs-ui', async () => import(toastModule))

const { default: entriesApi } = await import('../src/api/entries')
const { createDrafts } = await import('../src/drafts')
const { saveDraft } = await import('../src/editor/save')

// What kay's build gives an API module's default export in the browser: where it is served.
Object.assign(entriesApi, { [Symbol.for('kay.api')]: '/api/cms/entries' })

const post: DraftEntry = { collection: 'posts', slug: 'hello', data: { title: 'Hello' } }

interface Sent { method: string, body: { data: Record<string, unknown>, version?: string } }

// The entries API answering each save after `wait`, with `answer`, recording what was sent.
function server(answer: (body: Sent['body'], count: number) => unknown, wait = 20) {
  const sent: Sent[] = []

  spyOn(globalThis, 'fetch').mockImplementation((async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Sent['body']

    sent.push({ method: init?.method ?? 'GET', body })
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
