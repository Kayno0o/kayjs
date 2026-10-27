import type { Assertion, AuthenticationResponseJSON, Expected, PublicKeyCredentialCreationOptionsJSON, RegisteredCredential, RegistrationResponseJSON } from '../src/webauthn'
import type { Algorithm } from './helpers/authenticator'
import type { Encodable } from './helpers/cbor'
import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'bun:test'
import { decodeCbor } from '../src/cbor'
import { authenticationOptions, registrationOptions, verifyAuthentication, verifyRegistration } from '../src/webauthn'
import { authenticator } from './helpers/authenticator'
import { encodeCbor } from './helpers/cbor'

// Recorded from @simplewebauthn/server 14.0.3 before kay verified passkeys itself: each answer, what it was checked against, and what the old library made of it, null for a refusal.
interface Vectors {
  options: {
    registration: { input: Parameters<typeof registrationOptions>[0], output: PublicKeyCredentialCreationOptionsJSON }
    signIn: { input: Parameters<typeof authenticationOptions>[0], output: ReturnType<typeof authenticationOptions> }
    allowed: { input: Parameters<typeof authenticationOptions>[0], output: ReturnType<typeof authenticationOptions> }
  }
  credentials: Record<string, { id: string, algorithm: Algorithm, rpId: string, userHandle: string, privateKey: JsonWebKey, publicKey: string }>
  registrations: { name: string, response: RegistrationResponseJSON, expected: Expected, result: RegisteredCredential | null }[]
  authentications: { name: string, response: AuthenticationResponseJSON, expected: Expected & { publicKey: string, counter: number }, result: Assertion | null }[]
}

const vectors = await Bun.file(`${import.meta.dir}/helpers/webauthnVectors.json`).json() as Vectors
const CHALLENGE = /^[\w-]{43}$/
const EXPECTED: Expected = { challenge: 'challenge', origins: ['https://site.test'], rpId: 'site.test', requireUserVerification: true }

describe('the verifier answers as @simplewebauthn/server did', () => {
  for (const { name, response, expected, result } of vectors.registrations) {
    test(`registration: ${name}`, async () => {
      expect(await verifyRegistration(response, expected)).toEqual(result ?? undefined)
    })
  }

  for (const { name, response, expected, result } of vectors.authentications) {
    test(`authentication: ${name}`, async () => {
      expect(await verifyAuthentication(response, expected, expected)).toEqual(result ?? undefined)
    })
  }
})

describe('options', () => {
  test('a registration offers the JSON the old library wrote, with a fresh challenge', () => {
    const { input, output } = vectors.options.registration
    const options = registrationOptions(input)

    expect(options.challenge).toMatch(CHALLENGE)
    expect(options.challenge).not.toBe(registrationOptions(input).challenge)
    expect({ ...options, challenge: '' }).toEqual({ ...output, challenge: '' })
  })

  test('a sign-in, with and without the passkeys it allows, offers the JSON the old library wrote', () => {
    for (const { input, output } of [vectors.options.signIn, vectors.options.allowed]) {
      const options = authenticationOptions(input)

      expect(options.challenge).toMatch(CHALLENGE)
      expect({ ...options, challenge: '' }).toEqual({ ...output, challenge: '' })
    }
  })
})

// A passkey registered on a fresh ES256 authenticator, and what the store keeps of it.
async function es256Passkey() {
  const device = authenticator()
  const request = registrationOptions({ rpName: 'Site', rpId: 'site.test', userName: 'ada', userId: 'u', exclude: [] })
  const registered = await verifyRegistration(await device.create(request), { ...EXPECTED, challenge: request.challenge })

  return { device, stored: { publicKey: registered!.publicKey, counter: 0 } }
}

