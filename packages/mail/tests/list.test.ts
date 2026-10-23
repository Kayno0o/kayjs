import type { Action } from 'kay'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { scratchDir, testSite } from 'kay/test'
import { CONFIRMS_PER_HOUR, createLists } from '../src/list'
import { normalizeAddress } from '../src/list-address'
import { openLists } from '../src/list-store'
import { checkToken, signToken } from '../src/list-token'
import { mailer } from '../src/mailer'
import { outbox } from '../src/outbox'

interface Subscribe { email: string, wording?: string }

const { subscribe, subscribeStrict, subscribeCounted, subscribeFlood } = await import(`${import.meta.dir}/fixture/src/routes/subscribe.kay`) as Record<'subscribe' | 'subscribeStrict' | 'subscribeCounted' | 'subscribeFlood', Action<Subscribe, unknown>>
const { subscribeNoticed } = await import(`${import.meta.dir}/fixture/src/routes/notice.kay`) as Record<'subscribeNoticed', Action<Subscribe, unknown>>
const { rendered } = await import(`${import.meta.dir}/fixture/src/counter`) as typeof import('./fixture/src/counter')
const { mail } = await import(`${import.meta.dir}/fixture/src/mail`) as typeof import('./fixture/src/mail')

const site = await testSite({ root: 'tests/fixture' })
const ONE_CLICK = 'List-Unsubscribe=One-Click'
let counter = 0

function fresh(): string {
  return `reader${++counter}-${Math.random().toString(36).slice(2, 8)}@example.com`
}

async function confirmationOf(email: string) {
  return outbox.waitFor(email, { site, find: sent => sent.subject.startsWith('Confirm') })
}

function tokenOf(sent: Parameters<typeof outbox.token>[0], part: string): string {
  return outbox.token(sent, part)
}

const confirmLink = (token: string) => `/_kay/mail/list/confirm?token=${token}`
const confirmPost = async (path: string) => site.fetch(path, { method: 'POST' })

async function subscribed(email = fresh()): Promise<{ email: string, confirm: string }> {
  await site.call(subscribe, { email })

  const confirm = tokenOf(await confirmationOf(email), '/confirm')

  expect((await confirmPost(confirmLink(confirm))).status).toBe(200)

  return { email, confirm }
}

describe('normalizeAddress', () => {
  it('keeps one form of an address: trimmed, in lower case, its domain in punycode', () => {
    expect(normalizeAddress('  Ada@Example.COM ')).toBe('ada@example.com')
    expect(normalizeAddress('ada+news@example.com')).toBe('ada+news@example.com')
    expect(normalizeAddress('ada@bücher.example')).toBe('ada@xn--bcher-kva.example')
    expect(normalizeAddress('é@example.com')).toBe('é@example.com')
  })

  it('refuses anything that is not one plain address', () => {
    for (const bad of ['', 'ada', 'ada@', '@example.com', 'a@b@example.com', 'ada@example', 'ada@192.168.0.1', 'ada@example.com\nBcc: x@y.test', 'a,b@example.com', 'Ada <ada@example.com>', '"ada"@example.com', 'ada @example.com', 'ada@exa mple.com', 'ada@example.com/path', '.ada@example.com', 'a..da@example.com', 'ada@-example.com', `${'a'.repeat(65)}@example.com`, `ada@${'a'.repeat(250)}.com`, 'ada@exa\u0000mple.com'])
      expect(normalizeAddress(bad)).toBeUndefined()

    expect(normalizeAddress(42)).toBeUndefined()
    expect(normalizeAddress(undefined)).toBeUndefined()
  })
})

