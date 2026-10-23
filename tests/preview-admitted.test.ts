import { createHmac } from 'node:crypto'
import { beforeEach, expect, test } from 'bun:test'
import { admitEditSession, editSessionAdmitted } from '../src/server/library'
import { enterPreview, previewRequested, setupPreview } from '../src/server/preview'

const SECRET = 'a-secret-long-enough-for-the-preview-cookie-0123456789'

beforeEach(() => {
  setupPreview({ secret: SECRET }, '')
})

// Enters edit mode over `url`, and gives the edit cookie, the admitted cookie when `admit`, and the cookie header the browser sends next.
function enter(url: string, admit: boolean): { edit: string, admitted: string | undefined, header: string } {
  const cookies = new Bun.CookieMap()
  const request = new Request(url)
  const edit = enterPreview({ cookies, request }, { edit: true })

  if (admit)
    admitEditSession({ cookies, request }, edit)

  const jar = cookies.toSetCookieHeaders().map(header => header.slice(0, header.indexOf(';')))
  const admitted = jar.find(pair => pair.includes('kay_preview_admitted='))

  return { edit, admitted: admitted?.slice(admitted.indexOf('=') + 1), header: jar.join('; ') }
}

const asked = (header: string, url = 'http://localhost/') => new Request(url, { headers: { cookie: header } })

test('an edit cookie is admitted only by the admitted cookie signed for it', () => {
  const holder = enter('http://localhost/', false)
  const member = enter('http://localhost/', true)

  // As after a restart: the process remembers nothing, and the cookies alone tell.
  setupPreview({ secret: SECRET }, '')
  expect(editSessionAdmitted(asked(holder.header))).toBe(false)
  expect(editSessionAdmitted(asked(member.header))).toBe(true)
  expect(editSessionAdmitted(asked(`kay_preview=${holder.edit}; kay_preview_admitted=${member.admitted}`))).toBe(false)
  expect(editSessionAdmitted(asked(`kay_preview=${member.edit}; kay_preview_admitted=${member.admitted}x`))).toBe(false)
  expect(editSessionAdmitted(asked(`kay_preview_admitted=${member.admitted}`))).toBe(false)
})

test('the admitted cookie goes out and is read under the names of the scheme', () => {
  const member = enter('https://localhost/', true)

  setupPreview({ secret: SECRET }, '')
  expect(member.header).toContain('__Host-kay_preview_admitted=')
  expect(editSessionAdmitted(asked(member.header, 'https://localhost/'))).toBe(true)
  expect(editSessionAdmitted(asked(member.header.replaceAll('__Host-', ''), 'https://localhost/'))).toBe(false)
})

test('an edit cookie from before the nonce is in edit mode but never admitted, as two of them issued in one second are the same', () => {
  const until = String(Math.floor(Date.now() / 1000) + 600)
  const old = `${until}.edit.${createHmac('sha256', SECRET).update(`cookie\n${until}\nedit`).digest('base64url')}`
  const request = asked(`kay_preview=${old}`)
  const cookies = new Bun.CookieMap()

  expect(previewRequested(request)).toBe('edit')
  admitEditSession({ cookies, request })
  admitEditSession({ cookies, request }, old)
  expect(cookies.toSetCookieHeaders()).toEqual([])
  expect(editSessionAdmitted(request)).toBe(false)
})

test('admitting refuses a value that is no valid edit cookie, a preview cookie included', () => {
  const cookies = new Bun.CookieMap()
  const request = new Request('http://localhost/')

  admitEditSession({ cookies, request }, 'forged')
  admitEditSession({ cookies, request }, `${Math.floor(Date.now() / 1000) + 600}.edit.${'0'.repeat(32)}.nope`)
  expect(cookies.toSetCookieHeaders()).toEqual([])
})

test('a request that carries the edit cookie alone is told once this process has admitted it, which an open stream needs', () => {
  const holder = enter('http://localhost/', false)
  const request = asked(holder.header)

  expect(editSessionAdmitted(request)).toBe(false)
  admitEditSession({ cookies: new Bun.CookieMap(), request: new Request('http://localhost/') }, holder.edit)
  expect(editSessionAdmitted(request)).toBe(true)
})
