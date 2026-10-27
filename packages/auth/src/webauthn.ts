import type { CborMap } from './cbor'
import { Buffer } from 'node:buffer'
import { decodeCbor } from './cbor'

// The WebAuthn half of passkeys, on Web Crypto: the options a ceremony hands the browser, and the checks of what the authenticator answers.

export type Requirement = 'required' | 'preferred' | 'discouraged'

export interface CredentialDescriptorJSON {
  id: string
  type: 'public-key'
  transports?: string[]
}

// The options for `navigator.credentials.create`, as `PublicKeyCredential.parseCreationOptionsFromJSON` reads them.
export interface PublicKeyCredentialCreationOptionsJSON {
  rp: { name: string, id?: string }
  user: { id: string, name: string, displayName: string }
  challenge: string
  pubKeyCredParams: { alg: number, type: 'public-key' }[]
  timeout?: number
  excludeCredentials?: CredentialDescriptorJSON[]
  authenticatorSelection?: { authenticatorAttachment?: 'platform' | 'cross-platform', requireResidentKey?: boolean, residentKey?: Requirement, userVerification?: Requirement }
  hints?: ('hybrid' | 'security-key' | 'client-device')[]
  attestation?: 'none' | 'indirect' | 'direct' | 'enterprise'
  extensions?: { credProps?: boolean }
}

// The options for `navigator.credentials.get`, as `PublicKeyCredential.parseRequestOptionsFromJSON` reads them.
export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string
  timeout?: number
  rpId?: string
  allowCredentials?: CredentialDescriptorJSON[]
  userVerification?: Requirement
  hints?: ('hybrid' | 'security-key' | 'client-device')[]
}

interface CredentialJSON<Response> {
  id: string
  rawId: string
  type: 'public-key'
  response: Response
  authenticatorAttachment?: 'platform' | 'cross-platform'
  clientExtensionResults: Record<string, unknown>
}

// A new passkey as `credential.toJSON()` writes it.
export type RegistrationResponseJSON = CredentialJSON<{ clientDataJSON: string, attestationObject: string, authenticatorData?: string, transports?: string[], publicKeyAlgorithm?: number, publicKey?: string }>

// A passkey's signature as `credential.toJSON()` writes it.
export type AuthenticationResponseJSON = CredentialJSON<{ clientDataJSON: string, authenticatorData: string, signature: string, userHandle?: string }>

// What an answer must match: the challenge parked for it, one of the site's origins, its rpId, and whether the user had to be verified.
export interface Expected {
  challenge: string
  origins: string[]
  rpId: string
  requireUserVerification: boolean
}

// A passkey a registration made: its COSE public key is base64url, as the store keeps it.
export interface RegisteredCredential {
  id: string
  publicKey: string
  counter: number
  transports: string[]
  multiDevice: boolean
  backedUp: boolean
  userVerified: boolean
}

export interface Assertion {
  counter: number
  multiDevice: boolean
  backedUp: boolean
  userVerified: boolean
}

const TIMEOUT_MS = 60_000
// The COSE algorithms a new passkey may use, in the order offered: ML-DSA-44, EdDSA, ES256, RS256.
const ALGORITHMS = [-48, -8, -7, -257]
const BASE64URL = /^[\w-]*={0,2}$/
const UTF8 = new TextDecoder('utf-8', { fatal: true })
// The authenticator data's flags: user present, user verified, backup eligible, backed up, attested credential data, extensions.
const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40
const ED = 0x80
const CREDENTIAL_ID_MAX = 1023

