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

  return { verifier, challenge: await challengeOf(verifier), method: 'S256' }
}

/** The S256 challenge of a verifier, to send the same one again for a flow in progress. */
export async function challengeOf(verifier: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url')
}
