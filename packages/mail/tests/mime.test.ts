import { describe, expect, it } from 'bun:test'
import { parseMime, replyOf } from '../src/mime'

const CRLF = '\r\n'

// A reply with one attachment whose Content-Disposition (and optional Content-Type) lines are given.
function namesOf(...lines: string[]): string[] {
  const message = ['From: a@example.com', 'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'hi', '--B', ...lines, 'Content-Transfer-Encoding: base64', '', Buffer.from('x').toString('base64'), '--B--', ''].join(CRLF)

  return replyOf(parseMime(new TextEncoder().encode(message))).attachments.map(entry => entry.filename)
}

const name = (disposition: string, type = 'application/pdf'): string => namesOf(`Content-Type: ${type}`, `Content-Disposition: ${disposition}`)[0]!

describe('attachment names', () => {
  it('reads a plain, quoted or bare name', () => {
    expect(name('attachment; filename="devis.pdf"')).toBe('devis.pdf')
    expect(name('attachment; filename=devis.pdf')).toBe('devis.pdf')
  })

  it('splits parameters outside quotes only', () => {
    expect(name('attachment; filename="a; b=c.pdf"; size=3')).toBe('a; b=c.pdf')
    expect(name('attachment; filename="say \\"hi\\".pdf"')).toBe('say "hi".pdf')
  })

  it('decodes RFC 2231 extended and continued names', () => {
    expect(name('attachment; filename*=utf-8\'\'d%C3%A9j%C3%A0%20vu.pdf')).toBe('déjà vu.pdf')
    expect(name('attachment; filename*=iso-8859-1\'fr\'caf%E9.pdf')).toBe('café.pdf')
    expect(name('attachment; filename*0="long na"; filename*1="me.pdf"')).toBe('long name.pdf')
    expect(name('attachment; filename*0*=utf-8\'\'caf%C3%A9; filename*1*=%20noir; filename*2=".pdf"')).toBe('café noir.pdf')
  })

  it('prefers the extended name over the plain one', () => {
    expect(name('attachment; filename="fallback.pdf"; filename*=utf-8\'\'r%C3%A9el.pdf')).toBe('réel.pdf')
  })

  it('decodes RFC 2047 encoded words, in Content-Type name too', () => {
    expect(name('attachment; filename="=?UTF-8?B?ZMOpasOgLnBkZg==?="')).toBe('déjà.pdf')
    expect(name('attachment; filename="=?utf-8?Q?caf=C3=A9_noir.pdf?="')).toBe('café noir.pdf')
    expect(namesOf('Content-Type: application/pdf; name="=?UTF-8?B?ZMOpasOgLnBkZg==?="')).toEqual(['déjà.pdf'])
  })

  it('keeps a bare file name, never a path', () => {
    expect(name('attachment; filename="../../etc/passwd"')).toBe('passwd')
    expect(name('attachment; filename="/etc/cron.d/x"')).toBe('x')
    expect(name('attachment; filename="C:\\Users\\me\\devis.pdf"')).toBe('devis.pdf')
    expect(name('attachment; filename="..\\..\\boot.ini"')).toBe('boot.ini')
    expect(name('attachment; filename*=utf-8\'\'..%2F..%2Fsecret.txt')).toBe('secret.txt')
    expect(name('attachment; filename="=?utf-8?Q?=2E=2E=2Fx.pdf?="')).toBe('x.pdf')
  })

  it('drops NUL and control characters', () => {
    expect(name('attachment; filename*=utf-8\'\'a%00b%0D%0A.pdf')).toBe('ab.pdf')
  })

  it('falls back to "attachment" for an empty or dot-only name', () => {
    expect(name('attachment; filename=""')).toBe('attachment')
    expect(name('attachment; filename="/"')).toBe('attachment')
    expect(name('attachment; filename=".."')).toBe('attachment')
    expect(name('attachment; filename="../"')).toBe('attachment')
    expect(name('attachment; filename*=utf-8\'\'%00')).toBe('attachment')
  })

  it('survives a malformed extended value', () => {
    expect(name('attachment; filename*=nonsense')).toBe('nonsense')
    expect(name('attachment; filename*=bogus-charset\'\'a%ZZb.pdf')).toBe('a%ZZb.pdf')
  })
})
