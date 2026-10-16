import { afterEach, describe, expect, test } from 'bun:test'
import { ActionError } from 'kay'
import { askPasskey, canAskPasskey, canMakePasskey, makePasskey, passkeyFailure } from '../src/browser'

const REQUEST = { challenge: 'c', rpId: 'localhost', userVerification: 'preferred' } as const
const CREATION = { challenge: 'c', rp: { name: 'Site' }, user: { id: 'u', name: 'ada', displayName: 'Ada' }, pubKeyCredParams: [] }

const original = { credential: Reflect.get(globalThis, 'PublicKeyCredential'), navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') }

// A browser whose passkey prompt answers with `json`, or with nothing when it is null.
function browser(json: unknown) {
  const calls: Record<string, unknown>[] = []

  class FakeCredential {
    static parseRequestOptionsFromJSON(options: unknown) {
      return options
    }

    static parseCreationOptionsFromJSON(options: unknown) {
      return options
    }

    toJSON() {
      return json
    }
  }

  const answer = async (options: Record<string, unknown>) => {
    calls.push(options)

    return json === null ? null : new FakeCredential()
  }

  Reflect.set(globalThis, 'PublicKeyCredential', FakeCredential)
  Object.defineProperty(globalThis, 'navigator', { value: { credentials: { get: answer, create: answer } }, configurable: true })

  return calls
}

afterEach(() => {
  Reflect.set(globalThis, 'PublicKeyCredential', original.credential)

  if (original.navigator)
    Object.defineProperty(globalThis, 'navigator', original.navigator)
})

describe('the passkey helpers an island calls', () => {
  test('a browser with no WebAuthn JSON methods can neither ask for nor make a passkey', () => {
    Reflect.set(globalThis, 'PublicKeyCredential', undefined)

    expect([canAskPasskey(), canMakePasskey()]).toEqual([false, false])

    browser({})

    expect([canAskPasskey(), canMakePasskey()]).toEqual([true, true])
  })

  test('an answer with the signature a sign-in reads goes through, and one without it is no answer', async () => {
    const signed = { id: 'a', rawId: 'a', type: 'public-key' as const, clientExtensionResults: {}, response: { clientDataJSON: 'x', authenticatorData: 'y', signature: 'z' } }

    browser(signed)

    expect(await askPasskey(REQUEST)).toEqual(signed)

    browser({ id: 'a', response: { clientDataJSON: 'x' } })

    expect(await askPasskey(REQUEST)).toBeNull()
    expect(await makePasskey(CREATION)).toBeNull()
  })

  test('an answer with the attestation a registration reads goes through, and none picked is null', async () => {
    const made = { id: 'a', rawId: 'a', type: 'public-key' as const, clientExtensionResults: {}, response: { clientDataJSON: 'x', attestationObject: 'y' } }

    browser(made)

    expect(await makePasskey(CREATION)).toEqual(made)

    browser(null)

    expect(await makePasskey(CREATION)).toBeNull()
    expect(await askPasskey(REQUEST)).toBeNull()
  })

  test('autofill asks the browser for a conditional prompt, and a plain call does not', async () => {
    const calls = browser({ response: { signature: 's' } })
    const controller = new AbortController()

    await askPasskey(REQUEST)
    await askPasskey(REQUEST, { autofill: true, signal: controller.signal })

    expect(calls[0]).not.toHaveProperty('mediation')
    expect(calls[1]).toMatchObject({ mediation: 'conditional', signal: controller.signal })
  })

  test('what threw is told by the code an action refused with, nothing for a dismissed prompt, else the generic message', () => {
    const errors = { 'wrong-password': 'Wrong password' }
    const refused = (error: string) => new ActionError(400, '', {}, { error })

    expect(passkeyFailure(refused('wrong-password'), errors, 'Failed')).toBe('Wrong password')
    expect(passkeyFailure(refused('other'), errors, 'Failed')).toBe('Failed')
    // A code naming something of every object is no message.
    expect(passkeyFailure(refused('toString'), errors, 'Failed')).toBe('Failed')
    expect(passkeyFailure(new ActionError(422, ''), errors, 'Failed')).toBe('Failed')
    expect(passkeyFailure(new DOMException('', 'NotAllowedError'), errors, 'Failed')).toBe('')
    expect(passkeyFailure(new DOMException('', 'AbortError'), errors, 'Failed')).toBe('Failed')
    expect(passkeyFailure(new Error('boom'), errors, 'Failed')).toBe('Failed')
  })
})
