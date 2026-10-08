import type { TestSite } from 'kay/test'
import { outbox } from '@kaynooo/kayjs-mail'
import { expect } from 'bun:test'
import { join } from '../src/routes/register.kay'
import { confirm } from '../src/routes/verify.kay'

const TOKEN = /\?token=([\w-]+)/
const WAIT_MS = 2000

// The token of the last link mailed to `to` that opens `path`. kayjs-auth queues some mails once the response is gone, so neither its answer nor its time tells whether the address is a member's: the jobs run until it shows.
export async function mailedToken(site: TestSite, to: string, path: string): Promise<string> {
  const started = Date.now()
  const find = () => outbox.to(to).findLast(each => each.text?.includes(`${path}?token=`))

  while (!find() && Date.now() - started < WAIT_MS) {
    await site.runJobs()
    await Bun.sleep(5)
  }

  const mail = find()

  expect(mail).toBeDefined()

  return TOKEN.exec(mail!.text!)![1]!
}

// Joins as `name`, signed in from then on, and confirms the address from the mail when asked.
export async function joinAs(site: TestSite, name: string, options: { confirmed?: boolean } = {}): Promise<string> {
  const email = `${name.toLowerCase()}@example.com`

  expect((await site.submit(join, { username: name, email, password: 'correct horse battery' }, { from: '/register' })).url).toBe('/')

  if (options.confirmed)
    expect((await site.submit(confirm, { token: await mailedToken(site, email, '/verify') }, { from: '/verify' })).url).toBe('/')

  return email
}
