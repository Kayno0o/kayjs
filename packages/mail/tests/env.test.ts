import { describe, expect, it } from 'bun:test'
import { mailExtension } from '../src/mailer'

describe('the mail extension\'s environment', () => {
  it('lists the SMTP variables with the host and the sender required in production only, so an app lists them without wiring', () => {
    const { env } = mailExtension('./src/mail')

    expect(Object.keys(env!.properties)).toEqual(['SMTP_HOST', 'SMTP_PORT', 'SMTP_INSECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_RATE_LIMIT', 'SMTP_DKIM_SELECTOR', 'SMTP_DKIM_PRIVATE_KEY', 'SMTP_DKIM_DOMAIN', 'SMTP_FROM', 'MAIL_TO'])
    expect(env!.properties.SMTP_HOST).toMatchObject({ requiredInProduction: true })
    expect(env!.properties.SMTP_FROM).toMatchObject({ requiredInProduction: true })
    expect(env!.properties.SMTP_PORT).toMatchObject({ default: 465 })
    expect(mailExtension(async () => ({}) as never).env).toBeDefined()
  })
})
