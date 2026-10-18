import type { Mock } from 'bun:test'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { BUILD_HEADER } from '../src/runtime/swap'

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

// Each call is a chunk failing on its own, more than the seconds a confirmed build is believed after the last, which a page's earlier answer must not stand in for.
let now = Date.now()

async function probe(): Promise<boolean> {
  now += 6000

  return reloadIfStale()
}

// The page was rendered for build `aaa`; a response names the build the server runs.
function answer(build: string | undefined, status = 200, body = ''): Response {
  return new Response(body, { status, headers: build === undefined ? {} : { [BUILD_HEADER]: build } })
}

describe('a page noticing a deploy', () => {
  let reload: Mock<() => void>
  let fetched: Mock<typeof fetch>
  let clock: Mock<typeof Date.now>
  const environment = process.env.NODE_ENV

  beforeEach(() => {
    document.head.innerHTML = '<meta name="kay-build" content="aaa">'
    document.body.innerHTML = ''
    sessionStorage.clear()
    delete navigation.stale
    navigation.released = false
    process.env.NODE_ENV = 'production'
    reload = spyOn(location, 'reload').mockImplementation(() => undefined)
    fetched = spyOn(globalThis, 'fetch')
    now += 6000
    clock = spyOn(Date, 'now').mockImplementation(() => now)
  })

  afterEach(() => {
    process.env.NODE_ENV = environment ?? 'test'
    reload.mockRestore()
    fetched.mockRestore()
    clock.mockRestore()
  })

  it('reloads for an action the new build dropped, once, and keeps the next link a full load', async () => {
    fetched.mockResolvedValue(answer('bbb'))

    expect(await skew(answer('bbb', 404))).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(navigation.stale).toBe(true)
    expect(Number(sessionStorage.getItem('kay-reloaded'))).toBeGreaterThan(0)

    // The page the reload loaded still says it is the old one, as a cache in front of the server may keep it: no second reload.
    expect(await noticed(answer('bbb', 404))).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('only marks the page for an action that still answers, as the new build\'s pages are not this page\'s to swap in', async () => {
    fetched.mockResolvedValue(answer('bbb'))

    expect(await skew(answer('bbb', 200))).toBe(false)
    expect(await skew(answer('bbb', 422))).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(navigation.stale).toBe(true)
  })

  it('leaves an answer of its own build alone', async () => {
    expect(await noticed(answer('aaa', 404))).toBe(false)
    expect(await noticed(answer(undefined, 404))).toBe(false)
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

    expect(await Promise.all([probe(), probe(), probe()])).toEqual([true, true, true])
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reports the failure as it is when the server still runs this build, as a network that dropped does', async () => {
    fetched.mockResolvedValue(answer('aaa'))

    expect(await probe()).toBe(false)

    fetched.mockRejectedValue(new TypeError('offline'))

    expect(await probe()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(navigation.stale).toBeUndefined()
  })

  it('reads the build off the page of a static host, which names none in a header', async () => {
    fetched.mockResolvedValue(answer(undefined, 200, '<html><head><meta name="kay-build" content="bbb"></head></html>'))

    expect(await probe()).toBe(true)

    sessionStorage.clear()
    fetched.mockResolvedValue(answer(undefined, 200, '<html><head><meta name="kay-build" content="aaa"></head></html>'))

    expect(await probe()).toBe(false)

    fetched.mockResolvedValue(answer(undefined, 200, '<h1>A page with no build</h1>'))

    expect(await probe()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps what was typed: no reload while a field differs from its rendered value, the next link loading in full', async () => {
    document.body.innerHTML = '<form><input name="note" value="kept"><input type="checkbox" name="agree"></form>'
    fetched.mockResolvedValue(answer('bbb'))

    expect(await probe()).toBe(true)

    reload.mockClear()
    sessionStorage.clear()
    delete navigation.stale
    document.querySelector('input')!.value = 'typed'

    expect(await probe()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(navigation.stale as boolean | undefined).toBe(true)

    document.querySelector('input')!.value = 'kept'
    document.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked = true

    expect(await probe()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('keeps a page whose leave guard holds unsaved changes', async () => {
    const guard = { dirty: () => true }

    leaveGuards.add(guard)
    fetched.mockResolvedValue(answer('bbb'))

    try {
      expect(await probe()).toBe(false)
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
      expect(await probe()).toBe(false)
      expect(reload).not.toHaveBeenCalled()
    }
    finally {
      Object.defineProperty(window, 'sessionStorage', storage)
    }
  })

  it('reloads again a minute later, and not for another build within it, as replicas on two builds may alternate', async () => {
    fetched.mockResolvedValue(answer('bbb'))
    expect(await probe()).toBe(true)

    fetched.mockResolvedValue(answer('ccc'))
    expect(await probe()).toBe(false)

    sessionStorage.setItem('kay-reloaded', String(now - 61_000))
    expect(await probe()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('keeps a field the visitor changed outside any form, and a select left on its first option does not count', async () => {
    document.body.innerHTML = '<select name="kind"><option>a</option><option>b</option></select><select name="chosen"><option>a</option><option selected>b</option></select>'
    fetched.mockResolvedValue(answer('bbb'))

    expect(await probe()).toBe(true)

    reload.mockClear()
    sessionStorage.clear()
    document.body.innerHTML = '<input name="search" value="">'
    document.querySelector('input')!.value = 'typed'

    expect(await probe()).toBe(false)
    expect(reload).not.toHaveBeenCalled()

    sessionStorage.clear()
    document.body.innerHTML = '<select name="kind"><option>a</option><option>b</option></select>'
    document.querySelector('select')!.selectedIndex = 1

    expect(await probe()).toBe(false)
  })
})
