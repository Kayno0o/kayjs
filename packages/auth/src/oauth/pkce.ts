import { Buffer } from 'node:buffer'
import { nanoid } from '@kaynooo/utils'

export interface PkcePair {
  verifier: string
  challenge: string
  method: 'S256'
}

/** Generates a PKCE verifier/challenge pair (RFC 7636, S256): keep `verifier` server-side, send `challenge` on authorize, replay `verifier` to `exchangeCode`. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = nanoid(64)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))

  return { verifier, challenge: Buffer.from(digest).toString('base64url'), method: 'S256' }
}
