import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { withBase, withoutBase } from '../src/runtime/base'
import { skew } from '../src/runtime/build'
import { consent } from '../src/runtime/consent'
import { hold, wanted } from '../src/runtime/live-value'
import { presence } from '../src/runtime/presence'
import { setServerScope } from '../src/runtime/reactive'

// The browser build defines `KAY_BROWSER` and the bundler drops what only the server runs; here the same test reads the global, so both branches run under test.
describe('the server branches of the runtime, on a server', () => {
  it('reads the request\'s cookie for the consent, and cannot set it', () => {
    expect(typeof document).toBe('undefined')
    expect(consent()).toBe('')
    setServerScope(() => ({ values: new WeakMap(), cookie: () => 'yes', param: () => undefined, report: () => undefined, path: '/repo/lobby/' }))
    expect(consent()).toBe('yes')
    expect(presence().count()).toBe(0)
    setServerScope(() => undefined)
    expect(() => consent.set('yes')).toThrow('answers from the browser')
  })

  it('names no room of its own and holds no connection open', () => {
    expect(() => presence()).toThrow('presence() with no room')
    expect(presence('lobby').count()).toBe(0)
    expect(hold.tab).toBeUndefined()
  })

  it('does not reload a deploy it cannot see', async () => {
    const before = process.env.NODE_ENV

    process.env.NODE_ENV = 'production'
    expect(await skew()).toBe(false)
    process.env.NODE_ENV = before ?? 'test'
  })

  it('leaves paths as the server wrote them', () => {
    expect(withBase('/about')).toBe('/about')
    expect(withoutBase('/repo/about')).toBe('/repo/about')
  })
})

describe('the same branches in a browser build, KAY_BROWSER defined', () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: 'http://localhost/repo/lobby/' })
    ;(globalThis as { KAY_BROWSER?: true }).KAY_BROWSER = true
    document.head.innerHTML = '<meta name="kay-base" content="/repo">'
  })

  afterAll(async () => {
    delete (globalThis as { KAY_BROWSER?: true }).KAY_BROWSER
    await GlobalRegistrator.unregister()
  })

  it('reads the mount point of the page', () => {
    expect(withBase('/about')).toBe('/repo/about')
    expect(withoutBase('/repo/about')).toBe('/about')
  })

  it('answers the consent from the cookie and follows what is set', () => {
    document.cookie = 'kay_analytics=no'
    expect(consent()).toBe('no')
    consent.set('yes')
    expect(consent()).toBe('yes')
  })

  it('names the page\'s room without its mount point and holds the connection open', () => {
    const own = presence()

    expect(own.count()).toBe(0)
    expect([...wanted.keys()]).toEqual([])
    expect(hold.tab).toMatch(/^[0-9a-f]{24}$/)
  })
})

describe('the browser bundle', () => {
  it.each([['consent', 'answers from the browser'], ['presence', 'currentServerScope'], ['seo', 'reads site in kay.config.ts']])('leaves the server branch of %s out', async (name, server) => {
    const unguarded = await Bun.build({ entrypoints: [join(import.meta.dir, `../src/runtime/${name}.ts`)], target: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })
    const browser = await Bun.build({ entrypoints: [join(import.meta.dir, `../src/runtime/${name}.ts`)], target: 'browser', minify: true, define: { 'KAY_BROWSER': 'true', 'process.env.NODE_ENV': '"production"' } })

    expect(await unguarded.outputs[0]!.text()).toContain(server)
    expect(await browser.outputs[0]!.text()).not.toContain(server)
  })
})
