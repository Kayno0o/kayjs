import type { GuardContext } from 'kay'
import { describe, expect, mock, test } from 'bun:test'
import * as server from 'kay/server'
import { memberOf } from '../src/access'
import { actors } from '../src/authors'
import { passwordGuard, SESSION_COOKIE } from '../src/password'
import { configure } from '../src/settings'

class Denied {
  constructor(readonly status: number, readonly message?: string) {}
}

void mock.module('kay/server', () => ({ ...server, editRequested: () => false, editedEntry: () => false }))
void mock.module('../src/store', () => ({
  collectionNamed: async (name: string) => ({ name, draftField: 'draft', publishField: undefined, unpublishField: undefined }),
  heldDate: () => '9999-12-31T00:00:00.000Z',
  entryScreen: async () => ({ entry: { data: { title: 'Hello', draft: true } } }),
}))

const { default: devApi } = await import('../src/api/dev')

Object.assign(devApi, { [Symbol.for('kay.api')]: '/_kay/cms/dev' })

const { default: apiGuard } = await import('../src/api/_guard')

interface Org { id: string, slug: string, roles: string[], members: { user: { id: string }, roles: string[] }[] }

// A kayjs-auth user who belongs to organizations, as `ctx.locals.auth` shows them.
function authOf(id: string, siteRoles: string[], orgs: Org[]) {
  const mine = orgs.filter(org => org.members.some(member => member.user.id === id))
  const heldIn = (org: Org) => org.members.find(member => member.user.id === id)!.roles
  const hierarchy: Record<string, string[]> = { owner: ['owner', 'admin', 'reviewer', 'writer'], admin: ['admin', 'reviewer', 'writer'], reviewer: ['reviewer', 'writer'], writer: ['writer'] }

  return {
    bareUser: async () => ({ id, email: `${id}@site.test`, roles: siteRoles }),
    isGranted: (role: string, user: { roles: string[] }) => user.roles.includes(role),
    listOrganizations: async () => mine.map(org => ({ organization: { id: org.id, slug: org.slug }, roles: heldIn(org) })),
    isMember: async (ref: string, role?: string) => {
      const org = mine.find(item => item.id === ref || item.slug === ref)

      return org !== undefined && (role === undefined || heldIn(org).some(held => hierarchy[held]?.includes(role)))
    },
    listMembers: async (ref: string) => ({ ok: true as const, members: orgs.find(org => org.id === ref || org.slug === ref)!.members }),
  }
}

