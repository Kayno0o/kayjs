import { describe, expect, it } from 'bun:test'
import { mail, mailExtension } from '../src/mailer'

describe('the mail extension\'s environment', () => {
  it('lists the SMTP variables with the host and the sender required in production only, so an app lists them without wiring', () => {
    const { env } = mail({ module: './src/mail' })

    expect(Object.keys(env!.properties)).toEqual(['SMTP_HOST', 'SMTP_PORT', 'SMTP_INSECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_RATE_LIMIT', 'SMTP_DKIM_SELECTOR', 'SMTP_DKIM_PRIVATE_KEY', 'SMTP_DKIM_DOMAIN', 'SMTP_FROM', 'MAIL_TO'])
    expect(env!.properties.SMTP_HOST).toMatchObject({ requiredInProduction: true })
    expect(env!.properties.SMTP_FROM).toMatchObject({ requiredInProduction: true })
    expect(env!.properties.SMTP_PORT).toMatchObject({ default: 465 })
    expect(mail({ server: async () => ({}) as never }).env).toBeDefined()
  })
})

describe('mail()', () => {
  it('names the module kay imports the mailer from, as `mail`', () => {
    expect(mail({ module: './src/mail' })).toMatchObject({ name: '@kaynooo/kayjs-mail', serverModule: { path: './src/mail', export: 'mail' } })
  })

  it('takes a module or a server, one of them', () => {
    expect(() => mail({})).toThrow('takes the path of the module')
    expect(() => mail({ module: './src/mail', server: async () => ({}) as never })).toThrow('takes the path of the module')
  })

  it('is what mailExtension gives for a path or a function', () => {
    expect(mailExtension('./src/mail').serverModule).toEqual({ path: './src/mail', export: 'mail' })
    expect(mailExtension(async () => ({}) as never).serverModule).toBeUndefined()
  })
})