describe('list tokens', () => {
  const claims = { list: 'default', id: 'abc', locale: 'fr' }

  it('carries the claims of the purpose it was signed for', () => {
    expect(checkToken('confirm', signToken('confirm', claims))).toEqual({ ok: true, claims })
    expect(checkToken('unsubscribe', signToken('unsubscribe', claims))).toEqual({ ok: true, claims })
  })

  it('refuses a token signed for the other purpose, forged, truncated or made of anything else', () => {
    const confirm = signToken('confirm', claims)
    const [payload, signature] = confirm.split('.') as [string, string]
    const forged = Buffer.from(JSON.stringify({ p: 'confirm', l: 'default', i: 'other', e: Date.now() + 1e9 })).toString('base64url')

    expect(checkToken('unsubscribe', confirm)).toEqual({ ok: false, reason: 'invalid' })
    expect(checkToken('confirm', `${forged}.${signature}`)).toEqual({ ok: false, reason: 'invalid' })
    expect(checkToken('confirm', `${payload}.${signature.slice(0, -2)}`)).toEqual({ ok: false, reason: 'invalid' })
    expect(checkToken('confirm', payload)).toEqual({ ok: false, reason: 'invalid' })

    for (const other of ['', '.', 'a.b.c', 'x'.repeat(5000), undefined, null, 5, ['a'], { token: 'a' }])
      expect(checkToken('confirm', other)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('needs the app secret in production, and signs with it', () => {
    const mode = process.env.NODE_ENV
    const secret = process.env.KAY_SECRET

    try {
      process.env.NODE_ENV = 'production'
      delete process.env.KAY_SECRET
      expect(() => signToken('unsubscribe', claims)).toThrow('KAY_SECRET')
      expect(checkToken('unsubscribe', 'abc.def')).toEqual({ ok: false, reason: 'invalid' })

      process.env.KAY_SECRET = 'a'.repeat(40)

      const token = signToken('unsubscribe', claims)

      expect(checkToken('unsubscribe', token).ok).toBe(true)

      process.env.KAY_SECRET = 'b'.repeat(40)
      expect(checkToken('unsubscribe', token)).toEqual({ ok: false, reason: 'invalid' })
    }
    finally {
      process.env.NODE_ENV = mode ?? 'test'

      if (secret === undefined)
        delete process.env.KAY_SECRET
      else
        process.env.KAY_SECRET = secret
    }
  })

  it('expires a confirmation after three days and never an unsubscribe link', () => {
    const past = Date.now() - 4 * 24 * 3_600_000

    expect(checkToken('confirm', signToken('confirm', claims, past))).toEqual({ ok: false, reason: 'expired' })
    expect(checkToken('unsubscribe', signToken('unsubscribe', claims, past)).ok).toBe(true)
  })
})

describe('the subscribe form', () => {
  it('lists the address only once the link of the confirmation mail is opened', async () => {
    const email = fresh()
    const before = (await mail.list().subscribers()).length

    await site.call(subscribe, { email })

    const sent = await confirmationOf(email)

    expect(sent.subject).toMatch(/^Confirm your subscription to \S+$/)
    expect(sent.headers['List-Unsubscribe']).toBeUndefined()
    expect((await mail.list().subscribers()).length).toBe(before)

    expect((await confirmPost(outbox.link(sent, '/confirm').replace('https://fixture.test', ''))).status).toBe(200)
    expect((await mail.list().subscribers()).map(row => row.email)).toContain(email)
  })

  it('stores one subscriber for an address written in another case', async () => {
    const email = fresh()
    const before = await mail.list().count()

    await site.call(subscribe, { email: email.toUpperCase() })
    await site.call(subscribe, { email })

    const token = tokenOf(await confirmationOf(email), '/confirm')

    await confirmPost(confirmLink(token))
    expect(await mail.list().count()).toBe(before + 1)
    expect((await mail.list().subscribers()).filter(row => row.email === email)).toHaveLength(1)
  })

  it('answers the same for a new, a pending and a confirmed address, mailing the confirmed one nothing', async () => {
    const pending = fresh()
    const answers = [await site.call(subscribe, { email: fresh() }), await site.call(subscribe, { email: pending }), await site.call(subscribe, { email: pending })]
    const { email } = await subscribed()
    const count = outbox.to(email).length

    answers.push(await site.call(subscribe, { email }))
    await site.runJobs()

    expect(new Set(answers.map(answer => JSON.stringify(answer))).size).toBe(1)
    expect(outbox.to(email)).toHaveLength(count)
    expect(outbox.to(pending)).toHaveLength(2)
  })

  it('mails an address at most three times an hour and answers the same after', async () => {
    const email = fresh()
    const answers = []

    for (let post = 0; post < 5; post++)
      answers.push(await site.call(subscribe, { email }))

    await site.runJobs()

    expect(new Set(answers.map(answer => JSON.stringify(answer))).size).toBe(1)
    expect(outbox.to(email)).toHaveLength(3)
  })

  it('sends a list\'s confirmation mails at most a fixed number an hour, whoever asks, and answers the same after', async () => {
    const emails = Array.from({ length: CONFIRMS_PER_HOUR + 2 }, () => fresh())
    const answers = []

    for (const email of emails)
      answers.push(await site.call(subscribeFlood, { email }))

    await site.runJobs()

    expect(new Set(answers.map(answer => JSON.stringify(answer))).size).toBe(1)
    expect(emails.filter(email => outbox.to(email).length > 0)).toHaveLength(CONFIRMS_PER_HOUR)
    expect(outbox.to(emails.at(-1)!)).toHaveLength(0)
  })

  it('refuses a post past the limit of its address, the same whatever the address is', async () => {
    const [first, second] = [fresh(), fresh()]

    await site.call(subscribeStrict, { email: first })
    await site.call(subscribeStrict, { email: second })

    const refused = await site.refusal(subscribeStrict, { email: fresh() })

    expect(refused.status).toBe(429)
    expect((await site.refusal(subscribeStrict, { email: first })).status).toBe(429)
    expect(refused.errors['']).toBe('Too many attempts from here in a short time: try again in a few minutes.')
  })

  it('refuses an address that is not one with the field\'s message, and mails nothing', async () => {
    await site.runJobs()

    const before = outbox.mails.length
    const refused = await site.refusal(subscribe, { email: 'nope' })

    expect(refused.errors.email).toBe('Please write a valid email address.')
    expect((await site.refusal(subscribe, { email: 'a@b.test,c@d.test' })).status).toBe(422)

    await site.runJobs()
    expect(outbox.mails).toHaveLength(before)
  })

  it('takes the same steps for a listed address as for a new one, mailing only the new one', async () => {
    const email = fresh()
    const before = rendered.count

    expect(await site.call(subscribeCounted, { email })).toBeUndefined()
    expect(rendered.count).toBe(before + 1)

    const confirm = tokenOf(await outbox.waitFor(email, { site, find: sent => sent.subject.startsWith('Confirm') }), '/confirm')

    await confirmPost(confirmLink(confirm))

    const mails = outbox.to(email).length

    expect(await site.call(subscribeCounted, { email })).toBeUndefined()
    await site.runJobs()
    expect(rendered.count).toBe(before + 2)
    expect(outbox.to(email)).toHaveLength(mails)
  })

  it('renders the honeypot', async () => {
    expect((await site.visit('/subscribe')).html).toContain('name="website"')
  })

  it('pretends to subscribe a bot that fills the honeypot, and mails nobody', async () => {
    const email = fresh()
    const sent = outbox.mails.length

    const fields = new FormData()

    fields.append('email', email)
    fields.append('website', 'https://spam.example')

    expect(await site.call(subscribe, fields as never)).toBeUndefined()
    await site.runJobs()

    expect(outbox.mails).toHaveLength(sent)
    expect(outbox.to(email)).toHaveLength(0)
  })
})

describe('the confirmation link', () => {
  const page = async (token: string) => (await confirmPost(confirmLink(token))).text()

  it('does not list the address on a GET, which a link scanner makes, and asks first', async () => {
    const email = fresh()

    await site.call(subscribe, { email })

    const token = tokenOf(await confirmationOf(email), '/confirm')
    const before = await mail.list().count()
    const response = await site.fetch(confirmLink(token))
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('method="post"')
    expect(body).not.toContain('Subscription confirmed')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await mail.list().count()).toBe(before)
    expect((await mail.list().subscribers()).map(row => row.email)).not.toContain(email)

    expect(await (await confirmPost(confirmLink(token))).text()).toContain('Subscription confirmed')
    expect((await mail.list().subscribers()).map(row => row.email)).toContain(email)
  })

  it('answers a forged or expired link on a GET with the page that does not work, without a form', async () => {
    const expired = signToken('confirm', { list: 'default', id: 'nobody' }, Date.now() - 4 * 24 * 3_600_000)
    const pages = await Promise.all([expired, 'nonsense', ''].map(async token => (await site.fetch(confirmLink(token))).text()))

    for (const body of pages) {
      expect(body).toContain('This link does not work')
      expect(body).not.toContain('<form')
    }
  })

  it('answers a second click like the first, adding nobody', async () => {
    const { email, confirm } = await subscribed()
    const count = await mail.list().count()

    expect(await page(confirm)).toContain('Subscription confirmed')
    expect(await mail.list().count()).toBe(count)
    expect((await mail.list().subscribers()).filter(row => row.email === email)).toHaveLength(1)
  })

  it('answers a forged, expired, unknown or truncated link with one page that names nobody', async () => {
    const { confirm } = await subscribed()
    const unknown = signToken('confirm', { list: 'default', id: 'nobody' })
    const expired = signToken('confirm', { list: 'default', id: 'nobody' }, Date.now() - 4 * 24 * 3_600_000)
    const wrongPurpose = signToken('unsubscribe', { list: 'default', id: 'nobody' })
    const pages = await Promise.all([page(unknown), page(expired), page(wrongPurpose), page(`${confirm.slice(0, -3)}abc`), page('nonsense'), page('')])

    expect(pages[0]).toContain('This link does not work')
    expect(new Set(pages).size).toBe(1)
    expect((await confirmPost('/_kay/mail/list/confirm')).status).toBe(200)
  })

  it('does not list an address that unsubscribed before it was confirmed', async () => {
    const email = fresh()

    await site.call(subscribe, { email })

    const sent = await confirmationOf(email)
    const before = await mail.list().count()

    await mail.list().unsubscribe(email)
    expect(await page(tokenOf(sent, '/confirm'))).toContain('This link does not work')
    expect(await mail.list().count()).toBe(before)
  })
})

describe('unsubscribing', () => {
  const link = (token: string) => `/_kay/mail/list/unsubscribe?token=${token}`

  async function listMail(email: string) {
    const { id } = await mail.list().send({ subject: 'News', text: 'Hello' })

    await site.runJobs()

    const sent = outbox.to(email).find(row => row.subject === 'News')!

    return { id, sent, token: tokenOf(sent, '/unsubscribe') }
  }

  it('puts a signed link and the one-click headers in every list mail', async () => {
    const { email } = await subscribed()
    const { sent, token } = await listMail(email)

    expect(sent.to).toEqual([email])
    expect(sent.headers['List-Unsubscribe']).toMatch(new RegExp(`^<https?://[^/]+/_kay/mail/list/unsubscribe\\?token=${token}>$`))
    expect(sent.headers['List-Unsubscribe-Post']).toBe(ONE_CLICK)
    expect(sent.text).toContain(`/_kay/mail/list/unsubscribe?token=${token}`)
  })

  it('never answers a valid link as done when its list is not declared in this process', async () => {
    const token = signToken('unsubscribe', { list: 'declared-elsewhere', id: 'someone', locale: 'en' })
    const response = await site.fetch(link(token), { method: 'POST', body: ONE_CLICK })

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('60')
    const body = await response.text()

    expect(body).not.toContain('unsubscribed')
    expect(body).not.toContain('does not work')
    expect(body).toContain('try again later')
  })

  it('does not unsubscribe on a GET, which a mail scanner makes, and asks first', async () => {
    const { email } = await subscribed()
    const { token } = await listMail(email)
    const response = await site.fetch(link(token))

    expect(await response.text()).toContain('method="post"')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await mail.list().subscribers()).map(row => row.email)).toContain(email)
  })

  it('unsubscribes on the POST of RFC 8058 with no sign-in, and answers a second one the same', async () => {
    const { email } = await subscribed()
    const { token } = await listMail(email)
    const post = async () => site.fetch(link(token), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: ONE_CLICK })
    const first = await post()
    const second = await post()

    expect(first.status).toBe(200)
    expect(await first.text()).toContain('You are unsubscribed')
    expect(await second.text()).toContain('You are unsubscribed')
    expect((await mail.list().subscribers()).map(row => row.email)).not.toContain(email)
  })

  it('unsubscribes an address that subscribed again through the link of its earlier mail', async () => {
    const { email } = await subscribed()
    const { token } = await listMail(email)

    await mail.list().unsubscribe(email)
    await subscribed(email)
    expect((await mail.list().subscribers()).map(row => row.email)).toContain(email)

    expect(await (await site.fetch(link(token), { method: 'POST', body: ONE_CLICK })).text()).toContain('You are unsubscribed')
    expect((await mail.list().subscribers()).map(row => row.email)).not.toContain(email)
  })

  it('unsubscribes on a POST with any body or none, and refuses a confirmation link there', async () => {
    const { email, confirm } = await subscribed()
    const { token } = await listMail(email)

    expect(await (await site.fetch(link(confirm), { method: 'POST', body: ONE_CLICK })).text()).toContain('This link does not work')
    expect((await mail.list().subscribers()).map(row => row.email)).toContain(email)

    expect(await (await site.fetch(link(token), { method: 'POST' })).text()).toContain('You are unsubscribed')
    expect((await mail.list().subscribers()).map(row => row.email)).not.toContain(email)
  })

  it('answers a forged link like an unknown one, and unsubscribes nobody', async () => {
    const { email } = await subscribed()
    const { token } = await listMail(email)
    const forged = `${token.slice(0, -2)}xx`
    const response = await site.fetch(link(forged), { method: 'POST', body: ONE_CLICK })

    expect(await response.text()).toContain('This link does not work')
    expect((await mail.list().subscribers()).map(row => row.email)).toContain(email)
  })

  it('lets the same address subscribe again after', async () => {
    const { email } = await subscribed()
    const { token } = await listMail(email)

    await site.fetch(link(token), { method: 'POST', body: ONE_CLICK })
    await site.call(subscribe, { email })
    await site.runJobs()

    expect(outbox.to(email).filter(row => row.subject.startsWith('Confirm'))).toHaveLength(2)
  })
})

