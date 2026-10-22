import type { Action, NoInputAction } from '../src/runtime'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

describe('kay/test on a project with a bare action', () => {
  it('calls an action declared without a schema with no input at all', async () => {
    const bare = await testSite({ root: 'tests/fixtures/bare' })
    const { ping } = await import(join(import.meta.dir, 'fixtures/bare/src/routes/survey.kay')) as { ping: NoInputAction<string> }

    // Any action passes where a form or a helper takes one of any input.
    const asAnyAction: Action<never, unknown> = ping

    expect(asAnyAction).toBe(ping)
    expect(await bare.call(ping)).toBe('pong')
    expect(await bare.call(ping, {})).toBe('pong')
    expect(await bare.call(ping, new FormData())).toBe('pong')
  })

  it('stops at a redirect to another site', async () => {
    const bare = await testSite({ root: 'tests/fixtures/bare' })
    const away = await bare.visit(`/?next=${encodeURIComponent('https://example.com/about')}`)

    expect(away).toMatchObject({ url: '/?next=https%3A%2F%2Fexample.com%2Fabout', status: 302 })
    expect(away.headers.get('location')).toBe('https://example.com/about')
  })
})
