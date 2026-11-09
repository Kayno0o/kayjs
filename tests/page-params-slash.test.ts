import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

describe('a page param holding an encoded slash', () => {
  it.each([
    ['production', {}, ''],
    ['dev', { dev: true }, ''],
    ['a base and trailing slash', { base: '/shop', trailingSlash: 'always' as const }, '/'],
  ])('reads %s decoded once', async (_name, options, slash) => {
    const site = await testSite({ root: 'tests/fixtures/routing', ...options })

    try {
      for (const [sent, read] of [['a%2Fb', 'a/b'], ['%2Fabout', '/about'], ['%252F', '%2F'], ['%2E%2E%2Fx', '../x']])
        expect(await (await site.fetch(`/n/${sent}${slash}`)).text()).toContain(`Odd ${read}`)
    }
    finally {
      await site.close()
    }
  })
})