describe('signatures', () => {
  // About one ES256 signature in 256 has an r below 2^248, which DER writes in 31 bytes.
  test('an ES256 signature whose r is shorter than 32 bytes verifies', async () => {
    const { device, stored } = await es256Passkey()
    let short: AuthenticationResponseJSON | undefined
    let counter = 0

    while (!short && counter < 5000) {
      const answer = await device.get({ challenge: 'challenge' }, { counter: ++counter })

      if (Buffer.from(answer.response.signature, 'base64url')[3]! < 32)
        short = answer
    }

    expect(await verifyAuthentication(short!, EXPECTED, stored)).toMatchObject({ counter })
  })

  test('a DER signature with bytes after it, or an r past 32 bytes, is refused', async () => {
    const { device, stored } = await es256Passkey()
    const answer = await device.get({ challenge: 'challenge' })
    const signature = Buffer.from(answer.response.signature, 'base64url')

    expect(await verifyAuthentication(answer, EXPECTED, stored)).toBeDefined()

    const trailing = Buffer.concat([signature, Buffer.from([0])])
    const r = signature.subarray(4, 4 + signature[3]!)
    const s = signature.subarray(4 + signature[3]!)
    const longR = Buffer.concat([Buffer.from([0x02, r.length + 1, 0]), r])
    const long = Buffer.concat([Buffer.from([0x30, longR.length + s.length]), longR, s])

    for (const broken of [trailing, long])
      expect(await verifyAuthentication({ ...answer, response: { ...answer.response, signature: broken.toString('base64url') } }, EXPECTED, stored)).toBeUndefined()
  })
})

describe('extensions', () => {
  const EXTENSIONS = new Map<string, Encodable>([['hmac-secret', true], ['credProtect', 2]])
  // UP, UV and ED, with AT for a registration.
  const ATTESTED_EXTENDED = 0x01 | 0x04 | 0x40 | 0x80

  test('a registration carrying extensions after its key is read past them, and nothing may follow them', async () => {
    const device = authenticator()
    const request = registrationOptions({ rpName: 'Site', rpId: 'site.test', userName: 'ada', userId: 'u', exclude: [] })
    const expected = { ...EXPECTED, challenge: request.challenge }

    expect(await verifyRegistration(await device.create(request, { extensions: EXTENSIONS }), expected)).toBeDefined()
    expect(await verifyRegistration(await device.create(request, { flags: ATTESTED_EXTENDED, extensions: new Map() }), expected)).toBeDefined()

    for (const answer of [{ extensions: EXTENSIONS, after: new Uint8Array([0]) }, { extensions: 7 }, { extensions: new Uint8Array(2) }, { extensions: [EXTENSIONS] }, { flags: ATTESTED_EXTENDED }, { flags: 0x01 | 0x04 | 0x40, extensions: EXTENSIONS }])
      expect(await verifyRegistration(await device.create(request, answer), expected)).toBeUndefined()
  })

  test('an assertion carrying extensions is read past them, and one claiming a new credential it does not carry is refused', async () => {
    const { device, stored } = await es256Passkey()

    expect(await verifyAuthentication(await device.get({ challenge: 'challenge' }, { extensions: EXTENSIONS }), EXPECTED, stored)).toBeDefined()

    for (const answer of [{ extensions: EXTENSIONS, after: new Uint8Array([0]) }, { extensions: 7 }, { flags: 0x01 | 0x04 | 0x80 }, { flags: 0x01 | 0x04, extensions: EXTENSIONS }, { flags: 0x01 | 0x04 | 0x40 }])
      expect(await verifyAuthentication(await device.get({ challenge: 'challenge' }, answer), EXPECTED, stored)).toBeUndefined()
  })
})