describe('a test send', () => {
  it('mails the preview to one address, marked as a test, without a broadcast', async () => {
    const editor = fresh()

    await mail.list().test({ subject: 'Spring news', text: 'Hello' }, editor)

    const [sent] = outbox.to(editor)

    expect(sent!.subject).toBe('[Test] Spring news')
    expect(sent!.text).toContain('This is a test send')
    expect(sent!.headers['List-Unsubscribe']).toBeDefined()
  })

  it('previews what a send would mail, with the footer, and mails nobody', async () => {
    const sent = outbox.mails.length
    const preview = await mail.list().preview({ subject: 'Spring news', text: 'Hello', html: '<p>Hello</p>' })

    expect(preview.subject).toBe('Spring news')
    expect(preview.html).toContain('<p>Hello</p>')
    expect(preview.html).toContain('/_kay/mail/list/unsubscribe')
    expect(preview.text).toContain('Hello')

    await site.runJobs()
    expect(outbox.mails).toHaveLength(sent)
  })
})

describe('erasing a person', () => {
  it('lists what the address is on first, pending rows included, whatever its case', async () => {
    const { email } = await subscribed()
    const found = await mail.subscriptions(email.toUpperCase())

    expect(found).toMatchObject([{ list: expect.any(String), status: 'confirmed', askedAt: expect.any(Date), confirmedAt: expect.any(Date) }])
    expect(await mail.subscriptions('nobody@example.com')).toEqual([])
  })

  it('takes the address off every list and removes the mails queued for it', async () => {
    const { email } = await subscribed()

    await mail.enqueue({ to: email, subject: 'Pending', text: 'x' })

    expect(await mail.erase(email.toUpperCase())).toBeGreaterThanOrEqual(2)
    expect((await mail.list().subscribers()).map(row => row.email)).not.toContain(email)

    await site.runJobs()
    expect(outbox.to(email).filter(row => row.subject === 'Pending')).toHaveLength(0)
    expect(await mail.erase(email)).toBe(0)
  })
})

