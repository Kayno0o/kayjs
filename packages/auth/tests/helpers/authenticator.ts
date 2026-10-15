import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { Buffer } from 'node:buffer'
import { isoCBOR } from '@simplewebauthn/server/helpers'

const ORIGIN = 'https://site.test'
const USER_PRESENT = 0x01
const USER_VERIFIED = 0x04
const BACKUP_ELIGIBLE = 0x08
const BACKED_UP = 0x10
const ATTESTED = 0x40

interface Credential {
  id: string
  keys: CryptoKeyPair
  rpId: string
  userHandle: string
  counter: number
}

// A software authenticator holding ES256 passkeys, answering ceremonies as a browser would hand them to the server.
export function authenticator(options: { origin?: string, synced?: boolean } = {}) {
  const origin = options.origin ?? ORIGIN
  const credentials: Credential[] = []

  return {
    credentials,
    async create(request: PublicKeyCredentialCreationOptionsJSON, { userVerified = true } = {}): Promise<RegistrationResponseJSON> {
      const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
      const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
      const rpId = request.rp.id!
      const cose = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]])
      const rawId = Buffer.from(id, 'base64url')
      const authData = Buffer.concat([
        await rpIdHash(rpId),
        Buffer.from([flags(userVerified, options.synced) | ATTESTED]),
        counterBytes(0),
        Buffer.alloc(16),
        Buffer.from([rawId.length >> 8, rawId.length & 0xFF]),
        rawId,
        Buffer.from(isoCBOR.encode(cose)),
      ])
      const attestation = isoCBOR.encode(new Map<string, string | Map<string, never> | Uint8Array>([['fmt', 'none'], ['attStmt', new Map<string, never>()], ['authData', authData]]))

      credentials.push({ id, keys, rpId, userHandle: request.user.id, counter: 0 })

      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: clientData('webauthn.create', request.challenge, origin),
          attestationObject: Buffer.from(attestation).toString('base64url'),
          transports: ['internal'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      }
    },
    // Signs `request` with the credential it allows, or the first held; `counter` forces the signature counter, as a cloned authenticator would send.
    async get(request: PublicKeyCredentialRequestOptionsJSON, { userVerified = true, credential, counter, challenge }: { userVerified?: boolean, credential?: string, counter?: number, challenge?: string } = {}): Promise<AuthenticationResponseJSON> {
      const allowed = request.allowCredentials?.map(entry => entry.id) ?? []
      const held = credentials.find(entry => entry.id === credential || (credential === undefined && (allowed.length === 0 || allowed.includes(entry.id))))

      if (!held)
        throw new Error('no credential for this request')

      held.counter = counter ?? held.counter + 1

      const authData = Buffer.concat([await rpIdHash(held.rpId), Buffer.from([flags(userVerified, options.synced)]), counterBytes(held.counter)])
      const clientDataJSON = clientData('webauthn.get', challenge ?? request.challenge, origin)
      const signed = Buffer.concat([authData, Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(clientDataJSON, 'base64url')))])
      const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, held.keys.privateKey, signed))

      return {
        id: held.id,
        rawId: held.id,
        type: 'public-key',
        response: {
          clientDataJSON,
          authenticatorData: authData.toString('base64url'),
          signature: der(signature).toString('base64url'),
          userHandle: held.userHandle,
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      }
    },
  }
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

function clientData(type: string, challenge: string, origin: string): string {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString('base64url')
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
