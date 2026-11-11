import type { GuardContext } from 'kay'
import { beforeEach, expect, mock, test } from 'bun:test'
import { Elysia } from 'elysia'
import * as server from 'kay/server'
import { configure } from '../src/settings'

class Denied {
  constructor(readonly status: number) {}
}

const text = { type: 'string' }
const pointsAtPeople = { 'type': 'string', 'x-kay': { kind: 'reference', collection: 'people' } }
const people = { name: 'people', kind: 'folder', localized: false, components: [], schema: { properties: { name: text } } }
const posts = { name: 'posts', kind: 'folder', localized: false, components: [], title: 'Posts', schema: { properties: { title: text, author: pointsAtPeople } } }
const secrets = { name: 'secrets', kind: 'folder', localized: false, components: [], title: 'Secrets', schema: { properties: { title: text, who: pointsAtPeople } } }

const held: Record<string, { slug: string, data: Record<string, unknown> }[]> = {
  posts: [{ slug: 'one', data: { title: 'One', author: 'ada' } }],
  secrets: [{ slug: 'plan', data: { title: 'The plan', who: 'ada' } }],
}

const content = await import('../src/kay/content')
const store = await import('../src/store')

void mock.module('kay/server', () => ({ ...server, editRequested: () => false, editedEntry: () => false }))
void mock.module('../src/kay/content', () => ({
  ...content,
  collections: async () => [people, posts, secrets],
  entries: async (name: string) => held[name] ?? [],
}))
void mock.module('../src/store', () => ({
  ...store,
  collectionNamed: async (name: string) => ({ name }),
  heldDate: () => '9999-12-31T00:00:00.000Z',
  entryScreen: async () => undefined,
}))

const { default: devApi } = await import('../src/api/dev')

Object.assign(devApi, { [Symbol.for('kay.api')]: '/_kay/cms/dev' })

const { default: apiGuard } = await import('../src/api/_guard')
const { default: referrersApi } = await import('../src/api/referrers')

const user = { id: 'u1', roles: ['blogger'] }

beforeEach(() => {
  configure({ guard: () => undefined, roles: { blogger: { collections: ['people', 'posts'], actions: [] } } })
})

async function referrersOfAda(): Promise<Record<string, string[]>> {
  const url = new URL(`http://site.test/_kay/cms/referrers/people?slugs=${encodeURIComponent('["ada"]')}`)
  const request = new Request(url)
  const ctx = {
    request,
    url,
    cookies: new Bun.CookieMap(''),
    locals: { auth: { bareUser: async () => user, isGranted: (role: string, who: { roles: string[] }) => who.roles.includes(role) } },
    deny: (status: number) => {
      throw new Denied(status)
    },
  } as unknown as GuardContext

  await apiGuard(ctx)

  return await (await new Elysia({ prefix: '/_kay/cms/referrers' }).use(referrersApi).handle(request)).json() as Record<string, string[]>
}

test('names the referrers in the collections the role reaches, and not those of another', async () => {
  expect(await referrersOfAda()).toEqual({ ada: ['Posts: One'] })
})