function ask(path: string, auth: unknown, cookie?: string): GuardContext {
  const url = new URL(`http://site.test/_kay/cms${path}`)
  const header = cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${cookie}` }

  return {
    request: new Request(url, { method: 'POST', headers: header }),
    url,
    cookies: new Bun.CookieMap(cookie === undefined ? '' : `${SESSION_COOKIE}=${cookie}`),
    locals: auth === undefined ? {} : { auth },
    deny: (status: number, message?: string) => {
      throw new Denied(status, message)
    },
  } as unknown as GuardContext
}

async function statusOf(ctx: GuardContext): Promise<number> {
  try {
    await apiGuard(ctx)

    return 200
  }
  catch (error) {
    if (error instanceof Denied)
      return error.status

    throw error
  }
}

const acme: Org = { id: 'o1', slug: 'acme', roles: [], members: [
  { user: { id: 'wanda' }, roles: ['writer'] },
  { user: { id: 'rex' }, roles: ['reviewer'] },
  { user: { id: 'olga' }, roles: ['owner'] },
  { user: { id: 'rita' }, roles: ['reviewer'] },
] }
const globex: Org = { id: 'o2', slug: 'globex', roles: [], members: [
  { user: { id: 'wanda' }, roles: ['writer'] },
  { user: { id: 'gus' }, roles: ['reviewer'] },
] }
const orgs = [acme, globex]

function organizations(roles: Record<string, ('publish' | 'review')[]>): void {
  configure({ guard: () => undefined, roles })
}

const APPROVE = '/entries/posts/hello/approve'
const SEND_BACK = '/entries/posts/hello/send-back'
const SUBMIT = '/entries/posts/hello/submit'

describe('organization roles', () => {
  test('a role written org:<role> is held through any organization of the person, its hierarchy counting', async () => {
    organizations({ 'org:reviewer': ['review'] })

    for (const [id, status] of [['rex', 200], ['olga', 200], ['wanda', 403]] as const) {
      expect(await statusOf(ask(APPROVE, authOf(id, [], orgs))), id).toBe(status)
      expect(await statusOf(ask(SEND_BACK, authOf(id, [], orgs))), id).toBe(status)
    }

    expect(await statusOf(ask(APPROVE, authOf('stranger', [], orgs)))).toBe(403)
  })

  test('org:<organization>:<role> is held in that organization alone, named by slug or id', async () => {
    organizations({ 'org:globex:reviewer': ['review'], 'org:o1:admin': ['publish'] })

    expect(await statusOf(ask(APPROVE, authOf('gus', [], orgs)))).toBe(200)
    expect(await statusOf(ask(APPROVE, authOf('rex', [], orgs)))).toBe(403)
    expect(await statusOf(ask('/entries/posts/hello/publish', authOf('olga', [], orgs)))).toBe(200)
    expect(await statusOf(ask('/entries/posts/hello/publish', authOf('rex', [], orgs)))).toBe(403)
  })

  test('a site role and an organization role add up, and the person is named with their id', async () => {
    organizations({ 'editor': ['publish'], 'org:reviewer': ['review'] })

    const auth = authOf('rex', ['editor'], orgs)
    const ctx = ask(APPROVE, auth)

    expect(await statusOf(ctx)).toBe(200)
    expect(await memberOf(ctx)).toMatchObject({ id: 'rex', held: ['editor', 'org:reviewer'] })
    expect(await statusOf(ask('/entries/posts/hello/publish', auth))).toBe(200)
  })

  test('nothing in the request names an organization role', async () => {
    organizations({ 'org:reviewer': ['review'] })

    const ctx = ask(APPROVE, authOf('wanda', ['org:reviewer'], orgs))

    expect(await statusOf(ctx)).toBe(403)
    expect(await statusOf(ask(APPROVE, undefined))).toBe(403)
  })
})

describe('submitting, approving and sending back', () => {
  test('any editor may submit, only a reviewer may approve or send back', async () => {
    organizations({ writer: [], reviewer: ['review'] })
    expect(await statusOf(ask(SUBMIT, authOf('wanda', ['writer'], orgs)))).toBe(200)
    expect(await statusOf(ask(APPROVE, authOf('wanda', ['writer'], orgs)))).toBe(403)
    expect(await statusOf(ask(SEND_BACK, authOf('wanda', ['writer'], orgs)))).toBe(403)
    expect(await statusOf(ask(APPROVE, authOf('rex', ['reviewer'], orgs)))).toBe(200)
    expect(await statusOf(ask(SUBMIT, authOf('wanda', [], orgs)))).toBe(200)
  })

  test('a reviewer without publish approves, and still cannot publish by the route', async () => {
    organizations({ reviewer: ['review'] })

    const rex = authOf('rex', ['reviewer'], orgs)

    expect(await statusOf(ask(APPROVE, rex))).toBe(200)
    expect(await statusOf(ask('/entries/posts/hello/publish', rex))).toBe(403)
  })

  test('the reviewers of a submission are the other holders of the reviewing organization roles, in the submitter\'s organizations', async () => {
    organizations({ 'org:reviewer': ['review'], 'org:globex:reviewer': ['review'] })

    const ctx = ask(SUBMIT, authOf('wanda', [], orgs))

    expect(await statusOf(ctx)).toBe(200)
    expect(actors.get(ctx.request)).toEqual({ name: 'wanda@site.test', id: 'wanda', reviewers: expect.arrayContaining(['rex', 'rita', 'gus']) })
    expect(actors.get(ctx.request)!.reviewers).toHaveLength(3)

    const alone = ask(SUBMIT, authOf('rex', [], orgs))

    await statusOf(alone)
    expect(actors.get(alone.request)!.reviewers).not.toContain('rex')
  })

  test('a reviewing site role is told to nobody, as kayjs-auth lists no one for it', async () => {
    organizations({ reviewer: ['review'] })

    const ctx = ask(SUBMIT, authOf('wanda', [], orgs))

    await statusOf(ctx)
    expect(actors.get(ctx.request)?.reviewers).toEqual([])
  })
})

describe('a password guard and a custom guard', () => {
  test('hold review through the role of the cookie', async () => {
    const guard = passwordGuard({ writer: 'pw-writer-1234', reviewer: 'pw-reviewer-1234' })
    const { activePasswords } = await import('../src/password')

    configure({ guard, roles: { writer: [], reviewer: ['review'] } })

    const writer = activePasswords()!.issue('writer', false).value
    const reviewer = activePasswords()!.issue('reviewer', false).value

    expect(await statusOf(ask(SUBMIT, undefined, writer))).toBe(200)
    expect(await statusOf(ask(APPROVE, undefined, writer))).toBe(403)
    expect(await statusOf(ask(SEND_BACK, undefined, writer))).toBe(403)
    expect(await statusOf(ask(APPROVE, undefined, reviewer))).toBe(200)

    const ctx = ask(SUBMIT, undefined, writer)

    await statusOf(ctx)
    expect(actors.get(ctx.request)).toEqual({ name: 'writer', id: undefined, reviewers: [] })
  })

  test('hold review through the roles member() reports, and an org: name there is a name like any other', async () => {
    configure({ guard: () => undefined, roles: { 'reviewer': ['review'], 'org:acme:reviewer': ['review'] }, member: ({ locals }) => (locals as { me?: { roles: string[] } }).me && { name: 'Ada', roles: (locals as { me: { roles: string[] } }).me.roles } })

    const as = (path: string, roles: string[]) => Object.assign(ask(path, undefined), { locals: { me: { roles } } }) as GuardContext

    expect(await statusOf(as(APPROVE, ['reviewer']))).toBe(200)
    expect(await statusOf(as(APPROVE, ['org:acme:reviewer']))).toBe(200)
    expect(await statusOf(as(APPROVE, ['writer']))).toBe(403)
    expect(await statusOf(as(SUBMIT, ['writer']))).toBe(200)
  })
})
