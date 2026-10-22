import type { Mail, Transport } from '@kaynooo/kayjs-mail'
import process from 'node:process'
import { darkPalette, mailDefaults, mailer, MailNotConfiguredError, outbox } from '@kaynooo/kayjs-mail'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { setSite } from 'kay/library'
import { mail } from '../src/mail'
import ContactForm from '../src/mails/contact-form.kay'
import Contact from '../src/mails/contact.kay'
import Hello from '../src/mails/hello.kay'
import Kit from '../src/mails/kit.kay'
import Plain from '../src/mails/plain.kay'
import Welcome from '../src/mails/welcome.kay'
import { logged } from './logged'

const URL = 'https://fixture.test/confirm?token=a&b'

beforeEach(() => outbox.clear())

describe('rendering', () => {
  it('renders a .kay mail as a whole html document, themed by the app\'s settings, and writes its text from it', async () => {
    const rendered = await mail.render({ to: 'ada@example.com', subject: 'Welcome <Ada>', view: Welcome, props: { name: 'Ada', url: URL } })

    expect(rendered.html).toStartWith('<!doctype html><html lang="fr" xmlns:v="urn:schemas-microsoft-com:vml"')
    expect(rendered.html).toContain('<title>Welcome &lt;Ada&gt;</title>')
    expect(rendered.html).toContain('background:#0047ff')
    expect(rendered.text).toBe(`Welcome, Ada\n\nYour account is ready. Confirm your address to start.\n\nConfirm my address (${URL})\n\nOr paste ${URL} into your browser.\n\nSent by the fixture site`)
    expect(rendered).toMatchObject({ from: 'Fixture <hello@fixture.test>', to: ['ada@example.com'], cc: [], bcc: [], subject: 'Welcome <Ada>' })
  })

  it('holds in Outlook for Windows: its settings in the head, the card in a fixed-width table, the button padded by hidden spaces', async () => {
    const { html } = await mail.render({ to: 'ada@example.com', subject: 'Welcome', view: Welcome, props: { name: 'Ada', url: URL } })

    expect(html).toContain('<o:PixelsPerInch>96</o:PixelsPerInch>')
    expect(html).toContain('<!--[if mso]><style>body,table,td,th,p,a,span,h1,h2,h3{font-family:\'Segoe UI\', Arial, sans-serif!important}.km-mono{font-family:Consolas, \'Courier New\', monospace!important}</style><![endif]--></head>')
    expect(html!.slice(html!.indexOf('<body'))).not.toContain('[if mso]><![endif]')
    expect(html).toContain('<!--[if true]><table role="presentation" width="560" align="center"')
    expect(html).toContain('style="max-width:560px;margin:0 auto"')
    expect(html).toContain('bgcolor="#ffffff"')
    expect(html).toContain('mso-hide:all')
    expect(html).toContain('<!--[if mso]><i style="mso-font-width:125%;mso-text-raise:150%" hidden>&emsp;</i><span style="mso-text-raise:75%"><![endif]-->Confirm my address<!--[if mso]></span>')
  })

  it('declares dark mode and carries its colours in the head, derived from the light ones, the accent lightened to read on the dark card', async () => {
    const { html, text } = await mail.render({ to: 'ada@example.com', subject: 'Welcome', view: Welcome, props: { name: 'Ada', url: URL } })
    const [head, body] = html!.split('</head>') as [string, string]

    expect(head).toContain('<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">')
    expect(head).toContain('@media (prefers-color-scheme:dark){.km-bg{background-color:#21211c!important}.km-surface{background-color:#141414!important;border-color:#303028!important}')
    expect(head).toContain('.km-button{background-color:#477bff!important;color:#141414!important}')
    expect(head).toContain('[data-ogsc] .km-text,[data-ogsb] .km-text{color:#d5d5d5!important}')
    expect(body).not.toContain('<style')
    expect(body).toContain('class="km-button"')
    expect(text).not.toContain('color-scheme')
  })

  it('declares a mail without dark colours light only, so no client inverts part of it', async () => {
    const { html } = await mail.render({ to: 'ada@example.com', subject: 'Plain', html: '<p>Hi</p>' })

    expect(html).toContain('<meta name="color-scheme" content="light">')
    expect(html).not.toContain('<style')
  })

  it('takes the dark colours an app gives, deriving only the others', () => {
    expect(darkPalette(mailDefaults)).toEqual({ text: '#d5d5d5', muted: '#a3a3a3', background: '#21211c', surface: '#141414', border: '#303028', accent: '#d5d5d5', onAccent: '#141414' })
    expect(darkPalette({ ...mailDefaults, accent: 'rebeccapurple', dark: { surface: '#202020' } })).toMatchObject({ surface: '#202020', accent: 'rebeccapurple', onAccent: '#ffffff' })
  })

  it('follows the preheader with invisible filler, so the inbox preview stops there, and leaves it out of the text', async () => {
    const { html, text } = await mail.render({ to: 'ada@example.com', subject: 'Welcome', view: Welcome, props: { name: 'Ada', url: URL } })

    expect(html).toContain(`Your account is ready${'\u034F\u200C\u00A0'.repeat(100)}</div>`)
    expect(text).not.toContain('\u034F')
  })

  it('renders a mail in the language it is given, its component reading that locale\'s messages', async () => {
    const french = await mail.render({ to: 'ada@example.com', subject: 'Salut', view: Hello, locale: 'fr' })
    const english = await mailer({ from: 'hello@fixture.test', queue: { name: 'english-mail' } }).render({ to: 'ada@example.com', subject: 'Hi', view: Hello })

    expect(french.html).toContain('<html lang="fr"')
    expect(french.text).toBe('Bonjour')
    expect(english.html).toContain('<html lang="en"')
    expect(english.text).toBe('Hello')
    await expect(mail.render({ to: 'ada@example.com', subject: 'Hallo', view: Hello, locale: 'de' })).rejects.toThrow('none of the site\'s locales')
  })

  it('renders in the mailer\'s locale when the message names none, the html lang being the locale rendered', async () => {
    const inherited = await mail.render({ to: 'ada@example.com', subject: 'Salut', view: Hello })
    const overridden = await mail.render({ to: 'ada@example.com', subject: 'Hi', view: Hello, locale: 'en' })

    expect(inherited.text).toBe('Bonjour')
    expect(inherited.html).toContain('<html lang="fr"')
    expect(overridden.text).toBe('Hello')
    expect(overridden.html).toContain('<html lang="en"')
    expect((await mailer({ from: 'hello@fixture.test', queue: { name: 'default-lang' } }).render({ to: 'ada@example.com', subject: 'Hi', view: Hello })).html).toContain('<html lang="en"')
  })

  it('still reads lang, the old name of locale, on a message and on the mailer, the new name winning', async () => {
    const legacy = { lang: 'fr' }
    const old = mailer({ from: 'hello@fixture.test', ...legacy, queue: { name: 'old-lang' } })

    expect((await old.render({ to: 'ada@example.com', subject: 'Salut', view: Hello })).text).toBe('Bonjour')
    expect((await old.render({ to: 'ada@example.com', subject: 'Hi', view: Hello, lang: 'en' })).text).toBe('Hello')
    expect((await old.render({ to: 'ada@example.com', subject: 'Hi', view: Hello, lang: 'en', locale: 'fr' })).text).toBe('Bonjour')
  })

  it('offers one-click unsubscribe through the headers RFC 8058 names, refusing a URL that is not https', async () => {
    const single = await mail.render({ to: 'ada@example.com', subject: 'News', text: 'Hi', unsubscribe: 'https://fixture.test/unsubscribe?u=1&t=<x>' })
    const both = await mail.render({ to: 'ada@example.com', subject: 'News', text: 'Hi', unsubscribe: { url: 'https://fixture.test/u', address: 'unsubscribe@fixture.test' } })

    expect(single.headers).toEqual({ 'List-Unsubscribe': '<https://fixture.test/unsubscribe?u=1&t=%3Cx%3E>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })
    expect(both.headers['List-Unsubscribe']).toBe('<https://fixture.test/u>, <mailto:unsubscribe@fixture.test>')
    await expect(mail.render({ to: 'ada@example.com', subject: 'News', text: 'Hi', unsubscribe: 'http://fixture.test/u' })).rejects.toThrow('it takes an https URL')
  })

  it('ships a code, a divider, an image, a link, headings by level and columns, each built for Outlook too', async () => {
    const { html, text } = await mail.render({ to: 'ada@example.com', subject: 'Kit', view: Kit })

    expect(html).toContain('<img src="https://fixture.test/logo.png" alt="Fixture" width="120" height="40"')
    expect(html).not.toMatch(/loading=|decoding=/)
    expect(html).toContain('font-family:ui-monospace')
    expect(html).toContain('letter-spacing:6px')
    expect(html).toContain('border-top:1px solid #e5e5e0')
    expect(html).toContain('<h2 class="km-text" style="font-size:18px')
    expect(html).toContain('<!--[if true]><td width="251" valign="top"><![endif]--><div style="display:inline-block;width:100%;max-width:251px;vertical-align:top">')
    expect(html).toContain('<a class="km-link" href="https://fixture.test/help" target="_blank" rel="noopener" style="color:#0047ff;text-decoration:underline;overflow-wrap:anywhere;word-break:break-word">the help</a>')
    expect(text).toBe('Fixture\n\nYour code\n\n482 913\n\nDetails\n\nLeft\n\nRight\n\nRead the help (https://fixture.test/help).')
  })

  it('lays out a contact form\'s fields and quotes its message, line breaks kept, in html and text alike', async () => {
    const fields = [{ label: 'Name', value: 'Ada <Lovelace>' }, { label: 'Email', value: 'ada@example.com', href: 'mailto:ada@example.com' }, { label: 'Address', value: '1 Main St\nLondon' }, { label: 'Phone', value: ' ' }, { label: 'Topic' }]
    const { html, text } = await mail.render({ to: 'ada@example.com', subject: 'Contact', view: Contact, props: { fields, message: 'Hello,\n\nA quote for <the> kitchen?\r\nThanks' } })

    expect(html).toContain('<th class="km-muted" scope="row" align="left" valign="top"')
    expect(html).toContain('>Ada &lt;Lovelace&gt;</td>')
    expect(html).toContain('<a class="km-link" href="mailto:ada@example.com" style="color:#0047ff;text-decoration:underline">ada@example.com</a>')
    expect(html).toContain('>1 Main St<br>London</td>')
    expect(html).toContain('word-break:break-word;overflow-wrap:anywhere')
    expect(html).toContain('bgcolor="#f4f4f2" style="padding:16px 18px;background:#f4f4f2;border-left:3px solid #0047ff')
    expect(html).toContain('>Hello,<br><br>A quote for &lt;the&gt; kitchen?<br>Thanks</td>')
    expect(html).toContain('.km-quote{border-color:#477bff!important}')
    expect(text).toBe('A message from the site\n\nName: Ada <Lovelace>\nEmail: ada@example.com\nAddress: 1 Main St\nLondon\nPhone: not given\nTopic: not given\n\nHello,\n\nA quote for <the> kitchen?\nThanks')
  })

  it('renders the contact form mail llms.txt shows', async () => {
    const { text } = await mail.render({ to: 'site@fixture.test', subject: 'Contact', view: ContactForm, props: { name: 'Ada', email: 'ada@example.com', topic: 'A kitchen', message: 'Hello,\nA quote?' } })

    expect(text).toBe('A kitchen\n\nName: Ada\nEmail: ada@example.com\nPhone: not given\n\nHello,\nA quote?\n\nReply to Ada (ada@example.com?subject=Re%3A%20A%20kitchen)\n\nSent from the contact form. Replying to this mail writes to Ada.')
  })

  it('takes no props for a mail without required ones, and the text it is given over the one written from the html', async () => {
    const rendered = await mail.render({ to: 'ada@example.com', subject: 'Plain', view: Plain, text: 'Given text' })

    expect(rendered.html).toContain('<p>Nothing to fill in.</p>')
    expect(rendered.text).toBe('Given text')
  })

  it('wraps an html fragment in a document, keeps a whole one, and sends text alone without html', async () => {
    expect((await mail.render({ to: 'a@example.com', subject: 'S', html: '<p>Hi</p>' })).html).toContain('<body style="margin:0;padding:0"><p>Hi</p></body>')
    expect((await mail.render({ to: 'a@example.com', subject: 'S', html: '<html><body>Hi</body></html>' })).html).toBe('<!doctype html><html><body>Hi</body></html>')
    expect(await mail.render({ to: 'a@example.com', subject: 'S', text: 'Just text' })).toMatchObject({ html: undefined, text: 'Just text' })
  })

  it('refuses a mail with no recipient, or an address holding a line break, which would add a recipient of its own', async () => {
    await expect(mail.render({ to: [], subject: 'Nobody', text: 'Hi' })).rejects.toThrow('"Nobody" has no recipient')
    await expect(mail.render({ to: 'ada@example.com\r\nBcc: spam@example.com', subject: 'Spam', text: 'Hi' })).rejects.toThrow('"Spam" has an address holding a line break')
    await expect(mail.render({ to: 'ada@example.com', replyTo: { name: 'Ada', address: 'ada@example.com\nBcc: spam@example.com' }, subject: 'Spam', text: 'Hi' })).rejects.toThrow('line break')
  })

  it('refuses an address field a visitor filled with several addresses, which would relay the mail to each', async () => {
    for (const to of ['me@example.com,victim@example.org', 'me@example.com; victim@example.org', 'friends: me@example.com, victim@example.org;', 'Ada'])
      await expect(mail.render({ to, subject: 'Relay', text: 'Hi' }), to).rejects.toThrow('"Relay" has an address holding no address or several')

    await expect(mail.render({ to: 'ada@example.com', replyTo: 'me@example.com, victim@example.org', subject: 'Relay', text: 'Hi' })).rejects.toThrow('several')
    await expect(mail.render({ to: { name: 'Ada', address: 'ada@example.com,victim@example.org' }, subject: 'Relay', text: 'Hi' })).rejects.toThrow('several')
    expect((await mail.render({ to: ['"Doe, Ada" <ada@example.com>', 'bob@example.com'], subject: 'Two', text: 'Hi' })).to).toHaveLength(2)
  })

  it('leaves out an optional address field left empty, as a form\'s blank reply-to, but not an empty recipient', async () => {
    const rendered = await mail.render({ to: 'ada@example.com', replyTo: '', cc: ['', 'bob@example.com'], bcc: ' ', from: '', subject: 'Blank', text: 'Hi' })

    expect({ replyTo: rendered.replyTo, cc: rendered.cc, bcc: rendered.bcc, from: rendered.from }).toEqual({ replyTo: undefined, cc: ['bob@example.com'], bcc: [], from: (await mail.render({ to: 'ada@example.com', subject: 'Blank', text: 'Hi' })).from })
    await expect(mail.render({ to: '', subject: 'Nobody', text: 'Hi' })).rejects.toThrow('"Nobody" has an address holding no address or several')
  })

  it('refuses a mail with no recipient before rendering its component', async () => {
    let rendered = false
    const view = () => {
      rendered = true

      return 'Hi'
    }

    await expect(mail.render({ to: [], subject: 'Nobody', view })).rejects.toThrow('has no recipient')
    expect(rendered).toBe(false)
  })
})

describe('the outbox', () => {
  it('keeps what is sent under bun test, found by recipient', async () => {
    const delivery = await mail.send({ to: { name: 'Ada', address: 'Ada@Example.com' }, cc: 'Bob <bob@example.com>', subject: 'One', text: 'Hi' })

    await mail.send({ to: 'carol@example.com', subject: 'Two', text: 'Hi' })

    expect(delivery.accepted).toEqual(['Ada@Example.com', 'bob@example.com'])
    expect(outbox.mails.map(sent => sent.subject)).toEqual(['One', 'Two'])
    expect(outbox.last()?.subject).toBe('Two')
    expect(outbox.to('ada@example.com').map(sent => sent.subject)).toEqual(['One'])
    expect(outbox.to('bob@example.com').map(sent => sent.subject)).toEqual(['One'])
    expect(outbox.find(outbox.last()!.id)?.subject).toBe('Two')
  })
})

describe('the outbox helpers', () => {
  it('gives the links a mail carries, each once, from its html or else its text', async () => {
    await mail.send({ to: 'ada@example.com', subject: 'Welcome', view: Welcome, props: { name: 'Ada', url: URL } })
    await mail.send({ to: 'bob@example.com', subject: 'Reset', text: 'Reset it at https://fixture.test/reset?t=1 (or https://fixture.test/help).' })

    expect(outbox.links(outbox.to('ada@example.com')[0]!)).toEqual([URL])
    expect(outbox.links(outbox.to('bob@example.com')[0]!)).toEqual(['https://fixture.test/reset?t=1', 'https://fixture.test/help'])
  })

  it('waits for a mail to an address, returning one already there at once, and fails after its timeout', async () => {
    const waiting = outbox.waitFor('Ada@Example.com')

    await mail.send({ to: 'bob@example.com', subject: 'Not this one', text: 'Hi' })
    setTimeout(() => void mail.send({ to: 'ada@example.com', subject: 'This one', text: 'Hi' }), 20)

    expect((await waiting).subject).toBe('This one')
    expect((await outbox.waitFor('bob@example.com')).subject).toBe('Not this one')
    await expect(outbox.waitFor('carol@example.com', { timeout: '50ms' })).rejects.toThrow('no mail to carol@example.com reached the outbox within 50 ms')
  })

  it('waits for a mail matching a predicate, running the site\'s queues until it is delivered, and lists what the outbox holds on failure', async () => {
    let runs = 0
    const site = {
      runJobs: async () => {
        runs++

        if (runs === 3)
          await mail.send({ to: 'ada@example.com', subject: 'Second', text: 'Hi' })

        return 0
      },
    }

    await mail.send({ to: 'ada@example.com', subject: 'First', text: 'Hi' })

    expect((await outbox.waitFor('ada@example.com', { site, find: each => each.subject === 'Second' })).subject).toBe('Second')
    expect(runs).toBe(3)
    await expect(outbox.waitFor('ada@example.com', { site, find: each => each.subject === 'Third', timeout: '50ms' })).rejects.toThrow('the outbox holds "First" to ada@example.com; "Second" to ada@example.com')
    await expect(outbox.waitFor('carol@example.com', { timeout: '50ms' })).rejects.toThrow('"Second" to ada@example.com')
  })

  it('runs the site\'s queues before taking a mail already there, so the one still queued is the newest', async () => {
    const site = {
      runJobs: async () => {
        await mail.send({ to: 'ada@example.com', subject: 'Queued', text: 'Hi' })

        return 1
      },
    }

    await mail.send({ to: 'ada@example.com', subject: 'Sent late', text: 'Hi' })

    expect((await outbox.waitFor('ada@example.com', { site })).subject).toBe('Queued')
  })

  it('waits without a site for a mail its predicate accepts', async () => {
    const waiting = outbox.waitFor('ada@example.com', { find: each => each.subject === 'Wanted' })

    await mail.send({ to: 'ada@example.com', subject: 'Other', text: 'Hi' })
    await mail.send({ to: 'ada@example.com', subject: 'Wanted', text: 'Hi' })

    expect((await waiting).subject).toBe('Wanted')
    await expect(outbox.waitFor('ada@example.com', { find: () => false, timeout: '50ms' })).rejects.toThrow('no mail to ada@example.com matching `find` reached')
  })

  it('reads a link and its token from a mail', async () => {
    await mail.send({ to: 'ada@example.com', subject: 'Welcome', view: Welcome, props: { name: 'Ada', url: URL } })

    const sent = outbox.last()!

    expect(outbox.link(sent)).toBe(URL)
    expect(outbox.link(sent, '/confirm')).toBe(URL)
    expect(outbox.link(sent, /token=a/)).toBe(URL)
    expect(outbox.token(sent, '/confirm')).toBe('a')
    expect(() => outbox.link(sent, '/reset')).toThrow(`has no link matching /reset, its links are ${URL}`)
    await mail.send({ to: 'bob@example.com', subject: 'Plain', text: 'Open https://fixture.test/help' })
    expect(() => outbox.token(outbox.last()!)).toThrow('has no token')
  })
})

describe('the queue', () => {
  it('renders a mail when enqueued and sends it once drained, retrying a failure', async () => {
    const sent: Mail[] = []
    let failures = 1
    const flaky: Transport = {
      send: async (queued) => {
        if (failures-- > 0)
          throw new Error('server away')

        sent.push(queued)

        return { accepted: [], rejected: [] }
      },
    }
    const queued = mailer({ from: 'q@example.com', transport: flaky, queue: { name: 'flaky-mail', backoff: '10ms' } })

    await queued.enqueue({ to: 'ada@example.com', subject: 'Queued', view: Welcome, props: { name: 'Ada', url: URL } })
    expect(await queued.drain()).toBe(1)
    expect(sent).toEqual([])

    await Bun.sleep(30)
    expect(await queued.drain()).toBe(1)
    expect(sent.map(each => each.subject)).toEqual(['Queued'])
    expect(sent[0]!.html).toContain('Welcome, Ada')
  })

  it('lists the mails it gave up on, and removes a person\'s queued and failed mails, by recipient, id or match', async () => {
    const refusing: Transport = { send: async (mail) => {
      throw new Error(`550 no mailbox for ${mail.subject}`)
    } }
    const queued = mailer({ from: 'site@example.com', transport: refusing, queue: { name: 'erased-mail', attempts: 1 } })

    await logged(async () => {
      await queued.enqueue({ to: 'Ada <Ada@Example.com>', subject: 'Failed', text: 'T' })
      await queued.drain()
    })
    await queued.enqueue({ to: 'bob@example.com', bcc: ['ada@example.com'], subject: 'Later', text: 'T' }, { delay: '1h' })
    await queued.enqueue({ to: 'bob@example.com', subject: 'Bob', text: 'T' }, { delay: '1h' })
    const cy = await queued.enqueue({ to: 'cy@example.com', subject: 'Cy', text: 'T' }, { delay: '1h' })

    expect((await queued.failed()).map(job => [job.payload.subject, job.error])).toEqual([['Failed', '550 no mailbox for Failed']])
    expect(await queued.remove({ recipient: 'ada@example.com' })).toBe(2)
    expect(await queued.failed()).toEqual([])
    expect([await queued.remove(cy), await queued.remove(cy)]).toEqual([1, 0])
    expect(await queued.remove(mail => mail.subject === 'Bob')).toBe(1)
  })
})

describe('the log', () => {
  it('names each mail sent, how many it went to and where, and the server\'s answer', async () => {
    const answering: Transport = { send: async () => ({ accepted: ['ada@example.com', 'bob@Example.com', 'cy@other.test'], rejected: [], response: '250 2.0.0 queued as 4F2' }) }
    const lines = await logged(async () => mailer({ from: 'site@example.com', transport: answering, queue: { name: 'logged-mail' } }).send({ to: 'ada@example.com', bcc: ['bob@Example.com', 'cy@other.test'], subject: 'Logged', text: 'T' }))

    expect(lines).toEqual([['info', 'kayjs-mail: A mail sent to 3 recipients at example.com, other.test: 250 2.0.0 queued as 4F2']])
  })

  it('names the recipients in full when the app asks', async () => {
    const answering: Transport = { send: async () => ({ accepted: ['ada@example.com'], rejected: [] }) }
    const lines = await logged(async () => mailer({ from: 'site@example.com', transport: answering, logRecipients: true, queue: { name: 'logged-in-full' } }).send({ to: 'ada@example.com', subject: 'Logged', text: 'T' }))

    expect(lines).toEqual([['info', 'kayjs-mail: A mail sent to ada@example.com']])
  })

  it('names the subject too when the app asks, its line breaks escaped', async () => {
    const answering: Transport = { send: async () => ({ accepted: ['ada@example.com'], rejected: [] }) }
    const lines = await logged(async () => mailer({ from: 'site@example.com', transport: answering, logSubjects: true, queue: { name: 'logged-subject' } }).send({ to: 'ada@example.com', subject: 'Hi\nforged line', text: 'T' }))

    expect(lines).toEqual([['info', 'kayjs-mail: "Hi\\nforged line" sent to 1 recipient at example.com']])
  })

  it('names a mail the server refuses outright and why, and throws all the same', async () => {
    const refusing: Transport = { send: async () => {
      throw new Error('550 mailbox unavailable')
    } }
    const lines = await logged(async () => expect(mailer({ from: 'site@example.com', transport: refusing, queue: { name: 'refused-mail' } }).send({ to: { name: 'Ada', address: 'ada@example.com' }, subject: 'Refused', text: 'T' })).rejects.toThrow('550 mailbox unavailable'))

    expect(lines).toEqual([['error', 'kayjs-mail: A mail to 1 recipient at example.com was not sent: 550 mailbox unavailable']])
  })

  it('names an enqueued mail given up after its last attempt, then hands it to the queue\'s onFailed', async () => {
    const refusing: Transport = { send: async () => {
      throw new Error('550 mailbox unavailable')
    } }
    const failed: string[] = []
    const queued = mailer({ from: 'site@example.com', transport: refusing, queue: { name: 'given-up-mail', attempts: 1, onFailed: ({ payload: mail }) => {
      failed.push(mail.subject)
    } } })
    const lines = await logged(async () => {
      await queued.enqueue({ to: 'ada@example.com', subject: 'Given up', text: 'T' })
      await queued.drain()
    })

    expect(lines).toContainEqual(['error', 'kayjs-mail: A mail to 1 recipient at example.com is given up after its last attempt: 550 mailbox unavailable'])
    expect(failed).toEqual(['Given up'])
  })
})

describe('a partly refused mail', () => {
  it('is logged counting the refused addresses, and sent all the same', async () => {
    const partial: Transport = { send: async () => ({ accepted: ['ada@example.com'], rejected: ['bob@example.com'] }) }
    let delivery: Awaited<ReturnType<Transport['send']>> | undefined
    const lines = await logged(async () => {
      delivery = await mailer({ from: 'site@example.com', transport: partial, queue: { name: 'partial-mail' } }).send({ to: ['ada@example.com', 'bob@example.com'], subject: 'Partly', text: 'T' })
    })

    expect(delivery?.rejected).toEqual(['bob@example.com'])
    expect(lines).toContainEqual(['warn', 'kayjs-mail: A mail was refused for 1 recipient at example.com, and sent to the others'])
  })
})

describe('configuration', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it('stops a production boot with no MAIL_URL, and a server starting with no sender, naming where one is set', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.MAIL_URL
    delete process.env.MAIL_FROM

    expect(() => mailer()).toThrow('MAIL_URL')
    expect(() => mailer({ from: 'site@example.com' })).toThrow('MAIL_URL')

    process.env.MAIL_URL = 'smtp://smtp.example.com'
    expect(() => new Elysia().use(mailer({ queue: { name: 'no-sender' } })).listen(0)).toThrow(/MAIL_FROM[\s\S]*SITE_URL/)
  })

  it('sends from noreply@ the site\'s host, without www., when no sender is set', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MAIL_URL = 'smtp://smtp.example.com'
    delete process.env.MAIL_FROM
    setSite('https://www.example.org/')

    try {
      const app = mailer({ queue: { name: 'site-sender' } })

      expect(app.configured).toBe(true)
      expect((await app.render({ to: 'a@example.com', subject: 'S', text: 'T' })).from).toBe('noreply@example.org')
      expect((await mailer({ queue: { name: 'site-sender-name' }, fromName: 'Site' }).render({ to: 'a@example.com', subject: 'S', text: 'T' })).from).toEqual({ name: 'Site', address: 'noreply@example.org' })
      expect((await mailer({ queue: { name: 'site-sender-env' } }).render({ to: 'a@example.com', subject: 'S', text: 'T' })).from).toBe('noreply@example.org')

      process.env.MAIL_FROM = 'hello@example.org'
      expect((await mailer({ queue: { name: 'site-sender-set' } }).render({ to: 'a@example.com', subject: 'S', text: 'T' })).from).toBe('hello@example.org')
    }
    finally {
      setSite(undefined)
    }
  })

  it('offers no default sender for a site with no domain, such as localhost', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MAIL_URL = 'smtp://smtp.example.com'
    delete process.env.MAIL_FROM
    setSite('http://localhost:3000/')

    try {
      expect(mailer({ queue: { name: 'localhost-sender' } }).configured).toBe(false)
    }
    finally {
      setSite(undefined)
    }
  })

  it('stops a production boot on a custom transport with no sender, naming from and MAIL_FROM, while development and tests keep the fallback', async () => {
    const custom: Transport = { send: async () => ({ accepted: [], rejected: [] }) }

    process.env.NODE_ENV = 'production'
    delete process.env.MAIL_FROM

    expect(() => new Elysia().use(mailer({ transport: custom, queue: { name: 'senderless-a' } })).listen(0)).toThrow(/MAIL_FROM[\s\S]*`from`/)
    expect(() => mailer({ transport: custom, from: 'site@example.com', queue: { name: 'senderless-b' } })).not.toThrow()

    process.env.MAIL_FROM = 'site@example.com'
    expect(() => mailer({ transport: custom, queue: { name: 'senderless-c' } })).not.toThrow()

    delete process.env.MAIL_FROM

    const optional = mailer({ transport: custom, optional: true, queue: { name: 'senderless-d' } })

    expect(optional.configured).toBe(false)
    await expect(optional.send({ to: 'a@example.com', subject: 'S', text: 'T' })).rejects.toThrow('MAIL_FROM must be set to send mail')

    for (const env of ['development', 'test']) {
      process.env.NODE_ENV = env

      const sent = await mailer({ transport: custom, queue: { name: `senderless-${env}` } }).render({ to: 'a@example.com', subject: 'S', text: 'T' })

      expect(sent.from).toBe('kay@localhost')
    }
  })

  it('lets an optional mailer boot without its settings, each send then throwing MailNotConfiguredError before anything is queued', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.MAIL_URL
    delete process.env.MAIL_FROM

    const optional = mailer({ optional: true, queue: { name: 'optional-mail' } })

    expect(optional.configured).toBe(false)
    expect(mailer({ optional: true, from: 'site@example.com', queue: { name: 'optional-from' } }).configured).toBe(false)

    let refusal: unknown

    try {
      await optional.send({ to: 'a@example.com', subject: 'S', text: 'T' })
    }
    catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(MailNotConfiguredError)
    expect((refusal as MailNotConfiguredError).missing).toEqual(['MAIL_URL', 'MAIL_FROM'])
    await expect(optional.enqueue({ to: 'a@example.com', subject: 'S', text: 'T' })).rejects.toThrow('MAIL_URL and MAIL_FROM must be set to send mail')
    expect(await optional.drain()).toBe(0)

    process.env.MAIL_URL = 'smtp://smtp.example.com'
    process.env.MAIL_FROM = 'site@example.com'
    expect(mailer({ optional: true, queue: { name: 'optional-set' } }).configured).toBe(true)
  })

  it('sends a mail naming no recipient to the mailer\'s own, `to` or else MAIL_TO, and throws MailNotConfiguredError naming MAIL_TO without one', async () => {
    delete process.env.MAIL_TO

    const team = mailer({ from: 'site@example.com', to: 'team@example.com', queue: { name: 'team-mail' } })
    const fromEnv = mailer({ from: 'site@example.com', queue: { name: 'env-to-mail' } })

    expect((await team.render({ subject: 'Contact', text: 'Hi' })).to).toEqual(['team@example.com'])
    expect((await team.render({ to: 'ada@example.com', subject: 'Contact', text: 'Hi' })).to).toEqual(['ada@example.com'])
    await expect(fromEnv.render({ subject: 'Contact', text: 'Hi' })).rejects.toThrow('MAIL_TO must be set to send mail')
    await expect(fromEnv.render({ to: [], subject: 'Nobody', text: 'Hi' })).rejects.toThrow('"Nobody" has no recipient')

    process.env.MAIL_TO = 'team@example.com, Support <support@example.com>'
    expect((await fromEnv.render({ subject: 'Contact', text: 'Hi' })).to).toEqual(['team@example.com', 'Support <support@example.com>'])
  })

  it('counts MAIL_TO among what an optional mailer misses for a send naming no recipient, and stops a production boot on a malformed one', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.MAIL_URL
    delete process.env.MAIL_FROM
    delete process.env.MAIL_TO

    const optional = mailer({ optional: true, queue: { name: 'optional-to' } })

    await expect(optional.send({ subject: 'Contact', text: 'Hi' })).rejects.toThrow('MAIL_URL, MAIL_FROM and MAIL_TO must be set to send mail')
    await expect(optional.send({ to: 'ada@example.com', subject: 'Contact', text: 'Hi' })).rejects.toThrow('MAIL_URL and MAIL_FROM must be set to send mail')

    process.env.MAIL_URL = 'smtp://smtp.example.com'
    process.env.MAIL_FROM = 'site@example.com'
    process.env.MAIL_TO = 'team'
    expect(() => mailer({ queue: { name: 'malformed-to' } })).toThrow('MAIL_TO')

    process.env.MAIL_TO = 'team@example.com,support@example.com'
    expect(() => mailer({ queue: { name: 'valid-to' } })).not.toThrow()
  })

  it('stops a production boot on a MAIL_FROM that is no address', () => {
    process.env.NODE_ENV = 'production'
    process.env.MAIL_URL = 'smtp://smtp.example.com'
    process.env.MAIL_FROM = 'Site'

    expect(() => mailer({ queue: { name: 'malformed-from' } })).toThrow('MAIL_FROM')

    for (const valid of ['site@example.com', 'Site <site@example.com>']) {
      process.env.MAIL_FROM = valid
      expect(() => mailer({ queue: { name: 'valid-from' } })).not.toThrow()
    }
  })

  it('reads MAIL_RATE_LIMIT as a count and a window at boot, a bare count being a count a second, and stops on a window that is none or a zero count', () => {
    Object.assign(process.env, { NODE_ENV: 'production', MAIL_URL: 'smtp://smtp.example.com:465', MAIL_FROM: 'site@example.com' })

    for (const valid of ['5', '5/1s', '10/2m']) {
      process.env.MAIL_RATE_LIMIT = valid
      expect(() => mailer({ queue: { name: `rate-${valid}` } })).not.toThrow()
    }

    for (const bad of ['5/soon', '0/1s', '0', '5/0s']) {
      process.env.MAIL_RATE_LIMIT = bad
      expect(() => mailer({ queue: { name: `rate-bad-${bad}` } })).toThrow('MAIL_RATE_LIMIT')
      expect(() => mailer({ optional: true, queue: { name: `rate-bad-optional-${bad}` } })).toThrow('MAIL_RATE_LIMIT')
    }
  })

  it('stops the boot of a server whose MAIL_URL gives a user without a password, or a URL that is no server', () => {
    process.env.NODE_ENV = 'production'
    process.env.MAIL_FROM = 'site@example.com'

    for (const url of ['smtp://site@smtp.example.com', 'smtp://:secret@smtp.example.com']) {
      process.env.MAIL_URL = url
      expect(() => mailer()).toThrow('the login in MAIL_URL needs a user and a password')
      expect(() => mailer({ optional: true })).toThrow('the login in MAIL_URL needs a user and a password')
    }

    for (const url of ['smtp.example.com', 'https://smtp.example.com', 'smtp://']) {
      process.env.MAIL_URL = url
      expect(() => mailer()).toThrow('MAIL_URL is no SMTP server')
    }

    process.env.MAIL_URL = 'smtp://site%40example.com:p%3Ass@smtp.example.com:587'
    expect(() => mailer()).not.toThrow()
  })

  it('still reads the names of before 1.70, warning once which to rename', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.MAIL_URL
    delete process.env.MAIL_FROM
    delete process.env.MAIL_RATE_LIMIT
    Object.assign(process.env, { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: 'site@example.com', SMTP_PASS: 'p:ss', SMTP_FROM: 'old@example.com', SMTP_INSECURE: 'false', SMTP_RATE_LIMIT: '2/1s' })

    const lines = await logged(async () => {
      expect(mailer({ queue: { name: 'legacy-names' } }).configured).toBe(true)
      expect(mailer({ queue: { name: 'legacy-names-again' } }).configured).toBe(true)
    })

    const env: Record<string, string | undefined> = process.env

    expect(env.MAIL_URL).toBe('smtp://site%40example.com:p%3Ass@smtp.example.com:587')
    expect(env.MAIL_FROM).toBe('old@example.com')
    expect(env.MAIL_INSECURE).toBe('false')
    expect(env.MAIL_RATE_LIMIT).toBe('2/1s')
    expect(lines.filter(([level]) => level === 'warn')).toEqual([['warn', expect.stringMatching(/rename .*SMTP_FROM to MAIL_FROM.*SMTP_RATE_LIMIT to MAIL_RATE_LIMIT.*MAIL_URL/)]])
  })

  it('prefers a new name over the old one set beside it', () => {
    process.env.NODE_ENV = 'production'
    Object.assign(process.env, { SMTP_HOST: 'old.example.com', MAIL_URL: 'smtp://new.example.com:25', SMTP_FROM: 'old@example.com', MAIL_FROM: 'new@example.com', SMTP_RATE_LIMIT: '2/1s', MAIL_RATE_LIMIT: '5/1s' })
    mailer({ queue: { name: 'legacy-both' } })

    const env: Record<string, string | undefined> = process.env

    expect(env.MAIL_URL).toBe('smtp://new.example.com:25')
    expect(env.MAIL_FROM).toBe('new@example.com')
    expect(env.MAIL_RATE_LIMIT).toBe('5/1s')
  })
})
