import { describe, expect, test } from 'bun:test'
import { resolveConfig } from '../src/config-resolve'
import { flatOptions } from '../src/server/app'
import { loggerOf } from '../src/server/log'

// A function that is its own, so the tests tell which one a key resolves to.
const hook = (): (() => void) => () => undefined
const quiet = hook()

describe('the flat hooks and the grouped log', () => {
  test('onListen and onError are the config\'s own keys', async () => {
    const onListen = hook()
    const onError = hook()
    const resolved = await resolveConfig({ onListen, onError })

    expect(resolved.onListen).toBe(onListen)
    expect(resolved.onError).toBe(onError)
  })

  test('the old onStart and observe.onError resolve to the new keys, the new ones winning', async () => {
    const onStart = hook()
    const onError = hook()
    const own = hook()
    const old = await resolveConfig({ onStart, observe: { onError } })

    expect(old.onListen).toBe(onStart)
    expect(old.onError).toBe(onError)
    expect(old.ops?.observe).toEqual({})
    expect((await resolveConfig({ onStart, onListen: own })).onListen).toBe(own)
  })

  test('observe.log as \'json\' or a function resolves to the group', async () => {
    expect((await resolveConfig({ observe: { log: 'json' } })).ops?.observe?.log).toEqual({ format: 'json' })
    expect((await resolveConfig({ observe: { log: quiet } })).ops?.observe?.log).toEqual({ sink: quiet })
  })

  test('loggerOf reads format, requests and sink', () => {
    expect(loggerOf(undefined, true)).toEqual({ writer: true, requests: true })
    expect(loggerOf(undefined, false)).toEqual({ writer: true, requests: false })
    expect(loggerOf(false, true)).toEqual({ writer: true, requests: false })
    expect(loggerOf({ format: 'json' }, false)).toEqual({ writer: 'json', requests: true })
    expect(loggerOf({ requests: false, sink: quiet }, true)).toEqual({ writer: quiet, requests: false })
  })
})

describe('pages and testSite options', () => {
  test('config lays its keys over the options, which keep root', () => {
    const flat = flatOptions({ root: '.', config: { site: 'https://a.test', trailingSlash: 'always' } })

    expect(flat as object).toEqual({ root: '.', site: 'https://a.test', trailingSlash: 'always' })
    expect(flatOptions({ root: '.', site: 'https://a.test', config: { site: 'https://b.test' } }).site).toBe('https://b.test')
    expect(flatOptions({ root: '.', site: 'https://a.test' })).toEqual({ root: '.', site: 'https://a.test' })
  })
})
