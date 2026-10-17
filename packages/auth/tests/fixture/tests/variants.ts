import { join } from 'node:path'
import { testSite } from 'kay/test'
import { mails, store } from '../src/auth'

// Run in a process of its own, as the environment sets the pages' `home` and `remember` before the fixture's auth loads: prints what the pages show and where each flow lands.
const ROOT = join(import.meta.dir, '..')
const PAGES = join(ROOT, '..', '..', 'src', 'pages', 'routes')
const PASSWORD = 'correct horse battery'

const site = await testSite({ root: ROOT, ...process.env.FIXTURE_BASE && { base: process.env.FIXTURE_BASE } })

const { password } = await import(join(PAGES, 'sign-in.kay'))
const { register } = await import(join(PAGES, 'register.kay'))
const { request, reset } = await import(join(PAGES, 'reset-password.kay'))

async function shown(path: string) {
  const page = await site.visit(path)

  return { boxes: page.find('input[name="remember"]').length, links: page.find('a[data-provider]').map(link => link.attributes.href) }
}

async function lifetimeOf(email: string): Promise<number | null> {
  const user = await store.users.findByEmail(email)
  const sessions = await store.sessions.listByUser(user!.id)

  return sessions.toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!.maxAge
}

const linkOf = (kind: string) => new URL(mails.findLast(mail => mail.kind === kind)!.url!)

const out: Record<string, unknown> = { signIn: await shown('/auth/sign-in'), register: await shown('/auth/register') }

// A newcomer lands where the page sends them, and a sign-in with the box left alone lasts what the setting says.
const newcomer = await site.visit('/auth/register')

out.registered = (await site.submit(register, { email: 'variant@example.com', password: PASSWORD }, { from: newcomer })).url
out.registeredLifetime = await lifetimeOf('variant@example.com')

const returning = await site.submit(password, { identifier: 'variant@example.com', password: PASSWORD, remember: 'on' }, { from: await site.visit('/auth/sign-in') })

out.signedIn = returning.url
out.checkedLifetime = await lifetimeOf('variant@example.com')

for (const [name, prefix] of [['en', ''], ['fr', '/fr']] as const) {
  const forgetful = await testSite({ root: ROOT, ...process.env.FIXTURE_BASE && { base: process.env.FIXTURE_BASE } })

  await forgetful.submit(request, { email: 'variant@example.com' }, { from: await forgetful.visit(`${prefix}/auth/reset-password`) })

  const link = linkOf('reset-password')
  const done = await forgetful.submit(reset, { token: link.searchParams.get('token')!, password: PASSWORD }, { from: await forgetful.visit(`${prefix}/auth/reset-password?token=${link.searchParams.get('token')}`) })

  out[`reset-${name}`] = done.url
}

console.log(JSON.stringify(out))
