import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { fileEvents, sessionEvents } from '../src/runtime/counters'
import { diskFiles, files, memoryFiles, memorySessions, session } from '../src/server'
import { answeringRequest } from '../src/server/log'
import { useAppOnError } from '../src/server/report'
import { setupStorage } from '../src/server/storage'
import { scratchDir } from './scratch'

const SECRET = 'a test secret that is long enough to seal'
const COOKIE_VALUE = /^kay_session=([^;]*)/

afterEach(() => {
  useAppOnError(undefined)
})

function sessions(options: Partial<Parameters<typeof session>[0]> = {}) {
  const app = new Elysia()
    .use(session<{ count: number }>({ secret: SECRET, ...options }))
    .get('/count', async ({ session }) => {
      await session.set('count', (await session.get('count') ?? 0) + 1)

      return 'ok'
    })
    .get('/peek', async ({ session }) => String(await session.get('count') ?? 'none'))
    .get('/clear', async ({ session }) => {
      await session.unset('count')

      return 'cleared'
    })
    .get('/out', async ({ session }) => {
      await session.destroy()

      return 'out'
    })
    .get('/again', async ({ session }) => {
      await session.destroy()
      await session.set('count', 1)

      return 'again'
    })
    .get('/rotate', async ({ session }) => {
      await session.regenerate()

      return 'rotated'
    })

  let cookie = ''

  return async (path: string, headers: Record<string, string> = {}) => {
    const request = new Request(`http://localhost${path}`, { headers: { cookie, ...headers } })
    const response = await answeringRequest(request, async () => app.handle(request))
    const set = response.headers.getSetCookie().find(header => header.startsWith('kay_session='))

    if (set !== undefined)
      cookie = Number((/Max-Age=(\d+)/i).exec(set)?.[1]) === 0 ? '' : `kay_session=${COOKIE_VALUE.exec(set)![1]}`

    return { text: await response.text(), status: response.status, set }
  }
}

describe('session onCreate and onDestroy', () => {
  it('tells onCreate once when a session first holds data, with its id and the request, and not for a visitor who stored nothing', async () => {
    const seen: unknown[] = []
    const get = sessions({ store: memorySessions(), onCreate: ({ id, context }) => void seen.push([typeof id, context.userAgent]) })

    await get('/peek')
    expect(seen).toEqual([])
    await get('/count', { 'user-agent': 'tester' })
    await get('/count')
    expect(seen).toEqual([['string', 'tester']])
  })

  it('tells onDestroy with the stored id when destroy() ends a session, and nothing when there was none', async () => {
    const created: unknown[] = []
    const destroyed: unknown[] = []
    const get = sessions({ store: memorySessions(), onCreate: ({ id }) => void created.push(id), onDestroy: ({ id }) => void destroyed.push(id) })

    await get('/out')
    expect(destroyed).toEqual([])
    await get('/count')
    await get('/out')
    expect(destroyed).toEqual([created[0]])
    await get('/out')
    expect(destroyed).toHaveLength(1)
  })

  it('tells onDestroy when the session is emptied, and both hooks when it is destroyed and started again in one request', async () => {
    const seen: string[] = []
    const get = sessions({ store: memorySessions(), onCreate: () => void seen.push('create'), onDestroy: () => void seen.push('destroy') })

    await get('/count')
    await get('/clear')
    await get('/count')
    await get('/again')
    expect(seen).toEqual(['create', 'destroy', 'create', 'destroy', 'create'])
  })

  it('treats regenerate() as the same session going on, and reports a session kept in the cookie with no id', async () => {
    const seen: unknown[] = []
    const get = sessions({ store: memorySessions(), onCreate: () => void seen.push('create'), onDestroy: () => void seen.push('destroy') })

    await get('/count')
    await get('/rotate')
    expect(seen).toEqual(['create'])

    const sealed: unknown[] = []
    const cookieOnly = sessions({ store: false, onCreate: ({ id }) => void sealed.push(id), onDestroy: ({ id }) => void sealed.push(id) })

    await cookieOnly('/count')
    await cookieOnly('/out')
    expect(sealed).toEqual([undefined, undefined])
  })

  it('does not tell onDestroy for a forged or expired cookie being cleared', async () => {
    const seen: string[] = []
    const get = sessions({ store: memorySessions(), onDestroy: () => void seen.push('destroy') })
    const app = new Elysia().use(session({ secret: SECRET, store: memorySessions(), onDestroy: () => void seen.push('destroy') })).get('/out', async ({ session }) => {
      await session.destroy()

      return 'out'
    })

    await get('/peek')
    await app.handle(new Request('http://localhost/out', { headers: { cookie: 'kay_session=forged' } }))
    expect(seen).toEqual([])
  })

  it('logs a throwing hook with its source, still answers, and keeps the session', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)
    const reported: (string | undefined)[] = []

    useAppOnError(({ source }) => void reported.push(source))

    try {
      const get = sessions({ store: memorySessions(), onCreate: () => {
        throw new Error('hook down')
      }, onDestroy: async () => {
        throw new Error('hook down')
      } })

      expect((await get('/count')).status).toBe(200)
      expect((await get('/peek')).text).toBe('1')
      expect((await get('/out')).status).toBe(200)
      expect(reported).toEqual(['session.onCreate', 'session.onDestroy'])
    }
    finally {
      logged.mockRestore()
      warned.mockRestore()
    }
  })

  it('counts sessions started and ended even with no hook', async () => {
    const before = { ...sessionEvents }
    const get = sessions({ store: memorySessions() })

    await get('/count')
    await get('/out')
    expect(sessionEvents).toEqual({ created: before.created + 1, destroyed: before.destroyed + 1 })
  })
})

