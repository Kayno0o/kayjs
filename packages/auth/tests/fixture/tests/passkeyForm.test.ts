import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { browserPath, testSite } from 'kay/test'
import { totpCode, totpStep } from '../../../src/totp'

// The security page's passkey form is an island, rendered only once the browser proves it can make a passkey, so its labels reach the browser as props.
const ROOT = join(import.meta.dir, '..')
const PASSWORD = 'correct horse battery'
const RAW_KEY = /\bauth\.[a-z]+(?:\.[a-zA-Z]+)+\b/

const site = await testSite({ root: ROOT, browser: { path: browserPath() }, onError: () => undefined })

afterAll(async () => site.close())

async function register(email: string) {
  const page = await site.open('/auth/register?redirect=%2Fauth%2Faccount%2Fsecurity')

  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', PASSWORD)
  await page.click('form button[type="submit"]')
  await page.waitUntil(() => location.pathname === '/auth/account/security')

  return page
}

function passkeyField(page: Awaited<ReturnType<typeof register>>) {
  return page.evaluate(() => {
    const form = [...document.querySelectorAll('form')].find(candidate => candidate.querySelector('input[name="name"]') && !candidate.querySelector('input[name="id"]'))

    return form === undefined ? null : [...form.querySelectorAll('label')].map(label => label.textContent)
  })
}

test('the passkey form labels its proof field with the password', async () => {
  const page = await register('passkey-form@example.com')

  await page.waitFor('form input[name="password"][autocomplete="current-password"]')

  const labels = await passkeyField(page)

  expect(labels).not.toBeNull()
  expect(labels!.join(' ')).not.toMatch(RAW_KEY)
  expect(page.errors).toEqual([])
}, 60_000)

test('the passkey form labels its proof field with the authenticator code once two-factor is on', async () => {
  const page = await register('passkey-form-totp@example.com')

  await page.fill('form[action$="/setUp"] input[name="password"]', PASSWORD)
  await page.click('form[action$="/setUp"] button')
  await page.waitFor('#kayjs-auth-key')

  const secret = (await page.text('#kayjs-auth-key'))!

  await page.fill('form[action$="/enable"] input[name="code"]', await totpCode(secret, totpStep()))
  await page.click('form[action$="/enable"] button')
  await page.waitFor('#kayjs-auth-recovery-codes')
  await page.goto('/auth/account/security')
  await page.waitFor('input[name="code"][autocomplete="one-time-code"]')

  const labels = await passkeyField(page)

  expect(labels).not.toBeNull()
  expect(labels!.join(' ')).toContain('Code from your authenticator app')
  expect(labels!.join(' ')).not.toMatch(RAW_KEY)
}, 60_000)
