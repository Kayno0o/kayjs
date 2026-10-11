import { join } from 'node:path'
import { testSite } from 'kay/test'
import { auth, mails } from '../src/auth'

// Run in a process of its own, one process serving one project: a second site, guarded as the fixture is but replacing none of kayjs-auth's pages, spends a magic link through kayjs-auth's own page and prints each step's page.
const ROOT = join(import.meta.dir, '..', 'shipped')
const PAGES = join(ROOT, '..', '..', '..', 'src', 'pages', 'routes')

const browser = () => testSite({ root: ROOT, use: [auth.plugin] })

await browser()
const { magicLink } = await import(join(PAGES, 'sign-in.kay'))
const { register } = await import(join(PAGES, 'register.kay'))
const { spend } = await import(join(PAGES, 'magic-link.kay'))

const registered = await (await browser()).submit(register, { email: 'shipped@example.com', password: 'correct horse battery', redirect: '/auth/account' }, { from: '/auth/register' })
const visitor = await browser()

await visitor.submit(magicLink, { email: 'shipped@example.com', redirect: '/auth/account' }, { from: '/auth/sign-in' })

const link = new URL(mails.findLast(mail => mail.kind === 'magic-link')!.url!)
const opened = await visitor.visit(link.pathname + link.search)
const spent = await visitor.submit(spend, { token: link.searchParams.get('token')! }, { from: opened })

console.log(JSON.stringify({
  link: link.pathname + link.search,
  registered: { url: registered.url, status: registered.status },
  opened: { url: opened.url, status: opened.status, buttons: opened.find('button[type="submit"]').map(button => button.text) },
  spent: { url: spent.url, status: spent.status },
}))
