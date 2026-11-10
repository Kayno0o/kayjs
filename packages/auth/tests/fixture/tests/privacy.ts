import { join } from 'node:path'
import { testSite } from 'kay/test'

// Run in a process of its own by privacy.test.ts, as the fixture's auth reads FIXTURE_PRIVACY when it loads: prints what each locale's register page says under the form.
const site = await testSite({ root: join(import.meta.dir, '..') })
const out: Record<string, unknown> = {}

for (const [name, prefix] of [['en', ''], ['fr', '/fr']] as const) {
  const page = await site.visit(`${prefix}/auth/register`)
  const notice = page.find('form p.text-xs')[0]

  out[name] = { notice: notice?.text.replace(/\s+/g, ' ').trim() ?? null, links: page.find('form p.text-xs a').map(link => [link.text, link.attributes.href, link.attributes.rel]) }
}

console.log(JSON.stringify(out))
await site.close()
process.exit(0)
