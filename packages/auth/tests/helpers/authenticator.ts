import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '../../src/webauthn'
import type { Encodable } from './cbor'
import { Buffer } from 'node:buffer'
import { encodeCbor } from './cbor'

const ORIGIN = 'https://site.test'
const USER_PRESENT = 0x01
const USER_VERIFIED = 0x04
const BACKUP_ELIGIBLE = 0x08
const BACKED_UP = 0x10
const ATTESTED = 0x40

export type Algorithm = 'ES256' | 'RS256' | 'EdDSA' | 'ML-DSA-44'

// How each algorithm's keys are made and sign, and its COSE key as an authenticator writes it.
const ALGORITHMS: Record<Algorithm, { generate: AlgorithmIdentifier | RsaHashedKeyGenParams | EcKeyGenParams, sign: AlgorithmIdentifier | EcdsaParams, cose: (jwk: JsonWebKey) => Map<number, Encodable> }> = {
  'ES256': {
    generate: { name: 'ECDSA', namedCurve: 'P-256' },
    sign: { name: 'ECDSA', hash: 'SHA-256' },
    cose: jwk => new Map<number, Encodable>([[1, 2], [3, -7], [-1, 1], [-2, bytes(jwk.x)], [-3, bytes(jwk.y)]]),
  },
  'RS256': {
    generate: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    sign: { name: 'RSASSA-PKCS1-v1_5' },
    cose: jwk => new Map<number, Encodable>([[1, 3], [3, -257], [-1, bytes(jwk.n)], [-2, bytes(jwk.e)]]),
  },
  'EdDSA': {
    generate: { name: 'Ed25519' },
    sign: { name: 'Ed25519' },
    cose: jwk => new Map<number, Encodable>([[1, 1], [3, -8], [-1, 6], [-2, bytes(jwk.x)]]),
  },
  'ML-DSA-44': {
    generate: 'ML-DSA-44',
    sign: 'ML-DSA-44',
    cose: jwk => new Map<number, Encodable>([[1, 7], [3, -48], [-1, bytes((jwk as { pub?: string }).pub)]]),
  },
}
const COSE_ALG: Record<Algorithm, number> = { 'ES256': -7, 'RS256': -257, 'EdDSA': -8, 'ML-DSA-44': -48 }

export interface Credential {
  id: string
  algorithm: Algorithm
  keys: CryptoKeyPair
  rpId: string
  userHandle: string
  counter: number
}

// How one answer departs from an honest one: another challenge or rpId, user verification left out, its flags byte replaced, or fields of its client data overridden.
export interface Answer {
  userVerified?: boolean
  challenge?: string
  rpId?: string
  flags?: number
  clientData?: Record<string, unknown>
}

export interface AuthenticatorOptions {
  origin?: string
  // Whether its passkeys sync, setting the BE and BS flags.
  synced?: boolean
  algorithm?: Algorithm
  // The attestation it answers a registration with; `packed` is a self attestation, signed by the new key.
  format?: 'none' | 'packed'
  // false for one that keeps no signature counter and always sends 0.
  counting?: boolean
}

