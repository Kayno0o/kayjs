import type { LiveRequest } from '../src/runtime/live-value'
import type { TestSite } from '../src/test'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { liveId } from '../src/build/live-ids'
import { nameUser } from '../src/server/request-user'
import { testSite } from '../src/test'
import { Feed, JSON_POST, pagesOf, proofsOf } from './live-helpers'

const ROOT = 'tests/fixtures/live-user'
const UNREAD = liveId('/app/src/live.ts', '/app', 'unread')
const VISITORS = liveId('/app/src/live.ts', '/app', 'visitors')

type Values = typeof import('./fixtures/live-user/src/live')

// Names the visitor from a header, as kayjs-auth names the signed-in user of a request.
const signedIn = new Elysia().derive({ as: 'global' }, ({ request }) => {
  nameUser(request, () => request.headers.get('x-user') ?? undefined)

  return {}
})

async function quiet(feed: Feed): Promise<boolean> {
  const nothing = Symbol('nothing')
  const wait = async () => {
    await Bun.sleep(150)

    return nothing
  }

  return await Promise.race([feed.next(), wait()]) === nothing
}

describe('a live value of each user', () => {
  let site: TestSite
  let live: Values

  const as = (user: string | undefined): Record<string, string> => user === undefined ? {} : { 'x-user': user }
  const visit = async (path: string, user?: string) => (await site.visit(path, { headers: as(user) })).html
  const open = async (proofs: LiveRequest['proofs'], user: string | undefined, watch: LiveRequest['watch'] = [[UNREAD, '']]) => site.fetch('/_kay/live', { ...JSON_POST, headers: { ...JSON_POST.headers, ...as(user) }, body: JSON.stringify({ proofs, watch } satisfies LiveRequest) })

  beforeAll(async () => {
    site = await testSite({ root: ROOT, use: [signedIn] })
    live = await import(resolve(ROOT, 'src/live.ts')) as Values
    live.unread.set('alice', 3)
    live.unread.set('bob', 5)
  })

  afterAll(async () => {
    live.unread.delete('alice')
    live.unread.delete('bob')
    await site.close()
  })

  it('renders the visitor\'s own value, and what the declaration gives for nobody', async () => {
    expect(await visit('/', 'alice')).toContain('<p class="unread"><!--[-->3<!--]--> unread</p>')
    expect(await visit('/', 'bob')).toContain('<p class="unread"><!--[-->5<!--]--> unread</p>')
    expect(await visit('/', 'carol')).toContain('<!--[-->0<!--]--> unread')
    expect(await visit('/')).toContain('<!--[-->0<!--]--> unread')
  })

  it('writes the page\'s value under no key and the user into the proof, never into the page', async () => {
    const html = await visit('/', 'alice')
    const [page, ...others] = pagesOf(html)

    expect(others).toEqual([])
    expect(page!.values).toEqual([[UNREAD, '', 3]])
    expect(page!.sig).toMatch(/\|alice$/)
    expect(html).not.toContain('bob')
    expect(html).not.toContain('5<!--]--> unread')
  })

  it('follows nothing for a visitor nobody signed in', async () => {
    const html = await visit('/')

    expect(html).not.toContain('data-kay-live')
  })

  it('sends a user their own value, then each change of it, and nothing of another user\'s', async () => {
    const proofs = proofsOf(pagesOf(await visit('/', 'alice')))
    const feed = new Feed(await open(proofs, 'alice'))

    expect(await feed.next()).toEqual([[UNREAD, '', 3]])
    // Bob's change comes first: were it sent, it would be the next event.
    live.unread.set('bob', 6)
    live.unread.set('alice', 4)
    expect(await feed.next()).toEqual([[UNREAD, '', 4]])
    expect(await quiet(feed)).toBe(true)
    live.unread.set('alice', 3)
    live.unread.set('bob', 5)
    await feed.close()
  })

  it('refuses the proof of another user\'s page, a user written into the proof, and a key naming a user', async () => {
    const alice = proofsOf(pagesOf(await visit('/', 'alice')))
    const bob = proofsOf(pagesOf(await visit('/', 'bob')))

    // Alice's proof from bob's request, and bob's from alice's.
    expect((await open(alice, 'bob')).status).toBe(403)
    expect((await open(bob, 'alice')).status).toBe(403)
    // Alice's proof with the user changed to bob, from bob's request.
    expect((await open([{ ...alice[0]!, sig: alice[0]!.sig.replace(/\|alice$/, '|bob') }], 'bob')).status).toBe(403)
    // The user dropped from the signature, or a proof of nobody's.
    expect((await open([{ ...alice[0]!, sig: alice[0]!.sig.replace(/\|alice$/, '') }], 'alice')).status).toBe(403)
    // A key naming bob under alice's proof.
    expect((await open(alice, 'alice', [[UNREAD, 'bob']])).status).toBe(403)
    expect((await open(alice, 'alice', [[UNREAD, 'bob'], [UNREAD, '']])).status).toBe(403)
    // A user in the request alone, without a proof.
    expect((await open([], 'bob')).status).toBe(403)
  })

  it('refuses the proof once the visitor signed out, or another user signed in', async () => {
    const alice = proofsOf(pagesOf(await visit('/', 'alice')))

    expect((await open(alice, undefined)).status).toBe(403)
    expect((await open(alice, 'bob')).status).toBe(403)
    expect((await open(alice, 'alice')).status).toBe(200)
  })

  it('binds a page mixing a global value and a user\'s to the user, whose request alone follows both', async () => {
    live.visitors.set(2)

    const proofs = proofsOf(pagesOf(await visit('/mixed', 'alice')))
    const feed = new Feed(await open(proofs, 'alice', [[UNREAD, ''], [VISITORS, '']]))

    expect((await feed.next()).map(update => update.join()).toSorted()).toEqual([`${UNREAD},,3`, `${VISITORS},,2`].toSorted())
    await feed.close()
    expect((await open(proofs, 'bob', [[UNREAD, ''], [VISITORS, '']])).status).toBe(403)
  })

  it('puts a user\'s value back to what the declaration gives, telling its watchers', async () => {
    live.unread.set('carol', 8)

    const feed = new Feed(await open(proofsOf(pagesOf(await visit('/', 'carol'))), 'carol'))

    expect(await feed.next()).toEqual([[UNREAD, '', 8]])
    live.unread.delete('carol')
    expect(await feed.next()).toEqual([[UNREAD, '', 0]])
    await feed.close()
  })
})
