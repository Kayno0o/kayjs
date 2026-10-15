import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, setSystemTime, spyOn } from 'bun:test'

describe('pages fetched ahead of a click', () => {
  beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))
  afterAll(() => {
    setSystemTime()
    GlobalRegistrator.unregister()
  })

  it('are dropped once their time has passed, when another is fetched', async () => {
    const { prefetch } = await import('../src/runtime/page-swap')
    const { prefetched } = await import('../src/runtime/navigation')
    const fetched = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<p>x</p>', { headers: { 'content-type': 'text/html' } }))
    const link = document.createElement('a')

    try {
      prefetch(new URL('http://localhost/one'), link)
      prefetch(new URL('http://localhost/two'), link)
      expect([...prefetched.keys()]).toEqual(['http://localhost/one', 'http://localhost/two'])

      setSystemTime(new Date(Date.now() + 60_000))
      prefetch(new URL('http://localhost/three'), link)

      expect([...prefetched.keys()]).toEqual(['http://localhost/three'])
    }
    finally {
      fetched.mockRestore()
      prefetched.clear()
      setSystemTime()
    }
  })
})
