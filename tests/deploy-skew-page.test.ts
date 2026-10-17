import type { Mock } from 'bun:test'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { BUILD_HEADER, buildOf } from '../src/runtime/swap'

let skew: typeof import('../src/runtime/build').skew
let navigation: typeof import('../src/runtime/navigation').navigation
let leaveGuards: typeof import('../src/runtime/navigation').leaveGuards
let noticed: typeof import('../src/runtime/stale').noticed
let reloadIfStale: typeof import('../src/runtime/stale').reloadIfStale

beforeAll(async () => {
  GlobalRegistrator.register()
  ;({ skew } = await import('../src/runtime/build'))
  ;({ navigation, leaveGuards } = await import('../src/runtime/navigation'))
  ;({ noticed, reloadIfStale } = await import('../src/runtime/stale'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('the build an entry chunk names', () => {
  it('is the hash in its file name, under any mount point and past a query', () => {
    expect(buildOf('/_kay/entry-e42sj0jp.js')).toBe('e42sj0jp')
    expect(buildOf('/repo/_kay/entry-e42sj0jp.js?v=1#x')).toBe('e42sj0jp')
    expect(buildOf('/_kay/runtime-9a8b7c.js')).toBe('9a8b7c')
  })

  it('is none for a file the build did not name, or for no entry', () => {
    expect(buildOf(undefined)).toBeUndefined()
    expect(buildOf('/_kay/dev/entry.js')).toBeUndefined()
    expect(buildOf('/app.js')).toBeUndefined()
  })
})

// The page loads the entry of build `aaa`; a response names the build the server runs.
function answer(build: string | undefined, status = 200, body = ''): Response {
  return new Response(body, { status, headers: build === undefined ? {} : { [BUILD_HEADER]: build } })
}

describe('a page noticing a deploy', () => {
  let reload: Mock<() => void>
  let fetched: Mock<typeof fetch>
  const environment = process.env.NODE_ENV

  beforeEach(() => {
    document.head.innerHTML = '<script type="text/plain" src="/_kay/entry-aaa.js"></script>'
    document.body.innerHTML = ''
    sessionStorage.clear()
    delete navigation.stale
    navigation.released = false
    process.env.NODE_ENV = 'production'
    reload = spyOn(location, 'reload').mockImplementation(() => undefined)
    fetched = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    process.env.NODE_ENV = environment ?? 'test'
    reload.mockRestore()
    fetched.mockRestore()
  })

  it('reloads for an action the new build dropped, once, and keeps the next link a full load', async () => {
    expect(await skew(answer('bbb', 404))).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(navigation.stale).toBe(true)
    expect(JSON.parse(sessionStorage.getItem('kay-reloaded')!)).toMatchObject({ build: 'bbb' })

    // The page the reload loaded still says it is the old one, as a cache in front of the server may keep it: no second reload.
    expect(noticed(answer('bbb', 404))).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('only marks the page for an action that still answers, as the new build\'s pages are not this page\'s to swap in', async () => {
    expect(await skew(answer('bbb', 200))).toBe(false)
    expect(await skew(answer('bbb', 422))).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(navigation.stale).toBe(true)
  })

  it('leaves an answer of its own build alone', () => {
    expect(noticed(answer('aaa', 404))).toBe(false)
    expect(noticed(answer(undefined, 404))).toBe(false)
    expect(navigation.stale).toBeUndefined()
  })

  it('does nothing outside production, where kay dev refreshes the page itself', async () => {
    process.env.NODE_ENV = 'development'

    expect(await skew(answer('bbb', 404))).toBe(false)
    expect(await skew()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(fetched).not.toHaveBeenCalled()
  })

  it('reloads for a chunk that failed to load when the server runs another build', async () => {
    fetched.mockResolvedValue(answer('bbb', 200, '<h1>New</h1>'))

    expect(await skew()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('asks the server once for chunks of one page failing together', async () => {
    fetched.mockResolvedValue(answer('bbb'))

    expect(await Promise.all([reloadIfStale(), reloadIfStale(), reloadIfStale()])).toEqual([true, true, true])
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reports the failure as it is when the server still runs this build, as a network that dropped does', async () => {
    fetched.mockResolvedValue(answer('aaa'))

    expect(await reloadIfStale()).toBe(false)

    fetched.mockRejectedValue(new TypeError('offline'))

    expect(await reloadIfStale()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(navigation.stale).toBeUndefined()
  })

  it('reads the build off the page of a static host, which names none in a header', async () => {
    fetched.mockResolvedValue(answer(undefined, 200, '<html><head><script type="module" src="/repo/_kay/entry-bbb.js"></script></head></html>'))

    expect(await reloadIfStale()).toBe(true)

    sessionStorage.clear()
    fetched.mockResolvedValue(answer(undefined, 200, '<html><head><script type="module" src="/repo/_kay/entry-aaa.js"></script></head></html>'))

    expect(await reloadIfStale()).toBe(false)

    fetched.mockResolvedValue(answer(undefined, 200, '<h1>A page with no script</h1>'))

    expect(await reloadIfStale()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps what was typed: no reload while a field differs from its rendered value, the next link loading in full', async () => {
    document.body.innerHTML = '<form><input name="note" value="kept"><input type="checkbox" name="agree"></form>'
    fetched.mockResolvedValue(answer('bbb'))

    expect(await reloadIfStale()).toBe(true)

    reload.mockClear()
    sessionStorage.clear()
    delete navigation.stale
    document.querySelector('input')!.value = 'typed'

    expect(await reloadIfStale()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(navigation.stale as boolean | undefined).toBe(true)

    document.querySelector('input')!.value = 'kept'
    document.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked = true

    expect(await reloadIfStale()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('keeps a page whose leave guard holds unsaved changes', async () => {
    const guard = { dirty: () => true }

    leaveGuards.add(guard)
    fetched.mockResolvedValue(answer('bbb'))

    try {
      expect(await reloadIfStale()).toBe(false)
      expect(reload).not.toHaveBeenCalled()
      expect(navigation.stale).toBe(true)
    }
    finally {
      leaveGuards.delete(guard)
    }
  })

  it('does not reload where it cannot remember having done so', async () => {
    fetched.mockResolvedValue(answer('bbb'))

    const storage = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('blocked')
      },
    })

    try {
      expect(await reloadIfStale()).toBe(false)
      expect(reload).not.toHaveBeenCalled()
    }
    finally {
      Object.defineProperty(window, 'sessionStorage', storage)
    }
  })

  it('reloads again for a build after that, and again for the same one a minute later', async () => {
    fetched.mockResolvedValue(answer('bbb'))
    expect(await reloadIfStale()).toBe(true)

    fetched.mockResolvedValue(answer('ccc'))
    expect(await reloadIfStale()).toBe(true)

    sessionStorage.setItem('kay-reloaded', JSON.stringify({ build: 'ccc', at: Date.now() - 61_000 }))
    expect(await reloadIfStale()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(3)
  })
})
