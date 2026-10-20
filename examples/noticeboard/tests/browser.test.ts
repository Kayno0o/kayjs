import { describe, expect, it } from 'bun:test'
import { browserPath, testSite } from 'kay/test'
import { auth } from '../src/auth'
import { post } from '../src/routes/index.kay'

const site = await testSite({ browser: true })

// CI installs Chromium; elsewhere the suite runs where one is found.
describe.skipIf(browserPath() === undefined)('in a browser', () => {
  it('pins a notice from the dialog, and shows another member\'s at once with a toast, the live island kept', async () => {
    // The browser signs in as Ada; the test site, which keeps cookies of its own, stays Grace.
    await auth.signInAs(site, { email: 'ada@example.com', username: 'Ada', password: 'correct horse battery' })
    await auth.signInAs(site, { email: 'grace@example.com', username: 'Grace' })

    const page = await site.open('/auth/sign-in')

    await page.fill('input[name="identifier"]', 'ada')
    await page.fill('input[name="password"]', 'correct horse battery')
    await page.click('main form button[type="submit"]')
    await page.waitFor('main p[aria-live]', { text: 'Reading now: Ada' })

    await page.click('#pin-notice')
    await page.fill('dialog input[name="title"]', 'Bake sale')
    await page.fill('dialog textarea[name="body"]', 'Saturday at ten.')
    await page.click('dialog button[type="submit"]')
    await page.waitFor('.kui-toast-message', { text: 'Pinned' })
    await page.waitFor('.kui-card-title', { text: 'Bake sale' })

    await page.evaluate(() => {
      document.querySelector('main p[aria-live]')!.setAttribute('data-before', '')
    })
    await site.call(post, { title: 'Lost keys', body: 'Found by the door.' })
    await page.waitFor('.kui-toast-message', { text: 'Grace pinned "Lost keys"' })
    await page.waitFor('.kui-card-title', { text: 'Lost keys' })
    // Rendered afresh around the island, whose props did not change: the same element, its connection and what it heard kept.
    expect(await page.count('main p[aria-live][data-before]')).toBe(1)
    expect(await page.text('main p[aria-live]')).toBe('Reading now: Ada')
    expect(page.errors).toEqual([])
  }, 30_000)
})
