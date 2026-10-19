import { createHmac, hkdfSync } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import { openText, sealText, sharedKey, signedText, signText, useStampSecret } from '../src/server/stamp'

const keyOf = (secret: string) => Buffer.from(hkdfSync('sha256', secret, '', 'kay stamps', 32))

describe('the keys signing and sealing', () => {
  it('sign as an HMAC-SHA256 of the use and text under the stamp key, and derive the shared key as one', () => {
    useStampSecret('first-secret-first-secret-first-secret', 'config')

    const key = keyOf('first-secret-first-secret-first-secret')

    expect(signText('use', 'text')).toBe(createHmac('sha256', key).update('use\0text').digest('base64url'))
    expect(signedText('use', 'text', signText('use', 'text'))).toBe(true)
    expect(signedText('use', 'other', signText('use', 'text'))).toBe(false)
    expect(sharedKey('rates')).toEqual(createHmac('sha256', key).update('kay-key\0rates').digest())
  })

  it('seal under a key per use, and follow a secret that changes', () => {
    useStampSecret('first-secret-first-secret-first-secret', 'config')

    const sealed = sealText('flash', 'hello')

    expect(openText('flash', sealed)).toBe('hello')
    expect(openText('other', sealed)).toBeUndefined()

    useStampSecret('second-secret-second-secret-second-sec', 'session')

    expect(openText('flash', sealed)).toBeUndefined()
    expect(sharedKey('rates')).toEqual(createHmac('sha256', keyOf('second-secret-second-secret-second-sec')).update('kay-key\0rates').digest())
    expect(openText('flash', sealText('flash', 'again'))).toBe('again')
  })
})