// A software authenticator, answering ceremonies as a browser would hand them to the server.
export function authenticator(options: AuthenticatorOptions = {}) {
  const origin = options.origin ?? ORIGIN
  const algorithm = options.algorithm ?? 'ES256'
  const counting = options.counting ?? true
  const credentials: Credential[] = []

  return {
    credentials,
    async create(request: PublicKeyCredentialCreationOptionsJSON, answer: Answer = {}): Promise<RegistrationResponseJSON> {
      const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
      const keys = await crypto.subtle.generateKey(ALGORITHMS[algorithm].generate, true, ['sign', 'verify']) as CryptoKeyPair
      const cose = ALGORITHMS[algorithm].cose(await crypto.subtle.exportKey('jwk', keys.publicKey))
      const credentialRpId = request.rp.id!
      const rawId = Buffer.from(id, 'base64url')
      const authData = Buffer.concat([
        await rpIdHash(answer.rpId ?? credentialRpId),
        Buffer.from([answer.flags ?? (flags(answer.userVerified ?? true, options.synced) | ATTESTED)]),
        counterBytes(0),
        Buffer.alloc(16),
        Buffer.from([rawId.length >> 8, rawId.length & 0xFF]),
        rawId,
        encodeCbor(cose),
      ])
      const clientDataJSON = clientData({ type: 'webauthn.create', challenge: answer.challenge ?? request.challenge, origin, ...answer.clientData })
      const statement = options.format === 'packed'
        ? new Map<string, Encodable>([['alg', COSE_ALG[algorithm]], ['sig', await sign(algorithm, keys.privateKey, authData, clientDataJSON)]])
        : new Map<string, Encodable>()
      const attestation = encodeCbor(new Map<string, Encodable>([['fmt', options.format ?? 'none'], ['attStmt', statement], ['authData', authData]]))

      credentials.push({ id, algorithm, keys, rpId: credentialRpId, userHandle: request.user.id, counter: 0 })

      return {
        id,
        rawId: id,
        type: 'public-key',
        response: { clientDataJSON, attestationObject: attestation.toString('base64url'), transports: ['internal'] },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      }
    },
    // Signs `request` with the credential it allows, or the first held; `counter` forces the signature counter, as a cloned authenticator would send.
    async get(request: PublicKeyCredentialRequestOptionsJSON, { credential, counter, ...answer }: Answer & { credential?: string, counter?: number } = {}): Promise<AuthenticationResponseJSON> {
      const allowed = request.allowCredentials?.map(entry => entry.id) ?? []
      const held = credentials.find(entry => entry.id === credential || (credential === undefined && (allowed.length === 0 || allowed.includes(entry.id))))

      if (!held)
        throw new Error('no credential for this request')

      held.counter = counter ?? (counting ? held.counter + 1 : 0)

      const authData = Buffer.concat([await rpIdHash(answer.rpId ?? held.rpId), Buffer.from([answer.flags ?? flags(answer.userVerified ?? true, options.synced)]), counterBytes(held.counter)])
      const clientDataJSON = clientData({ type: 'webauthn.get', challenge: answer.challenge ?? request.challenge, origin, ...answer.clientData })

      return {
        id: held.id,
        rawId: held.id,
        type: 'public-key',
        response: {
          clientDataJSON,
          authenticatorData: authData.toString('base64url'),
          signature: (await sign(held.algorithm, held.keys.privateKey, authData, clientDataJSON)).toString('base64url'),
          userHandle: held.userHandle,
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      }
    },
    // Takes over a credential made elsewhere, from its private key as a JWK.
    async adopt(credential: Omit<Credential, 'keys'> & { privateKey: JsonWebKey }): Promise<void> {
      const { privateKey, ...rest } = credential
      const key = await crypto.subtle.importKey('jwk', privateKey, ALGORITHMS[credential.algorithm].generate, true, ['sign'])

      credentials.push({ ...rest, keys: { privateKey: key, publicKey: key } })
    },
  }
}

// What an authenticator signs, authData then the hash of the client data, DER-wrapped for ECDSA as WebAuthn carries it.
async function sign(algorithm: Algorithm, key: CryptoKey, authData: Buffer, clientDataJSON: string): Promise<Buffer> {
  const signed = Buffer.concat([authData, Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(clientDataJSON, 'base64url')))])
  const signature = new Uint8Array(await crypto.subtle.sign(ALGORITHMS[algorithm].sign, key, signed))

  return algorithm === 'ES256' ? der(signature) : Buffer.from(signature)
}

function bytes(base64url: string | undefined): Buffer {
  return Buffer.from(base64url!, 'base64url')
}

function flags(userVerified: boolean, synced = false): number {
  return USER_PRESENT | (userVerified ? USER_VERIFIED : 0) | (synced ? BACKUP_ELIGIBLE | BACKED_UP : 0)
}

async function rpIdHash(rpId: string): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(rpId)))
}

function counterBytes(counter: number): Buffer {
  const bytes = Buffer.alloc(4)

  bytes.writeUInt32BE(counter)

  return bytes
}

function clientData(fields: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ crossOrigin: false, ...fields })).toString('base64url')
}

// WebCrypto signs as r and s side by side; WebAuthn carries them DER-encoded.
function der(signature: Uint8Array): Buffer {
  const integer = (bytes: Uint8Array) => {
    let start = 0

    while (start < bytes.length - 1 && bytes[start] === 0)
      start++

    const trimmed = bytes.subarray(start)
    const padded = trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : Buffer.from(trimmed)

    return Buffer.concat([Buffer.from([0x02, padded.length]), padded])
  }
  const body = Buffer.concat([integer(signature.subarray(0, 32)), integer(signature.subarray(32))])

  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}
