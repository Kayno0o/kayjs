import { afterEach, expect, mock, spyOn, test } from 'bun:test'

// What kay's build gives an API module's default export in the browser: where it is served.
void mock.module('../src/api/referrers', () => ({ default: { [Symbol.for('kay.api')]: '/api/cms/referrers' } }))

const { readReferrers } = await import('../src/editor/referrers')

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.()
})

test('asks the referrers API for the slugs when called, and tells none for a failed read', async () => {
  const urls: string[] = []

  spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
    urls.push(String(input))

    return Response.json({ ada: ['Posts: One'] })
  }) as unknown as typeof fetch)

  expect(await readReferrers('people', ['ada'])).toEqual({ ada: ['Posts: One'] })
  expect(urls).toHaveLength(1)
  expect(decodeURIComponent(urls[0]!)).toContain('/api/cms/referrers/people?slugs=["ada"]')
  expect(await readReferrers('people', [])).toEqual({})

  spyOn(globalThis, 'fetch').mockRestore()
  spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ error: 'down' }, { status: 500 })) as unknown as typeof fetch)

  expect(await readReferrers('people', ['ada'])).toEqual({})
})
