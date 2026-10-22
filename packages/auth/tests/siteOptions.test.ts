import type { Mail } from '../src/mail'
import { afterEach, describe, expect, test } from 'bun:test'
import { setSite } from '../../../src/runtime/site'
import { testApp } from './helpers/app'

const LINKS = { 'verify-email': '/v', 'reset-password': '/r', 'magic-link': '/m', 'change-email': '/c' }

// The mail a registration sends, from an app given these options.
async function registered(options: Parameters<typeof testApp>[0]): Promise<Mail> {
  const mails: Mail[] = []
  const app = testApp({ email: { mailer: { send: mail => void mails.push(mail) }, links: LINKS }, ...options })

  await app.browser().call('register', { email: 'ada@example.com', password: 'correct horse battery' })

  return mails.at(-1)!
}

afterEach(() => {
  setSite(undefined)
})

describe('site and name', () => {
  test('site is the origin the mailed links start from and name the display name', async () => {
    const mail = await registered({ site: 'https://site.test', name: 'Example' })

    expect(mail.url).toStartWith('https://site.test/v?token=')
    expect(mail).toMatchObject({ name: 'Example', site: 'Example', subject: 'Confirm your email for Example' })
  })

  test('the name is the origin\'s host when left out', async () => {
    expect(await registered({ site: 'https://site.test' })).toMatchObject({ name: 'site.test' })
  })

  test('the origin is the site kay serves when left out', async () => {
    setSite('https://served.test', 'never')

    const mail = await registered({ name: 'Example' })

    expect(mail.url).toStartWith('https://served.test/v?token=')
  })

  test('the site of createAuth wins over the site kay serves', async () => {
    setSite('https://served.test', 'never')

    expect((await registered({ site: 'https://own.test' })).url).toStartWith('https://own.test/v?token=')
  })

  test('the old forms, url for the origin and a site that is a name, still work', async () => {
    const mail = await registered({ url: 'https://site.test', site: 'Example' })

    expect(mail.url).toStartWith('https://site.test/v?token=')
    expect(mail).toMatchObject({ name: 'Example', subject: 'Confirm your email for Example' })
  })

  test('a site that looks like a host but has no scheme is refused, pointing at name', () => {
    expect(() => testApp({ site: 'example.com' })).toThrow('has no scheme')
    expect(() => testApp({ site: 'localhost:3000' })).toThrow('https://localhost:3000')
  })

  test('a site that is a plain name is still a name', async () => {
    expect(await registered({ url: 'https://site.test', site: 'My site' })).toMatchObject({ name: 'My site' })
  })

  test('a mail with no origin anywhere is refused with the option to set', () => {
    expect(() => testApp({ email: { mailer: { send: () => undefined }, links: LINKS } })).toThrow('set `site` in kay.config.ts or SITE_URL')
  })
})
