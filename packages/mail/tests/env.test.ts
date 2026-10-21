import { describe, expect, it } from 'bun:test'
import { mail, mailExtension } from '../src/mailer'

describe('the mail extension\'s environment', () => {
  it('lists the mail variables with the server required in production only, so an app lists them without wiring', () => {
    const { env } = mail({ module: './src/mail' })

    expect(Object.keys(env!.properties)).toEqual(['MAIL_URL', 'MAIL_INSECURE', 'MAIL_RATE_LIMIT', 'MAIL_DKIM_SELECTOR', 'MAIL_DKIM_PRIVATE_KEY', 'MAIL_DKIM_DOMAIN', 'MAIL_FROM', 'MAIL_TO'])
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

  it('is what mailExtension gives for a path or a function', () => {
    expect(mailExtension('./src/mail').serverModule).toEqual({ path: './src/mail', export: 'mail' })
    expect(mailExtension(async () => ({}) as never).serverModule).toBeUndefined()
  })
})
