import { appSecrets } from 'kay/library'

const OWN = /^<([\da-f-]{36})\.([\w-]{16})@[^>\s]+>$/i

function mac(secret: string, id: string): string {
  const key = new Bun.CryptoHasher('sha256', secret).update('kmail-message-id').digest()

  return new Bun.CryptoHasher('sha256', key).update(id).digest('base64url').slice(0, 16)
}

// The Message-ID of a mail this app sends: a random id and a keyed tag, so a delivery report can be told to answer a mail of this app. Without the app secret it is a plain id, and no report is believed.
export function messageId(domain: string): string {
  const id = crypto.randomUUID()
  const [secret] = appSecrets() ?? []

  return secret === undefined ? `<${id}@${domain}>` : `<${id}.${mac(secret, id)}@${domain}>`
}

// Whether the Message-ID was made by `messageId` with one of the app's secrets.
export function isOwnMessageId(value: string | undefined): boolean {
  const match = OWN.exec(value?.trim() ?? '')

  if (match === null)
    return false

  const [, id, tag] = match

  return (appSecrets() ?? []).some((secret) => {
    const expected = mac(secret, id!)

    return expected.length === tag!.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(tag!))
  })
}
