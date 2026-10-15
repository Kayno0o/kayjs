import type { SentMail } from '@kaynooo/kayjs-mail'
import type { TestSite } from 'kay/test'
import { outbox } from '@kaynooo/kayjs-mail'
import { expect } from 'bun:test'
import { changeUsername, register, signOut, verify } from './pages'

const TOKEN = /\?token=([\w-]+)/
const WAIT_MS = 2000

// Waits for the mail queue to deliver the mail `find` looks for, as the queues drain and the jobs they run enqueue more.
async function delivered(site: TestSite, find: () => SentMail | undefined): Promise<SentMail> {
  const started = Date.now()

  while (!find() && Date.now() - started < WAIT_MS) {
    await site.runJobs()
    await Bun.sleep(5)
  }

  const mail = find()

  expect(mail).toBeDefined()

  return mail!
}

// The token of the last link mailed to `to` that opens `path`. kayjs-auth queues some mails once the response is gone, so neither its answer nor its time tells whether the address is a member's: the jobs run until it shows.
export async function mailedToken(site: TestSite, to: string, path: string): Promise<string> {
  const mail = await delivered(site, () => outbox.to(to).findLast(each => each.text?.includes(`${path}?token=`)))

  return TOKEN.exec(mail.text!)![1]!
}

// Joins on kayjs-auth's register page and names themselves on its profile page, signed in from then on, and confirms the address from the mail when asked.
export async function joinAs(site: TestSite, name: string, options: { confirmed?: boolean } = {}): Promise<string> {
  const email = `${name.toLowerCase()}@example.com`

  // The register page sends a member already signed in away.
  await site.submit(signOut, {}, { from: '/auth/account' })
  expect((await site.submit(register, { email, password: 'correct horse battery' }, { from: await site.visit('/auth/register') })).url).toBe('/')
  expect((await site.submit(changeUsername, { username: name }, { from: '/auth/account' })).html).toContain('Your username is saved.')

  if (options.confirmed)
    expect((await site.submit(verify, { token: await mailedToken(site, email, '/auth/verify-email') }, { from: '/auth/verify-email' })).url).toBe('/')

  return email
}

// The first mail to `to` once the queues delivered it.
export async function mailTo(site: TestSite, to: string): Promise<SentMail> {
  return delivered(site, () => outbox.to(to)[0])
}