describe('FileStore onWrite and onDelete', () => {
  it('tells onWrite with the key, size and privacy after files.put stored it, for every built-in store', async () => {
    const dir = await scratchDir('file-hooks-')

    for (const make of [(hooks: object) => memoryFiles(hooks), (hooks: object) => diskFiles(dir, hooks)]) {
      const seen: unknown[] = []
      const store = make({ onWrite: ({ key, size, private: isPrivate, context }: { key: string, size: number, private: boolean, context: object }) => void seen.push([key, size, isPrivate, typeof context]) })

      setupStorage(store, dir)

      const key = await files.put(new File(['hello'], 'a.txt'), { folder: 'notes' })
      const hidden = await files.put(new File(['abc'], 'b.txt'), { private: true })

      expect(seen).toEqual([[key, 5, false, 'object'], [hidden, 3, true, 'object']])
      expect(await store.read(key)).toBeDefined()
    }
  })

  it('tells onDelete only for a file that existed, and for the file a replace removes', async () => {
    const seen: string[] = []
    const store = memoryFiles({ onDelete: ({ key }: { key: string }) => void seen.push(key) })

    setupStorage(store, await scratchDir('file-hooks-'))

    const old = await files.put(new File(['one'], 'a.txt'))
    const next = await files.put(new File(['two'], 'a.txt'), { replace: old })

    expect(seen).toEqual([old])
    expect(await files.delete(next)).toBe(true)
    expect(await files.delete(next)).toBe(false)
    expect(seen).toEqual([old, next])
  })

  it('accepts the hooks on a store of the app\'s own, and a throwing hook is reported and never fails put or delete', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)
    const reported: (string | undefined)[] = []

    useAppOnError(({ source }) => void reported.push(source))

    try {
      const own = memoryFiles()

      setupStorage({ ...own, onWrite: () => {
        throw new Error('down')
      }, onDelete: async () => {
        throw new Error('down')
      } }, await scratchDir('file-hooks-'))

      const key = await files.put(new File(['x'], 'a.txt'))

      expect(await files.delete(key)).toBe(true)
      expect(reported).toEqual(['files.onWrite', 'files.onDelete'])
    }
    finally {
      logged.mockRestore()
      warned.mockRestore()
    }
  })

  it('counts writes and deletes', async () => {
    const before = { ...fileEvents }

    setupStorage(memoryFiles(), await scratchDir('file-hooks-'))
    await files.delete(await files.put(new File(['x'], 'a.txt')))
    expect(fileEvents).toEqual({ written: before.written + 1, deleted: before.deleted + 1 })
  })
})
