import type { TestSite } from 'kay/test'
import { outbox } from '@kaynooo/kayjs-mail'
import { expect } from 'bun:test'
import { changeUsername, register, signOut, verify } from './pages'

// Joins on kayjs-auth's register page and names themselves on its profile page, signed in from then on, and confirms the address from the mail when asked.
export async function joinAs(site: TestSite, name: string, options: { confirmed?: boolean } = {}): Promise<string> {
  const email = `${name.toLowerCase()}@example.com`

  // The register page sends a member already signed in away.
  await signOut(site)
  expect((await site.submit(register, { email, password: 'correct horse battery' }, { from: await site.visit('/auth/register') })).url).toBe('/')
  expect((await site.submit(changeUsername, { username: name }, { from: '/auth/account' })).html).toContain('Your username is saved.')

  if (options.confirmed)
    expect((await site.submit(verify, { token: outbox.token(await outbox.waitFor(email, { site }), '/auth/verify-email') }, { from: '/auth/verify-email' })).url).toBe('/')

  return email
}
