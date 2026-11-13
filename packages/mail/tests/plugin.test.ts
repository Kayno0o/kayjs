import { describe, expect, it } from 'bun:test'
import { memoryJobs } from 'kay/server'
import { mailer } from '../src/mailer'

describe('the mailer as a KayPlugin', () => {
  it('hands the Elysia instance behind it as `elysia`', () => {
    const mail = mailer({ from: 'dev@example.com', queue: { store: memoryJobs() } })

    expect(mail.elysia).toBe(mail)
    expect(Object.keys(mail)).not.toContain('elysia')
  })
})
