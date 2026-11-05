import { describe, expect, it } from 'bun:test'
import { KayError } from 'kay/library'
import { MailNotConfiguredError } from '../src'

describe('MailNotConfiguredError', () => {
  it('is a KayError coded mail-not-configured that names what is missing', () => {
    const error = new MailNotConfiguredError(['MAIL_URL', 'MAIL_FROM'])

    expect(error).toBeInstanceOf(KayError)
    expect([error.code, error.kind, error.name, error.status, error.missing]).toEqual(['mail-not-configured', 'mail-not-configured', 'MailNotConfiguredError', undefined, ['MAIL_URL', 'MAIL_FROM']])
    expect(error.message).toBe('kayjs-mail: MAIL_URL and MAIL_FROM must be set to send mail')
  })
})
