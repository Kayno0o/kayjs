import type { GuardContext } from 'kay'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as server from 'kay/server'
import { configure } from '../src/settings'

class Denied {
  constructor(readonly status: number, readonly message?: string) {}
}

void mock.module('kay/server', () => ({ ...server, editRequested: () => false, editedEntry: () => false }))
void mock.module('../src/store', () => ({
  collectionNamed: async (name: string) => ({ name, draftField: 'draft', publishField: 'publishAt', unpublishField: undefined }),
  heldDate: () => '9999-12-31T00:00:00.000Z',
  entryScreen: async () => ({ entry: { data: { title: 'Hello', draft: false, publishAt: '2026-01-01' } } }),
}))

const { default: devApi } = await import('../src/api/dev')
const { default: previewApi } = await import('../src/api/preview')
const { default: iconsApi } = await import('../src/api/icons')
const { default: apiGuard } = await import('../src/api/_guard')

const MOUNT = Symbol.for('kay.api')
const ANCHORS = { dev: devApi, preview: previewApi, icons: iconsApi }

// Mounts the cms's anchor modules under `root` as a site with that `apiPath` (and `base`) does; a module in `replaced` is the app's own, so it is not mounted.
function mountAt(root: string | undefined, replaced: (keyof typeof ANCHORS)[] = []): void {
  for (const [name, module] of Object.entries(ANCHORS)) {
    if (root === undefined || replaced.includes(name as keyof typeof ANCHORS))
      Reflect.deleteProperty(module, MOUNT)
    else
      Object.assign(module, { [MOUNT]: `${root}/${name}` })
  }
}

function ask(root: string, path: string, method = 'POST', roles: string[] = ['editor']): GuardContext {
  const url = new URL(`http://site.test${root}${path}`)

  return {
    request: new Request(url, { method }),
    url,
    cookies: new Bun.CookieMap(''),
    locals: { auth: {
      bareUser: async () => ({ roles }),
      isGranted: (role: string, who: { roles: string[] }) => who.roles.includes(role),
    } },
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

const RESTRICTED = [
  ['POST', '/entries/posts/a/publish'],
  ['POST', '/entries/posts/a/unpublish'],
  ['POST', '/entries/posts/a/share'],
  ['POST', '/entries/posts/a/rename'],
  ['DELETE', '/entries/posts/a'],
  ['POST', '/files/unused/delete'],
  ['POST', '/files/posts'],
  ['POST', '/files/media/rename'],
  ['POST', '/redirects'],
  ['POST', '/history/posts/a/restore'],
] as const

// Roles are listed for the actions a role may do; an `editor` holds none of them.
function useRoles(): void {
  configure({ guard: () => undefined, roles: { editor: [], publisher: ['publish'] } })
}

describe('the roles checks follow the cms\'s own mount', () => {
  afterEach(() => {
    mountAt(undefined)
  })

  // Every combination of an `apiPath`, a `base`, and which of the anchor modules the app replaced.
  const ROOTS = ['/api/cms', '/v1/cms', '/a/b/cms', '/site/api/cms', '/site/v1/cms']
  const REPLACED: (keyof typeof ANCHORS)[][] = [[], ['dev'], ['dev', 'preview'], ['preview', 'icons']]

  for (const root of ROOTS) {
    for (const replaced of REPLACED) {
      test(`${root} with ${replaced.join(', ') || 'no'} module replaced holds an editor back from publishing, deleting, uploading and the redirects`, async () => {
        useRoles()
        mountAt(root, replaced)

        for (const [method, path] of RESTRICTED) {
          if (path.endsWith('/restore'))
            continue

          expect(await statusOf(ask(root, path, method)), path).toBe(403)
        }

        expect(await statusOf(ask(root, '/entries/posts/a/publish', 'POST', ['publisher']))).toBe(200)
        expect(await statusOf(ask(root, '/entries/posts/a', 'POST'))).toBe(403)
      })
    }
  }

  test('a route spelled with doubled or trailing slashes under a moved apiPath is held to the same role', async () => {
    useRoles()
    mountAt('/v1/cms', ['dev'])

    for (const path of ['/entries/posts/a/publish/', '//entries/posts/a/publish', '/entries//posts/a/publish', '/redirects/', '/files//posts'])
      expect(await statusOf(ask('/v1/cms', path)), path).toBe(403)
  })

  test('a collection or slug named like the mount does not move the anchor', async () => {
    useRoles()
    mountAt('/v1/cms', ['dev'])

    expect(await statusOf(ask('/v1/cms', '/entries/cms/cms/publish'))).toBe(403)
  })

  test('the bare mount is placed, not refused as unplaced', async () => {
    useRoles()
    mountAt('/v1/cms', ['dev'])

    expect(await statusOf(ask('/v1/cms', '', 'GET'))).toBe(200)
    expect(await statusOf(ask('/v1/cms', '/', 'GET'))).toBe(200)
  })

  test('a path spelling the mount with an encoded or doubled segment is refused as unplaced, which the router would not route either', async () => {
    useRoles()
    mountAt('/v1/cms', ['dev'])

    for (const path of ['/v1/%63ms/entries/posts/a/publish', '/v1//cms/entries/posts/a/publish'])
      expect(await statusOf(ask('', path)), path).toBe(403)
  })

  test('with roles set and the mount unknown, every request is refused rather than let through', async () => {
    useRoles()
    mountAt(undefined)

    for (const [method, path] of RESTRICTED)
      expect(await statusOf(ask('/v1/cms', path, method)), path).toBe(403)

    expect(await statusOf(ask('/v1/cms', '/entries/posts/a'))).toBe(403)
  })

  test('with roles set and a request outside the mount the guard knows, the request is refused', async () => {
    useRoles()
    mountAt('/api/cms')

    expect(await statusOf(ask('/v1/cms', '/entries/posts/a/publish'))).toBe(403)
  })

  test('without roles the mount is not read, so a guard-admitted request passes', async () => {
    configure({ guard: () => undefined })
    mountAt(undefined)

    expect(await statusOf(ask('/v1/cms', '/entries/posts/a/publish'))).toBe(200)
  })
})
