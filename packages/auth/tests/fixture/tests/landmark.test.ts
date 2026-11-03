import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const PAGES = ['sign-in', 'register', 'reset-password', 'two-factor', 'verify-email', 'confirm-email', 'oauth/authorize', 'account', 'account/security']
const MAIN = /<main[\s>]/g

afterEach(() => {
  delete process.env.FIXTURE_MAIN
})

async function mains(wrapped: boolean) {
  if (wrapped)
    process.env.FIXTURE_MAIN = '1'

  const site = await testSite({ root: ROOT })

  try {
    const found: Record<string, number> = {}

    for (const locale of ['', '/fr']) {
      for (const page of PAGES) {
        const response = await site.fetch(`${locale}/auth/${page}`)

        if (response.status === 200)
          found[`${locale}/auth/${page}`] = [...(await response.text()).matchAll(MAIN)].length
      }
    }

    return found
  }
  finally {
    await site.close()
  }
}

describe('the prebuilt pages carry one main landmark', () => {
  test('on their own, in both locales', async () => {
    const found = await mains(false)

    expect(Object.keys(found).length).toBeGreaterThanOrEqual(6)
    expect(Object.values(found).every(count => count === 1)).toBe(true)
  })

  test('beneath an app layout that already writes a main, they add none', async () => {
    const found = await mains(true)

    expect(Object.keys(found).length).toBeGreaterThanOrEqual(6)
    expect(Object.values(found).every(count => count === 1)).toBe(true)
  })
})
