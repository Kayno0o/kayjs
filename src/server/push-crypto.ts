// Web Push on Web Crypto: the payload encryption of RFC 8291 (aes128gcm, RFC 8188) and the VAPID authorization of RFC 8292, with no dependency.

const encoder = new TextEncoder()
const RECORD_SIZE = 4096
const HEADER_SIZE = 16 + 4 + 1 + 65
const TAG_SIZE = 16

// What fits one record after the header, the padding delimiter and the tag.
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_SIZE - 1 - TAG_SIZE
const JWT_LIFETIME_SECONDS = 12 * 60 * 60

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(text, 'base64url'))
}

// A VAPID key pair as the environment holds it: the private scalar and the uncompressed public point, both base64url.
export interface VapidKeys {
  publicKey: string
  privateKey: string
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let at = 0

  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }

  return joined
}

function privateJwk(privateKey: string, publicKey: string): JsonWebKey {
  const point = fromBase64Url(publicKey)

  return { kty: 'EC', crv: 'P-256', d: privateKey, x: toBase64Url(point.slice(1, 33)), y: toBase64Url(point.slice(33, 65)) }
}

// A fresh P-256 pair, the thing `kay push keys` prints once for the environment.
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)

  return { privateKey: jwk.d!, publicKey: toBase64Url(concat(new Uint8Array([4]), fromBase64Url(jwk.x!), fromBase64Url(jwk.y!))) }
}

// Whether the pair is a P-256 key whose public point is the private scalar's.
export async function validVapidKeys(keys: VapidKeys): Promise<boolean> {
  try {
    if (fromBase64Url(keys.publicKey).length !== 65 || fromBase64Url(keys.privateKey).length !== 32)
      return false

    // Only the canonical spelling, so the key a browser is given is the one the pair signs with.
    if (toBase64Url(fromBase64Url(keys.publicKey)) !== keys.publicKey || toBase64Url(fromBase64Url(keys.privateKey)) !== keys.privateKey)
      return false

    const key = await crypto.subtle.importKey('jwk', privateJwk(keys.privateKey, keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(1))
    const verifier = await crypto.subtle.importKey('raw', fromBase64Url(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])

    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, signature, new Uint8Array(1))
  }
  catch {
    return false
  }
}

function jsonPart(value: object): string {
  return toBase64Url(encoder.encode(JSON.stringify(value)))
}

// The `Authorization` header of a push to `endpoint`: a JWT signed for the push service's origin, valid for 12 hours, and the public key it is checked with.
export async function vapidAuthorization(endpoint: string, subject: string, keys: VapidKeys, now = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateJwk(keys.privateKey, keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const unsigned = `${jsonPart({ typ: 'JWT', alg: 'ES256' })}.${jsonPart({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + JWT_LIFETIME_SECONDS, sub: subject })}`
  // Web Crypto answers ECDSA as r || s, the form a JWT wants.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned)))

  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${keys.publicKey}`
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, secret: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])

  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

export interface PushKeys {
  // The browser's public key (`p256dh`) and its auth secret, base64url.
  p256dh: string
  auth: string
}

// The sender's ephemeral pair and the salt, fixed by a test to reproduce RFC 8291's example; a push draws its own.
export interface EncryptionInputs {
  salt?: Uint8Array<ArrayBuffer>
  ephemeral?: VapidKeys
}

// The body of a push for the subscription holding `keys`: the salt, record size and sender key header, then the one encrypted record.
export async function encryptPayload(payload: Uint8Array<ArrayBuffer>, keys: PushKeys, inputs: EncryptionInputs = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (payload.length > MAX_PAYLOAD_BYTES)
    throw new RangeError(`kay: a push payload is at most ${MAX_PAYLOAD_BYTES} bytes; got ${payload.length}`)

  const browserPublic = fromBase64Url(keys.p256dh)
  const authSecret = fromBase64Url(keys.auth)

  if (browserPublic.length !== 65 || browserPublic[0] !== 4 || authSecret.length !== 16)
    throw new RangeError('kay: a push subscription needs a 65 byte p256dh key and a 16 byte auth secret')

  const ephemeral = inputs.ephemeral ?? await generateVapidKeys()
  const salt = inputs.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const senderPublic = fromBase64Url(ephemeral.publicKey)
  const sender = await crypto.subtle.importKey('jwk', privateJwk(ephemeral.privateKey, ephemeral.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const browser = await crypto.subtle.importKey('raw', browserPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: browser }, sender, 256))
  const secret = await hkdf(authSecret, shared, concat(encoder.encode('WebPush: info\0'), browserPublic, senderPublic), 32)
  const contentKey = await hkdf(salt, secret, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, secret, encoder.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt'])
  // 0x02 closes the last (here the only) record.
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))))
  const size = new Uint8Array(4)

  new DataView(size.buffer).setUint32(0, RECORD_SIZE)

  return concat(salt, size, new Uint8Array([senderPublic.length]), senderPublic, record)
}

// What a browser does on receiving a push body: the plaintext, or a throw when it was not encrypted for this subscription. Kept for tests reading what a mock push service got.
export async function decryptPayload(body: Uint8Array<ArrayBuffer>, browser: VapidKeys, authSecretText: string): Promise<Uint8Array<ArrayBuffer>> {
  const salt = body.slice(0, 16)
  const idLength = body[20]!
  const senderPublic = body.slice(21, 21 + idLength)
  const record = body.slice(21 + idLength)
  const authSecret = fromBase64Url(authSecretText)
  const browserPublic = fromBase64Url(browser.publicKey)
  const own = await crypto.subtle.importKey('jwk', privateJwk(browser.privateKey, browser.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const sender = await crypto.subtle.importKey('raw', senderPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, own, 256))
  const secret = await hkdf(authSecret, shared, concat(encoder.encode('WebPush: info\0'), browserPublic, senderPublic), 32)
  const contentKey = await hkdf(salt, secret, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, secret, encoder.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['decrypt'])
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, record))
  const end = plain.lastIndexOf(2)

  return plain.slice(0, end)
}
