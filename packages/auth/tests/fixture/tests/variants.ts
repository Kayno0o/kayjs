import { join } from 'node:path'
import { testSite } from 'kay/test'

// Run in a process of its own, as the environment sets the pages' `home` and `remember` before the fixture's auth loads: prints what the pages show and where each flow lands.
const ROOT = join(import.meta.dir, '..')
const PAGES = join(ROOT, '..', '..', 'src', 'pages', 'routes')
const PASSWORD = 'correct horse battery'
// Where the pages are served: the fixture's kay.config.ts gives `authPages` a prefix through the environment, and its `createAuth` none.
const PAGES_AT = process.env.FIXTURE_PREFIX ?? '/auth'

const site = await testSite({ root: ROOT, ...process.env.FIXTURE_BASE && { base: process.env.FIXTURE_BASE } })
// After the site loads, so `authPages` hands the fixture's `createAuth` its prefix.
const { mails, store } = await import('../src/auth')

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

if (process.env.FIXTURE_RULES) {
  // The register page hints, constrains and words a refusal by the app's rules, not the defaults.
  const page = await site.visit(`${PAGES_AT}/register`)
  const refused = await site.submit(register, { email: 'rules@example.com', password: 'twelve chars!' }, { from: page })
  const short = await site.submit(register, { email: 'rules@example.com', password: 'only11chars' }, { from: await site.visit(`${PAGES_AT}/register`) })

  console.log(JSON.stringify({ hint: page.find('.kui-form-field-hint').map(hint => hint.text), minlength: page.find('input[name="password"]')[0]?.attributes.minlength, check: refused.find('.kui-form-field-issue').map(issue => issue.text), short: short.find('.kui-form-field-issue').map(issue => issue.text) }))
  process.exit(0)
}

if (process.env.FIXTURE_SWITCHES) {
  // A feature switched off leaves its form off the pages, and the pages that only serve it answer 404.
  const { magicLink } = await import(join(PAGES, 'sign-in.kay'))
  const signIn = await site.visit(`${PAGES_AT}/sign-in`)
  const out: Record<string, unknown> = {
    signIn: { password: signIn.find('input[name="password"]').length, magic: signIn.find('input[name="email"]').length, passkey: signIn.html.includes('Sign in with a passkey'), register: signIn.html.includes('Create one') },
    pages: Object.fromEntries(await Promise.all(['register', 'reset-password'].map(async path => [path, (await site.visit(`${PAGES_AT}/${path}`)).status]))),
  }

  if (!process.env.FIXTURE_SWITCHES.includes('password')) {
    await site.submit(register, { email: 'switches@example.com', password: PASSWORD }, { from: await site.visit(`${PAGES_AT}/register`) })

    const security = (await site.visit(`${PAGES_AT}/account/security`)).text() ?? ''

    out.security = { password: security.includes('Change the password') || security.includes('Set a password'), twoFactor: security.includes('Two-step verification'), passkeys: security.includes('Passkeys') }
  }

  if (process.env.FIXTURE_SWITCHES.includes('magicLink')) {
    await site.submit(magicLink, { email: 'switches@example.com' }, { from: await site.visit(`${PAGES_AT}/sign-in`) })

    out.mailed = mails.filter(mail => mail.kind === 'magic-link').length
  }

  console.log(JSON.stringify(out))
  process.exit(0)
}

if (process.env.FIXTURE_ADMIN) {
  // The admin pages and the impersonation banner link under the base and the prefix, to the pages' own routes.
  const { impersonate } = await import(join(PAGES, 'admin', 'users', '[id].kay'))
  const other = await testSite({ root: ROOT, ...process.env.FIXTURE_BASE && { base: process.env.FIXTURE_BASE } })

  await site.submit(register, { email: 'admin-base@example.com', password: PASSWORD }, { from: await site.visit(`${PAGES_AT}/register`) })
  await other.submit(register, { email: 'acted-base@example.com', password: PASSWORD }, { from: await other.visit(`${PAGES_AT}/register`) })

  const admin = (await store.users.findByEmail('admin-base@example.com'))!
  const acted = (await store.users.findByEmail('acted-base@example.com'))!

  await store.users.update(admin.id, { roles: ['admin'] })

  const list = await site.visit(`${PAGES_AT}/admin`)
  const auditPage = await site.visit(`${PAGES_AT}/admin/audit`)
  const detail = await site.visit(`${PAGES_AT}/admin/users/${acted.id}`)
  const refused = await other.visit(`${PAGES_AT}/admin`)
  const home = await site.submit(impersonate, {}, { from: detail })
  const acting = await site.visit(`${PAGES_AT}/admin`)
  const banner = await site.visit(`${PAGES_AT}/account`)

  const stopped = await site.fetch(banner.find('[data-impersonating] form')[0]!.attributes.action!, { method: 'POST', body: new URLSearchParams({ redirect: banner.find('[data-impersonating] input[name="redirect"]')[0]!.attributes.value! }) })

  console.log(JSON.stringify({
    stopped: [stopped.status, stopped.headers.get('location')],
    list: list.find('[data-user] a').map(link => link.attributes.href).filter(href => href?.endsWith(acted.id)),
    tabs: list.find('.kui-tab-nav a').map(link => link.attributes.href),
    search: list.find('form[role="search"]')[0]?.attributes.action,
    refused: refused.status,
    acting: { status: acting.status, banner: acting.find('[data-impersonating]').length, tabs: acting.find('.kui-tab-nav a').length },
    audit: auditPage.find('.kui-empty-state-title').map(title => title.text),
    home: home.url,
    banner: banner.find('[data-impersonating] form').map(form => form.attributes.action),
    back: banner.find('[data-impersonating] input[name="redirect"]').map(input => input.attributes.value),
  }))
  process.exit(0)
}

const out: Record<string, unknown> = { signIn: await shown(`${PAGES_AT}/sign-in`), register: await shown(`${PAGES_AT}/register`) }

// A newcomer lands where the page sends them, and a sign-in with the box left alone lasts what the setting says.
const newcomer = await site.visit(`${PAGES_AT}/register`)

out.registered = (await site.submit(register, { email: 'variant@example.com', password: PASSWORD }, { from: newcomer })).url
out.registeredLifetime = await lifetimeOf('variant@example.com')

const returning = await site.submit(password, { identifier: 'variant@example.com', password: PASSWORD, remember: 'on' }, { from: await site.visit(`${PAGES_AT}/sign-in`) })

out.signedIn = returning.url
out.checkedLifetime = await lifetimeOf('variant@example.com')

for (const [name, prefix] of [['en', ''], ['fr', '/fr']] as const) {
  const forgetful = await testSite({ root: ROOT, ...process.env.FIXTURE_BASE && { base: process.env.FIXTURE_BASE } })

  await forgetful.submit(request, { email: 'variant@example.com' }, { from: await forgetful.visit(`${prefix}${PAGES_AT}/reset-password`) })

  const link = linkOf('reset-password')
  const done = await forgetful.submit(reset, { token: link.searchParams.get('token')!, password: PASSWORD }, { from: await forgetful.visit(`${prefix}${PAGES_AT}/reset-password?token=${link.searchParams.get('token')}`) })

  out[`reset-${name}`] = done.url
}

console.log(JSON.stringify(out))