describe('list names', () => {
  it('refuses a second call naming another file or store than the list was made with', () => {
    const app = mailer({ from: 'a@fixture.test' })

    app.list('twice', { file: ':memory:' })
    expect(() => app.list('twice', { file: ':memory:', pace: { batch: 3 } })).not.toThrow()
    expect(() => app.list('twice', { file: 'other.sqlite' })).toThrow('a list keeps one')
    expect(() => app.list('twice', { store: openLists(':memory:') })).toThrow('another store')
    expect(() => app.list('twice')).not.toThrow()
  })

  it('refuses a name that is no plain word', () => {
    for (const name of ['', 'a b', '../x', 'a'.repeat(41), 'news\nletter'])
      expect(() => mail.list(name)).toThrow('a list\'s name')
  })

  it('gives the same list for the same name', () => {
    expect(mail.list('news')).toBe(mail.list('news'))
    expect(mail.list()).toBe(mail.list('default'))
  })
})

describe('a link of a list this process does not declare', () => {
  const host = { configured: () => true, render: async () => ({}) as never, deliver: async () => undefined }

  it('says to come back later in the link\'s locale, with the retry hint', async () => {
    const lists = createLists(host)
    const token = signToken('unsubscribe', { list: 'declared-elsewhere', id: 'someone', locale: 'fr' })
    const result = await lists.unsubscribe(token)

    expect(result).toMatchObject({ valid: false, unavailable: true, locale: 'fr' })

    const response = await lists.page('later', 'fr', undefined, 503)
    const body = await response.text()

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('60')
    expect(body).toContain('ne peut pas être traité pour le moment')
    expect(body).not.toContain('ne fonctionne pas')
    expect(await (await lists.page('later', 'en', undefined, 503)).text()).toContain('try again later')
  })

  it('confirms and unsubscribes through the default file when it exists', async () => {
    const file = join(await scratchDir('list-'), 'default.sqlite')
    const store = openLists(file)
    const first = store.ask('elsewhere', 'a@example.com', 'first', 'en')
    const second = store.ask('elsewhere', 'b@example.com', 'second', 'en')

    store.confirm('elsewhere', second.id)
    store.close()

    const lists = createLists(host, { file })

    expect(await lists.confirm(signToken('confirm', { list: 'elsewhere', id: first.id, locale: 'en' }))).toMatchObject({ kind: 'confirmed' })
    expect(await lists.unsubscribe(signToken('unsubscribe', { list: 'elsewhere', id: second.id, locale: 'en' }))).toMatchObject({ valid: true })

    const check = openLists(file)

    expect(check.subscribers('elsewhere').map(row => row.email)).toEqual(['a@example.com'])
    check.close()
  })
})

