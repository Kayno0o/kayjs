import { mailer } from '@kaynooo/kayjs-mail'
import { afterEach, describe, expect, it } from 'bun:test'
import { branding } from '../src/mail-settings'
import Branded from '../src/mails/branded.kay'
import Headless from '../src/mails/headless.kay'
import Welcome from '../src/mails/welcome.kay'

const mail = mailer({ from: 'hello@fixture.test' })
const render = async (view: typeof Welcome) => mail.render({ to: 'ada@example.com', subject: 'S', view, props: { name: 'Ada', url: 'https://fixture.test/x' } as never })

afterEach(() => {
  branding.logo = undefined
})

describe('the header of the layout', () => {
  it('renders nothing above the card without a logo or a header, in the html and the text alike', async () => {
    const { html, text } = await render(Welcome)

    expect(html).not.toContain('<img')
    expect(text).toStartWith('Welcome, Ada')
  })

  it('shows the settings\' logo on every mail, its alt text standing for it in the text part', async () => {
    branding.logo = { src: 'https://fixture.test/logo.png', alt: 'Fixture', width: 120, height: 40 }

    const { html, text } = await render(Welcome)

    expect(html).toContain('<img src="https://fixture.test/logo.png" alt="Fixture" width="120" height="40"')
    expect(html).not.toContain('<a href="https://fixture.test/logo.png')
    expect(text).toStartWith('Fixture\n\nWelcome, Ada')
  })

  it('links the logo when the settings give where it goes', async () => {
    branding.logo = { src: 'https://fixture.test/logo.png', alt: 'Fixture', width: 120, href: 'https://fixture.test/' }

    const { html, text } = await render(Welcome)

    expect(html).toMatch(/<a href="https:\/\/fixture\.test\/"[^>]*><img src="https:\/\/fixture\.test\/logo\.png"/)
    expect(text).toStartWith('Fixture (https://fixture.test/)')
  })

  it('shows the layout\'s own header in place of the logo', async () => {
    branding.logo = { src: 'https://fixture.test/logo.png', alt: 'Fixture', width: 120 }

    const { html, text } = await render(Branded)

    expect(html).toContain('https://fixture.test/own.png')
    expect(html).not.toContain('https://fixture.test/logo.png')
    expect(text).toStartWith('Own header')
  })

  it('renders an empty header as nothing, the logo included', async () => {
    const { html, text } = await render(Headless)

    expect(html).not.toContain('<img')
    expect(text).toBe('Headless')
  })
})
