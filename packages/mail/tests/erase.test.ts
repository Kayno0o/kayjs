import { describe, expect, it } from 'bun:test'
import { memoryJobs } from 'kay/server'
import { mailer } from '../src/mailer'

let counter = 0

function queued() {
  counter++

  return mailer({ from: 'dev@example.com', transport: { send: async () => ({ accepted: [], rejected: [], response: 'ok' }) }, queue: { store: memoryJobs(), name: `erase-${counter}` } })
}

const NFC = `Jos${String.fromCharCode(0xe9)}@example.com`
const NFD = `Jose${String.fromCharCode(0x301)}@example.com`

const CASES: [string, string, string][] = [
  ['NFC queued, NFD erased', NFC, NFD],
  ['NFD queued, NFC erased', NFD, NFC],
  ['a trailing space', 'ada@example.com', 'ada@example.com '],
  ['a leading space', 'ada@example.com', ' ada@example.com'],
  ['mixed case', 'ada@example.com', 'AdA@Example.COM'],
  ['a display name queued', 'Ada <ada@example.com>', 'ada@example.com'],
  ['an IDN domain in unicode, erased in punycode', 'ada@bücher.example', 'ada@xn--bcher-kva.example'],
  ['an IDN domain in punycode, erased in unicode with another case', 'ada@xn--bcher-kva.example', 'Ada@BÜCHER.example'],
]

describe('erasing a person', () => {
  for (const [label, stored, given] of CASES) {
    it(`takes a queued mail away through erase, with ${label}`, async () => {
      const mail = queued()

      await mail.enqueue({ to: stored, subject: 'S', text: 'hi' })
      expect(await mail.erase(given)).toBe(1)
      expect(await mail.drain()).toBe(0)
    })

    it(`takes a queued mail away through remove({ recipient }), with ${label}`, async () => {
      const mail = queued()

      await mail.enqueue({ to: stored, subject: 'S', text: 'hi' })
      expect(await mail.remove({ recipient: given })).toBe(1)
      expect(await mail.drain()).toBe(0)
    })
  }

  it('keeps the mail of somebody else', async () => {
    const mail = queued()

    await mail.enqueue({ to: 'bob@example.com', subject: 'S', text: 'hi' })
    expect(await mail.erase('ada@example.com')).toBe(0)
    expect(await mail.drain()).toBe(1)
  })

  it('matches a cc and a bcc too', async () => {
    const mail = queued()

    await mail.enqueue({ to: 'bob@example.com', cc: NFD, bcc: 'x@example.com', subject: 'S', text: 'hi' })
    expect(await mail.erase(NFC)).toBe(1)
  })
})