describe('what the subscriber is told and what is kept', () => {
  it('shows the stock notice by default, with no privacy link and no wording id', async () => {
    const { html } = await site.visit('/subscribe')

    expect(html).toContain('kmail-subscribe-notice')
    expect(html).toContain('We use your address to send you the mails of this site')
    expect(html).not.toContain('Privacy policy')
    expect(html).toContain('name="wording" value="stock"')
  })

  it('shows a notice of its own with the privacy link and posts its wording id', async () => {
    const { html } = await site.visit('/notice')

    expect(html).toContain('One mail a month about the spring season.')
    expect(html).toContain('href="/privacy"')
    expect(html).toContain('name="wording" value="spring-v1"')
  })

  it('names the list and links the policy in the confirmation mail', async () => {
    const email = fresh()

    await site.call(subscribeNoticed, { email })

    const sent = await confirmationOf(email)

    expect(sent.text).toContain('the list Spring news of http://localhost')
    expect(outbox.links(sent)).toContain('http://localhost/privacy')
  })

  it('names no list in the confirmation mail of the default one', async () => {
    const email = fresh()

    await site.call(subscribe, { email })

    const sent = await confirmationOf(email)

    expect(sent.text).toContain('You will receive the mails of http://localhost')
    expect(sent.text).not.toContain('/privacy')
  })

  it('keeps the page and the wording id of a confirmed subscription', async () => {
    const [custom, stock] = [fresh(), fresh()]

    await site.call(subscribeNoticed, { email: custom, wording: 'spring-v1' }, { headers: { referer: 'https://fixture.test/notice?utm=1' } })
    await site.call(subscribe, { email: stock, wording: 'stock' }, { headers: { referer: 'https://fixture.test/subscribe' } })

    for (const email of [custom, stock])
      await confirmPost(confirmLink(tokenOf(await confirmationOf(email), '/confirm')))

    const kept = async (list: ReturnType<typeof mail.list>, email: string) => (await list.subscribers()).find(row => row.email === email)

    expect(await kept(mail.list('spring'), custom)).toMatchObject({ source: '/notice', wording: 'spring-v1' })
    expect(await kept(mail.list(), stock)).toMatchObject({ source: '/subscribe', wording: 'stock' })
  })
})