// Kept on the authenticator, so it signs in without a name typed first. Signing in requires user verification, so a passkey made without it would count as a way in and never open.
export function registrationOptions(options: { rpName: string, rpId: string, userName: string, userId: string, exclude: { id: string, transports: string[] }[] }): PublicKeyCredentialCreationOptionsJSON {
  return {
    challenge: newChallenge(),
    rp: { name: options.rpName, id: options.rpId },
    user: { id: Buffer.from(options.userId).toString('base64url'), name: options.userName, displayName: '' },
    pubKeyCredParams: ALGORITHMS.map(alg => ({ alg, type: 'public-key' })),
    timeout: TIMEOUT_MS,
    attestation: 'none',
    excludeCredentials: options.exclude.map(({ id, transports }) => ({ id, transports, type: 'public-key' })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required', requireResidentKey: true },
    extensions: { credProps: true },
    hints: [],
  }
}

// With no `allow`, the browser offers every passkey it holds for the site.
export function authenticationOptions(options: { rpId: string, allow?: { id: string, transports: string[] }[], userVerification: Requirement }): PublicKeyCredentialRequestOptionsJSON {
  return {
    rpId: options.rpId,
    challenge: newChallenge(),
    ...options.allow && { allowCredentials: options.allow.map(({ id, transports }) => ({ id, transports, type: 'public-key' })) },
    timeout: TIMEOUT_MS,
    userVerification: options.userVerification,
  }
}

// The passkey `response` makes, when it answers `expected`; undefined for any answer that does not. The attestation is not read: kay asks for none and trusts no attestation root, and every sign-in proves the key itself. It is still decoded, so one holding a CBOR tag or float refuses the registration.
export async function verifyRegistration(response: RegistrationResponseJSON, expected: Expected): Promise<RegisteredCredential | undefined> {
  try {
    if (!credentialHolds(response) || !clientDataHolds(response.response.clientDataJSON, 'webauthn.create', expected))
      return undefined

    const [attestation] = decodeCbor(fromBase64url(response.response.attestationObject))
    const authData = attestation instanceof Map ? attestation.get('authData') : undefined

    if (!(attestation instanceof Map) || !(authData instanceof Uint8Array) || typeof attestation.get('fmt') !== 'string' || !(attestation.get('attStmt') instanceof Map))
      return undefined

    const data = parseAuthData(authData)

    if (!data.credential || !(await flagsHold(data, expected)))
      return undefined

    // A key of an algorithm not offered, or that Web Crypto cannot import, could never sign in, so it throws here rather than being stored.
    await importCoseKey(data.credential.publicKey)

    return {
      id: Buffer.from(data.credential.id).toString('base64url'),
      publicKey: Buffer.from(data.credential.publicKey).toString('base64url'),
      counter: data.counter,
      transports: response.response.transports ?? [],
      multiDevice: data.backupEligible,
      backedUp: data.backedUp,
      userVerified: data.userVerified,
    }
  }
  catch {
    return undefined
  }
}

// What `response` asserts, when it answers `expected` and is signed by `stored`'s key past its counter; undefined for any answer that does not.
export async function verifyAuthentication(response: AuthenticationResponseJSON, expected: Expected, stored: { publicKey: string, counter: number }): Promise<Assertion | undefined> {
  try {
    const clientData = credentialHolds(response) ? clientDataHolds(response.response.clientDataJSON, 'webauthn.get', expected) : undefined

    // An assertion made in a frame of another site names that site; kay expects none.
    if (!clientData || clientData.topOrigin !== undefined)
      return undefined

    const authData = fromBase64url(response.response.authenticatorData)
    const data = parseAuthData(authData)

    if (!(await flagsHold(data, expected)))
      return undefined

    // An authenticator that counts must count past the stored value; one going back, or standing still, is the sign of a cloned key. One that never counts sends 0 every time.
    if ((data.counter > 0 || stored.counter > 0) && data.counter <= stored.counter)
      return undefined

    const key = await importCoseKey(fromBase64url(stored.publicKey))
    const signed = Buffer.concat([authData, await sha256(fromBase64url(response.response.clientDataJSON))])
    const signature = fromBase64url(response.response.signature)

    if (!(await crypto.subtle.verify(key.verify, key.key, key.alg === -7 ? rawEcdsa(signature) : signature, signed)))
      return undefined

    return { counter: data.counter, multiDevice: data.backupEligible, backedUp: data.backedUp, userVerified: data.userVerified }
  }
  catch {
    return undefined
  }
}

function newChallenge(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
}

function credentialHolds(response: RegistrationResponseJSON | AuthenticationResponseJSON): boolean {
  return typeof response.id === 'string' && response.id !== '' && response.id === response.rawId && response.type === 'public-key'
}

// The client data the browser wrote, when it is of the ceremony's `type`, carries the parked challenge and comes from one of the site's origins.
function clientDataHolds(encoded: string, type: string, expected: Expected): Record<string, unknown> | undefined {
  const clientData: unknown = JSON.parse(UTF8.decode(fromBase64url(encoded)))

  if (typeof clientData !== 'object' || clientData === null)
    return undefined

  const fields = clientData as Record<string, unknown>

  return fields.type === type && fields.challenge === expected.challenge && typeof fields.origin === 'string' && expected.origins.includes(fields.origin) ? fields : undefined
}

interface AuthData {
  rpIdHash: Uint8Array
  userPresent: boolean
  userVerified: boolean
  backupEligible: boolean
  backedUp: boolean
  counter: number
  credential?: { id: Uint8Array, publicKey: Uint8Array }
}

// The authenticator data: the rpId's hash, the flags, the counter, then the new credential when AT is set and the extensions when ED is, nothing left after them.
function parseAuthData(bytes: Uint8Array): AuthData {
  if (bytes.length < 37)
    throw new Error('authenticator data cut short')

  const flags = bytes[32]!
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 37
  let credential: AuthData['credential']

  if (flags & AT) {
    // 16 bytes of AAGUID, then the credential id's length and the id.
    const idLength = view.getUint16(offset + 16)
    const idStart = offset + 18

    if (idLength === 0 || idLength > CREDENTIAL_ID_MAX || idStart + idLength > bytes.length)
      throw new Error('invalid credential id')

    const [, keyEnd] = decodeCbor(bytes, idStart + idLength)

    credential = { id: bytes.slice(idStart, idStart + idLength), publicKey: bytes.slice(idStart + idLength, keyEnd) }
    offset = keyEnd
  }

  if (flags & ED) {
    const [extensions, end] = decodeCbor(bytes, offset)

    if (!(extensions instanceof Map))
      throw new Error('invalid extensions')

    offset = end
  }

  if (offset !== bytes.length)
    throw new Error('bytes left after the authenticator data')

  return {
    rpIdHash: bytes.subarray(0, 32),
    userPresent: (flags & UP) !== 0,
    userVerified: (flags & UV) !== 0,
    backupEligible: (flags & BE) !== 0,
    backedUp: (flags & BS) !== 0,
    counter: view.getUint32(33),
    ...credential && { credential },
  }
}

// The authenticator signed for the site's rpId, with the user present, verified when asked, and backed up only when it may be.
async function flagsHold(data: AuthData, expected: Expected): Promise<boolean> {
  return Buffer.from(await sha256(Buffer.from(expected.rpId))).equals(data.rpIdHash)
    && data.userPresent
    && (data.userVerified || !expected.requireUserVerification)
    && (data.backupEligible || !data.backedUp)
}

interface CoseKey {
  alg: number
  key: CryptoKey
  verify: AlgorithmIdentifier | EcdsaParams
}

// A COSE public key as Web Crypto verifies with it, for ES256, RS256, EdDSA (Ed25519) and ML-DSA-44; any other key, or one whose parts do not fit its algorithm, throws.
async function importCoseKey(bytes: Uint8Array): Promise<CoseKey> {
  const [cose] = decodeCbor(bytes)

  if (!(cose instanceof Map))
    throw new Error('COSE key is not a map')

  const kty = cose.get(1)
  const alg = cose.get(3)

  if (alg === -7 && kty === 2 && cose.get(-1) === 1) {
    const jwk = { kty: 'EC', crv: 'P-256', x: part(cose, -2, 32), y: part(cose, -3, 32) }

    return { alg, key: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']), verify: { name: 'ECDSA', hash: 'SHA-256' } }
  }

  if (alg === -257 && kty === 3) {
    const jwk = { kty: 'RSA', alg: 'RS256', n: part(cose, -1), e: part(cose, -2) }

    return { alg, key: await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']), verify: 'RSASSA-PKCS1-v1_5' }
  }

  if (alg === -8 && kty === 1 && cose.get(-1) === 6) {
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: part(cose, -2, 32) }

    return { alg, key: await crypto.subtle.importKey('jwk', jwk, 'Ed25519', false, ['verify']), verify: 'Ed25519' }
  }

  if (alg === -48 && kty === 7) {
    const jwk = { kty: 'AKP', alg: 'ML-DSA-44', pub: part(cose, -1) }

    return { alg, key: await crypto.subtle.importKey('jwk', jwk as JsonWebKey, 'ML-DSA-44', false, ['verify']), verify: 'ML-DSA-44' }
  }

  throw new Error('unsupported COSE key')
}

// A byte string of the COSE key, base64url as a JWK holds it, `length` bytes long when given.
function part(cose: CborMap, label: number, length?: number): string {
  const value = cose.get(label)

  if (!(value instanceof Uint8Array) || value.length === 0 || (length !== undefined && value.length !== length))
    throw new Error('invalid COSE key part')

  return Buffer.from(value).toString('base64url')
}

// An ES256 signature comes DER-encoded, SEQUENCE { INTEGER r, INTEGER s }, where Web Crypto takes r and s as two 32-byte halves.
function rawEcdsa(der: Uint8Array): Uint8Array<ArrayBuffer> {
  if (der[0] !== 0x30 || der[1] !== der.length - 2)
    throw new Error('invalid DER signature')

  const raw = new Uint8Array(64)
  const end = derInteger(der, derInteger(der, 2, raw, 0), raw, 32)

  if (end !== der.length)
    throw new Error('invalid DER signature')

  return raw
}

// Writes the DER integer at `offset` as the 32 bytes of `raw` from `at`, a shorter one padded and the zero byte that keeps a 32-byte one positive dropped, and answers where it ends.
function derInteger(der: Uint8Array, offset: number, raw: Uint8Array, at: number): number {
  const length = der[offset + 1]

  if (der[offset] !== 0x02 || length === undefined || length === 0 || length > 33 || offset + 2 + length > der.length)
    throw new Error('invalid DER integer')

  const end = offset + 2 + length
  let value = der.subarray(offset + 2, end)

  if (value.length === 33) {
    if (value[0] !== 0 || !(value[1]! & 0x80))
      throw new Error('invalid DER integer')

    value = value.subarray(1)
  }

  raw.set(value, at + 32 - value.length)

  return end
}

function fromBase64url(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !BASE64URL.test(value))
    throw new Error('not base64url')

  return new Uint8Array(Buffer.from(value, 'base64url'))
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}
