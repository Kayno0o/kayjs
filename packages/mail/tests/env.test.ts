import { describe, expect, it } from 'bun:test'
import { parseMailUrl } from '../src/env'
import { mail } from '../src/mailer'

describe('the mail extension\'s environment', () => {
  it('lists the mail variables with the server required in production only, so an app lists them without wiring', () => {
    const { env } = mail({ module: './src/mail' })

    expect(Object.keys(env!.properties)).toEqual(['MAIL_URL', 'MAIL_INSECURE', 'MAIL_RATE_LIMIT', 'MAIL_DKIM_SELECTOR', 'MAIL_DKIM_PRIVATE_KEY', 'MAIL_DKIM_DOMAIN', 'MAIL_FROM', 'MAIL_TO', 'MAIL_EVENTS_POSTMARK', 'MAIL_EVENTS_MAILGUN', 'MAIL_EVENTS_SENDGRID', 'MAIL_EVENTS_RESEND', 'MAIL_EVENTS_SES', 'MAIL_INBOUND_SECRET'])
    expect(env!.properties.MAIL_EVENTS_POSTMARK).toMatchObject({ description: expect.stringContaining('user:password'), pattern: '^[^:\\s]+:\\S+$' })
    expect(env!.properties.MAIL_INBOUND_SECRET).toMatchObject({ description: expect.stringContaining('/_kay/mail/inbound') })
    expect(env!.required ?? []).not.toContain('MAIL_INBOUND_SECRET')
    expect(env!.properties.MAIL_URL).toMatchObject({ requiredInProduction: true })
    expect(env!.properties.MAIL_FROM).not.toMatchObject({ requiredInProduction: true })
    expect(mail({ server: async () => ({}) as never }).env).toBeDefined()
  })
})

describe('mail()', () => {
  it('names the module kay imports the mailer from, as `mail`', () => {
    expect(mail({ module: './src/mail' })).toMatchObject({ name: '@kaynooo/kayjs-mail', serverModule: { path: './src/mail', export: 'mail' } })
  })

  it('takes a module or a server, one of them', () => {
    expect(() => mail({})).toThrow('takes the path of the module')
    expect(() => mail({ module: './src/mail', server: async () => ({}) as never })).toThrow('not both')
  })
})

describe('MAIL_URL', () => {
  it('names MAIL_URL for a login that is no percent-encoding, instead of a bare URIError', () => {
    expect(() => parseMailUrl('smtp://ada:100%@mail.example.com')).toThrow('MAIL_URL')
    expect(parseMailUrl('smtp://ada:p%40ss@mail.example.com')).toMatchObject({ user: 'ada', pass: 'p@ss' })
  })

  it('reads smtps: as TLS from the start on any port, and smtp: as the port decides', () => {
    expect(parseMailUrl('smtps://mail.example.com:2465')).toMatchObject({ port: 2465, secure: true })
    expect(parseMailUrl('smtps://mail.example.com')).toMatchObject({ port: 465, secure: true })
    expect(parseMailUrl('smtp://mail.example.com:587').secure).toBeUndefined()
  })
})
