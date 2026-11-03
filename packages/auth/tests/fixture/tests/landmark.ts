import { join } from 'node:path'
import { testSite } from 'kay/test'

// Run in a process of its own by landmark.test.ts, as the fixture's auth reads FIXTURE_MAIN when it loads: prints how many `main` each prebuilt page holds.
const PAGES = ['sign-in', 'register', 'reset-password', 'two-factor', 'verify-email', 'confirm-email', 'oauth/authorize', 'account', 'account/security']
const MAIN = /<main[\s>]/g
const site = await testSite({ root: join(import.meta.dir, '..') })
const found: Record<string, number> = {}

for (const locale of ['', '/fr']) {
  for (const page of PAGES) {
    const response = await site.fetch(`${locale}/auth/${page}`)

    if (response.status === 200)
      found[`${locale}/auth/${page}`] = [...(await response.text()).matchAll(MAIN)].length
  }
}

console.log(JSON.stringify(found))
await site.close()
process.exit(0)
