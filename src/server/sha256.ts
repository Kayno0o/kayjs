export interface Sha256Options {
  // How the digest is written, `'hex'` unless given.
  encoding?: 'hex' | 'base64' | 'base64url' | undefined
  // Keeps the first `length` characters of the digest.
  length?: number | undefined
  // Makes it an HMAC under this key; a plain digest while undefined.
  key?: string | Uint8Array | undefined
}

// The SHA-256 digest of `text`, plain or keyed, written as `encoding` and cut to `length` characters.
export function sha256(text: string, { encoding = 'hex', length, key }: Sha256Options = {}): string {
  const digest = (key === undefined ? new Bun.CryptoHasher('sha256') : new Bun.CryptoHasher('sha256', key)).update(text).digest(encoding)

  return length === undefined ? digest : digest.slice(0, length)
}