describe('the sweep of the lists', () => {
  const host = { configured: () => true, render: async () => ({}) as never, deliver: async () => undefined }

  it('drops a pending address after 8 days with no new subscription, and keeps a confirmed one', async () => {
    const file = join(await scratchDir('list-'), 'sweep.sqlite')
    const store = openLists(file)
    const lists = createLists(host)
    const old = Date.now() - 8 * 24 * 3_600_000

    store.ask('swept', 'pending@example.com', 'pending', 'en', old)
    store.ask('swept', 'kept@example.com', 'kept', 'en', old)
    store.confirm('swept', 'kept', old)
    lists.list('swept', { file })
    await lists.sweep()

    expect(store.confirm('swept', 'pending')).toBe(false)
    expect(store.confirm('swept', 'kept')).toBe(true)
    store.close()
  })

  it('creates no file for a list nobody used', async () => {
    const file = join(await scratchDir('list-'), 'never.sqlite')
    const lists = createLists(host)

    lists.list('unused', { file })
    await lists.sweep()
    expect(await Bun.file(file).exists()).toBe(false)
  })
})

describe('the subscribe form\'s queue insert', () => {
  it('is off the response path for a new address, and absent for a listed one, so both answers take the same steps', async () => {
    const file = join(await scratchDir('list-'), 'form.sqlite')
    const store = openLists(file)
    const known = fresh()

    store.confirm('news', store.ask('news', known, 'known', 'en').id)
    store.close()

    const queued: string[] = []
    const rendered: string[] = []
    const lists = createLists({
      configured: () => true,
      render: async (message) => {
        rendered.push(String(message.to))

        return { to: [String(message.to)] } as never
      },
      deliver: async () => undefined,
    })

    // A queue that answers when told to: the form must not wait for it.
    const release = Promise.withResolvers<string>()

    lists.connect({ enqueueMail: async (mail) => {
      queued.push(String(mail.to))

      return release.promise
    }, enqueueRun: async () => '', activate: () => undefined })

    const [, handler] = lists.list('news', { file }).form()
    const ask = async (email: string) => handler({ email }, { fail: (status: number) => ({ status }), request: new Request('https://fixture.test/_kay/subscribe', { method: 'POST' }), url: new URL('https://fixture.test/_kay/subscribe') } as never)
    const fresher = fresh()

    try {
      expect(await ask(known)).toBeUndefined()
      expect(await ask(fresher)).toBeUndefined()
      expect(rendered).toEqual([known, fresher])
      // Not even the insert has started when the answer is back.
      expect(queued).toEqual([])
      await Bun.sleep(10)
      expect(queued).toEqual([fresher])
    }
    finally {
      release.resolve('job')
      await site.runJobs()
    }
  })
})