describe('a ceremony in a frame of another origin', () => {
  const ALGORITHMS: Algorithm[] = ['ES256', 'RS256', 'EdDSA', 'ML-DSA-44']
  const SAME_SITE = [{ crossOrigin: false }, { crossOrigin: undefined }]
  const CROSS_SITE = [{ crossOrigin: true }, { crossOrigin: 'true' }, { crossOrigin: 1 }, { crossOrigin: null }, { crossOrigin: undefined, topOrigin: 'https://other.test' }, { topOrigin: 'https://other.test' }, { topOrigin: '' }, { topOrigin: null }, { crossOrigin: true, topOrigin: 'https://other.test' }]

  for (const algorithm of ALGORITHMS) {
    test(`a ${algorithm} registration and sign-in pass when the client data says same-site or nothing, and are refused when it says cross-site or names a top origin`, async () => {
      const device = authenticator({ algorithm })
      const request = registrationOptions({ rpName: 'Site', rpId: 'site.test', userName: 'ada', userId: 'u', exclude: [] })
      const expected = { ...EXPECTED, challenge: request.challenge }

      for (const clientData of CROSS_SITE)
        expect(await verifyRegistration(await device.create(request, { clientData }), expected)).toBeUndefined()

      let stored: { publicKey: string, counter: number } | undefined

      for (const clientData of SAME_SITE) {
        const registered = await verifyRegistration(await device.create(request, { clientData }), expected)

        expect(registered).toBeDefined()
        stored = { publicKey: registered!.publicKey, counter: 0 }
      }

      const credential = device.credentials.at(-1)!.id

      for (const clientData of CROSS_SITE)
        expect(await verifyAuthentication(await device.get({ challenge: 'challenge' }, { credential, clientData }), EXPECTED, stored!)).toBeUndefined()

      for (const clientData of SAME_SITE)
        expect(await verifyAuthentication(await device.get({ challenge: 'challenge' }, { credential, clientData }), EXPECTED, stored!)).toBeDefined()
    })
  }
})

describe('the credential id a registration names', () => {
  for (const algorithm of ['ES256', 'RS256', 'EdDSA', 'ML-DSA-44'] satisfies Algorithm[]) {
    for (const format of ['none', 'packed'] as const) {
      test(`a ${algorithm} registration attested as ${format} is stored under its own id, and refused under any other`, async () => {
        const device = authenticator({ algorithm, format })
        const request = registrationOptions({ rpName: 'Site', rpId: 'site.test', userName: 'ada', userId: 'u', exclude: [] })
        const expected = { ...EXPECTED, challenge: request.challenge }
        const answer = await device.create(request)
        const raw = Buffer.from(answer.id, 'base64url')

        expect(await verifyRegistration(answer, expected)).toMatchObject({ id: answer.id })

        const others = [
          Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
          raw.subarray(0, 15).toString('base64url'),
          Buffer.concat([raw, Buffer.from([0])]).toString('base64url'),
          raw.toString('base64'),
          `${answer.id}==`,
        ]

        for (const id of others)
          expect(await verifyRegistration({ ...answer, id, rawId: id }, expected)).toBeUndefined()
      })
    }
  }
})

