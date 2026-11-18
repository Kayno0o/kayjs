import { describe, expect, test } from 'bun:test'
import { mergeConfig, withConfig } from '../src/config-loader'
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

  test('the old onStart and observe are refused, naming the new keys', () => {
    expect(() => mergeConfig({}, { onStart: hook() } as never)).toThrow('`onStart`, now `onListen`')
    expect(() => mergeConfig({}, { observe: { log: 'json' } } as never)).toThrow('`observe`, now `ops.observe`')
  })

  test('an old nested key given in code is refused, not dropped', async () => {
    await expect(withConfig('tests/fixtures/static', { mcp: { key: 'secret' } } as never)).rejects.toThrow('`mcp.key`, moved to `mcp.token`')
    await expect(withConfig('tests/fixtures/static', { serve: { apiPrefix: '/v1' } } as never)).rejects.toThrow('`serve.apiPrefix`, moved to `endpoints.api`')
  })

  test('observe.log takes a format or a sink', async () => {
    expect((await resolveConfig({ ops: { observe: { log: { format: 'json' } } } })).ops?.observe?.log).toEqual({ format: 'json' })
    expect((await resolveConfig({ ops: { observe: { log: { sink: quiet } } } })).ops?.observe?.log).toEqual({ sink: quiet })
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
    expect(flatOptions({ root: '.' })).toEqual({ root: '.' })
    expect(() => flatOptions({ root: '.', site: 'https://a.test' } as never)).toThrow('config keys beside `root`')
  })
})
