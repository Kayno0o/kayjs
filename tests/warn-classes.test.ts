import type { ClientBuild } from '../src/server/client'
import type { Route } from '../src/server/routes'
import { describe, expect, it } from 'bun:test'
import { warnServerClasses } from '../src/build/warn-classes'
import { logSink, setLogSink } from '../src/runtime/log'

const route = (pattern: string, file: string, params: string[]): Route => ({ pattern, file, params, layouts: [], special: {}, guards: [] })

function warnedOf(client: Partial<ClientBuild>, routes: Route[], exported = false): string[] {
  const warned: string[] = []
  const previous = logSink()

  setLogSink((level, message) => void (level === 'warn' && warned.push(message)))

  try {
    warnServerClasses('/app', client as ClientBuild, routes, exported)
  }
  finally {
    if (previous)
      setLogSink(previous)
    else
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('kay.log')]
  }

  return warned
}

const unresolved = (file: string) => ({ file, line: 3, how: 'class attribute', part: '', expression: 'tone', client: false, by: [file] })

describe('the classes a server builds from data, on pages rendered per request', () => {
  const live = route('/item/:slug', '/app/item.kay', ['slug'])
  const listed = route('/post/:slug', '/app/post.kay', ['slug'])
  const pages = new Map([['/post/a', { pattern: '/post/:slug' }]]) as unknown as ClientBuild['pages']

  it('tells of a route with params in a server build, prerendered for some values or not', () => {
    expect(warnedOf({ pages, unresolved: [unresolved('/app/item.kay')] }, [live, listed])).toHaveLength(1)
    expect(warnedOf({ pages, unresolved: [unresolved('/app/post.kay')] }, [live, listed])).toHaveLength(1)
  })

  it('tells of none in a static export, which renders nothing per request', () => {
    expect(warnedOf({ pages, unresolved: [unresolved('/app/item.kay')] }, [live, listed], true)).toEqual([])
  })
})