describe('hostile answers are refused, never thrown', () => {
  test('a registration missing parts, or with parts of the wrong type', async () => {
    const [{ response, expected }] = vectors.registrations as [Vectors['registrations'][number]]
    const attestation = decodeCbor(Buffer.from(response.response.attestationObject, 'base64url'))[0] as Map<string, Uint8Array>
    const withAuthData = (authData: Uint8Array) => encodeCbor(new Map<number | string, Encodable>([...attestation, ['authData', authData]])).toString('base64url')
    const authData = attestation.get('authData')!
    // The rpId hash, flags, counter and AAGUID, then the id's length, the 16-byte id and the key.
    const withId = (id: Uint8Array, key = authData.subarray(71)) => withAuthData(Buffer.concat([authData.subarray(0, 53), Buffer.from([id.length >> 8, id.length & 0xFF]), id, key]))
    const unoffered = encodeCbor(new Map<number | string, Encodable>([[1, 2], [3, -35], [-1, 2], [-2, new Uint8Array(48)], [-3, new Uint8Array(48)]]))

    const longest = Buffer.alloc(1023).toString('base64url')

    expect(await verifyRegistration({ ...response, response: { ...response.response, attestationObject: withAuthData(authData) } }, expected)).toBeDefined()
    expect(await verifyRegistration({ ...response, id: longest, rawId: longest, response: { ...response.response, attestationObject: withId(new Uint8Array(1023)) } }, expected)).toMatchObject({ id: longest })

    const broken: unknown[] = [
      { ...response, response: { ...response.response, attestationObject: withAuthData(Buffer.concat([authData, Buffer.from([0])])) } },
      { ...response, response: { ...response.response, attestationObject: withId(new Uint8Array(0)) } },
      { ...response, response: { ...response.response, attestationObject: withId(new Uint8Array(1024)) } },
      { ...response, response: { ...response.response, attestationObject: withId(new Uint8Array(16), unoffered) } },
      {},
      { ...response, rawId: 'other' },
      { ...response, type: 'password' },
      { ...response, response: { ...response.response, clientDataJSON: 'not json' } },
      { ...response, response: { ...response.response, clientDataJSON: Buffer.from('null').toString('base64url') } },
      { ...response, response: { ...response.response, attestationObject: 'a+b/' } },
      { ...response, response: { ...response.response, attestationObject: encodeCbor([1, 2]).toString('base64url') } },
      { ...response, response: { ...response.response, attestationObject: encodeCbor(new Map<number | string, Encodable>([['fmt', 'none'], ['attStmt', new Map<string, Encodable>()], ['authData', 'text']])).toString('base64url') } },
      { ...response, response: { ...response.response, attestationObject: encodeCbor(new Map<number | string, Encodable>([['fmt', 'none'], ['attStmt', new Map<string, Encodable>()], ['authData', new Uint8Array(36)]])).toString('base64url') } },
      { ...response, response: { ...response.response, transports: 7, clientDataJSON: 7 } },
    ]

    for (const answer of broken)
      expect(await verifyRegistration(answer as RegistrationResponseJSON, expected)).toBeUndefined()
  })

  test('an assertion missing parts, against a stored key that is no key', async () => {
    const { response, expected } = vectors.authentications[0]!

    expect(await verifyAuthentication(response, expected, expected)).toBeDefined()

    // The passkey's own P-256 key, labelled with another curve.
    const own = decodeCbor(Buffer.from(expected.publicKey, 'base64url'))[0] as Map<number, Uint8Array | number>
    const relabelled = encodeCbor(new Map<number | string, Encodable>([...own, [-1, 2]])).toString('base64url')

    for (const publicKey of ['', 'AAAA', relabelled, encodeCbor(new Map<number | string, Encodable>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(31)], [-3, new Uint8Array(32)]])).toString('base64url'), encodeCbor(new Map<number | string, Encodable>([[1, 2], [3, -35]])).toString('base64url')])
      expect(await verifyAuthentication(response, expected, { publicKey, counter: 0 })).toBeUndefined()

    for (const part of [{ signature: '' }, { authenticatorData: 'not base64url!' }, { clientDataJSON: Buffer.from('{"type":"webauthn.get"}').toString('base64url') }, { signature: 12 }])
      expect(await verifyAuthentication({ ...response, response: { ...response.response, ...part } } as AuthenticationResponseJSON, expected, expected)).toBeUndefined()
  })
})

describe('the CBOR decoder', () => {
  test('reads what WebAuthn writes, and says where it ends', () => {
    const bytes = encodeCbor(new Map<number | string, never>([[1, 2 as never], [-3, new Uint8Array([1, 2]) as never], ['fmt', 'none' as never], ['list', [true, false, 70000] as never]]))

    expect(decodeCbor(Buffer.concat([bytes, Buffer.from([0xFF])]))).toEqual([new Map<number | string, unknown>([[1, 2], [-3, new Uint8Array([1, 2])], ['fmt', 'none'], ['list', [true, false, 70000]]]) as never, bytes.length])
  })

  test('refuses indefinite lengths, tags, floats, repeated or odd keys, deep nesting and lengths past the end', () => {
    const hostile = [
      [0x5F, 0x41, 0x00, 0xFF],
      [0xC2, 0x41, 0x01],
      [0xF9, 0x3C, 0x00],
      [0xA2, 0x01, 0x01, 0x01, 0x02],
      [0xA1, 0x41, 0x00, 0x01],
      [...Array.from({ length: 40 }).fill(0x81) as number[], 0x01],
      [0x5A, 0xFF, 0xFF, 0xFF, 0xFF],
      [0x9B, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
      [0x1B, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
      [0x62, 0xC3, 0x28],
      [0x18],
      [],
    ]

    for (const bytes of hostile)
      expect(() => decodeCbor(new Uint8Array(bytes))).toThrow()
  })
})
