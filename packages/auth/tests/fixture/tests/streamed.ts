import { join } from 'node:path'
import { testSite } from 'kay/test'

// Run in a process of its own with FIXTURE_NO_VIEWER set: prints what the components show when the user streams in after the page.
const ROOT = join(import.meta.dir, '..')
const PAGES = join(ROOT, '..', '..', 'src', 'pages', 'routes')
const PASSWORD = 'correct horse battery'

const site = await testSite({ root: ROOT })
const { register } = await import(join(PAGES, 'register.kay'))
const text = (page: Awaited<ReturnType<typeof site.visit>>, selector: string) => page.find(selector)[0]?.text

const before = await site.visit('/nested')

await site.submit(register, { email: 'streamed@example.com', password: PASSWORD }, { from: await site.visit('/auth/register') })

const after = await site.visit('/nested')
const account = await site.visit('/auth/account')

const raw = await site.fetch('/nested')

console.log(JSON.stringify({
  cache: raw.headers.get('cache-control'),
  vary: raw.headers.get('vary'),
  anonymous: before.find('#member, form').length,
  member: text(after, '#member'),
  name: text(after, '.kayjs-auth span'),
  signOut: after.find('.kayjs-auth form button').map(button => button.text),
  accountSignOut: account.find('.kayjs-auth form button').map(button => button.text),
}))
process.exit(0)
