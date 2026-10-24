import type { KeyObject } from 'node:crypto'
import type { Found } from './events'
import { createVerify, X509Certificate } from 'node:crypto'
import { normalizeAddress } from './list-address'

// Amazon SES delivers its events through an SNS topic subscribed to the app's endpoint. The message format and its signature are Amazon SNS's: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html

// The only place a signing certificate or a subscription is fetched from: https, the SNS endpoint of a region, no port, no login.
const SNS_HOST = /^sns\.[a-z\d-]+\.amazonaws\.com$/
const CERT_MAX = 16_384
const CERT_TTL = 24 * 3_600_000
const CERT_CACHE_MAX = 8
const FETCH_TIMEOUT = 5000
const TOPIC_ARN = /^arn:aws:sns:/
// The certificates SNS publishes are files of this name at the root, and a subscription is confirmed at the root with this action: nothing else of the host is fetched.
const CERT_PATH = /^\/SimpleNotificationService-[\w-]+\.pem$/

export function isSnsUrl(value: string): boolean {
  try {
    const url = new URL(value)

    return url.protocol === 'https:' && SNS_HOST.test(url.hostname) && url.port === '' && url.username === '' && url.password === ''
  }
  catch {
    return false
  }
}

// What the verification reaches out with. Tests swap both to serve a local certificate; nothing exports this to an app.
export const network = {
  fetch: async (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
  trusted: isSnsUrl,
  // A certificate that fails a check is fetched again once it is older than this, for a rotation, so a flood of bad posts cannot make a fetch each.
  refetchAfter: 60_000,
}

const certificateUrl = (value: string): boolean => network.trusted(value) && CERT_PATH.test(new URL(value).pathname) && new URL(value).search === ''
const subscriptionUrl = (value: string): boolean => network.trusted(value) && new URL(value).pathname === '/' && new URL(value).searchParams.get('Action') === 'ConfirmSubscription'

const NOTIFICATION = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const
const CONFIRMATION = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] as const
const FIELDS_OF: Record<string, readonly string[]> = { SubscriptionConfirmation: CONFIRMATION, UnsubscribeConfirmation: CONFIRMATION }

// The topic ARNs a secret allows, comma separated.
export function topicsOf(secret: string): string[] {
  return secret.split(',').map(topic => topic.trim()).filter(topic => TOPIC_ARN.test(topic))
}

// `Name\nValue\n` for each field in byte order, one ending the string; an absent `Subject` is left out.
export function stringToSign(message: Record<string, unknown>): string | undefined {
  const fields = message.Type === 'Notification' ? NOTIFICATION : FIELDS_OF[String(message.Type)]

  if (fields === undefined)
    return undefined

  let text = ''

  for (const field of fields) {
    const value = message[field]

    if (value === undefined && field === 'Subject')
      continue

    if (typeof value !== 'string')
      return undefined

    text += `${field}\n${value}\n`
  }

  return text
}

// SignatureVersion 1 is SHA1, 2 is SHA256.
const ALGORITHMS: Record<string, string> = { 1: 'RSA-SHA1', 2: 'RSA-SHA256' }

const certificates = new Map<string, { key: KeyObject, at: number }>()

// The body as text when it is no larger than the cap, read as it arrives.
async function boundedText(response: Response): Promise<string | undefined> {
  if (!response.ok || response.body === null || Number(response.headers.get('content-length') ?? 0) > CERT_MAX)
    return undefined

  const chunks: Uint8Array[] = []
  let total = 0

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length

    if (total > CERT_MAX)
      return undefined

    chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString('utf8')
}

// Requests for one certificate share a fetch, so a burst of posts makes one.
const fetching = new Map<string, Promise<{ key: KeyObject, fresh: boolean } | undefined>>()

async function certificateKey(url: string, forceFresh: boolean): Promise<{ key: KeyObject, fresh: boolean } | undefined> {
  const cached = certificates.get(url)

  if (cached !== undefined && !forceFresh && Date.now() - cached.at < CERT_TTL)
    return Promise.resolve({ key: cached.key, fresh: false })

  let pending = fetching.get(url)

  if (pending === undefined) {
    pending = (async () => {
      try {
        return await fetchCertificate(url)
      }
      finally {
        fetching.delete(url)
      }
    })()
    fetching.set(url, pending)
  }

  return pending
}

async function fetchCertificate(url: string): Promise<{ key: KeyObject, fresh: boolean } | undefined> {
  try {
    const response = await network.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), redirect: 'error' })
    const text = await boundedText(response)

    if (text === undefined || text === '')
      return undefined

    const certificate = new X509Certificate(text)

    if (Date.now() < Date.parse(certificate.validFrom) || Date.now() > Date.parse(certificate.validTo))
      return undefined

    certificates.delete(url)
    certificates.set(url, { key: certificate.publicKey, at: Date.now() })

    // Oldest first out: a Map keeps insertion order.
    for (const old of [...certificates.keys()].slice(0, Math.max(0, certificates.size - CERT_CACHE_MAX)))
      certificates.delete(old)

    return { key: certificate.publicKey, fresh: true }
  }
  catch {
    return undefined
  }
}

function signatureHolds(message: Record<string, unknown>, text: string, key: KeyObject): boolean {
  const algorithm = ALGORITHMS[String(message.SignatureVersion)]

  if (algorithm === undefined || typeof message.Signature !== 'string')
    return false

  try {
    return createVerify(algorithm).update(text, 'utf8').verify(key, message.Signature, 'base64')
  }
  catch {
    return false
  }
}

// Whether the message is signed by Amazon SNS: its certificate comes from an SNS endpoint over https, and the signature, version 1 (SHA1) or 2 (SHA256), covers the canonical string.
export async function snsSigned(message: Record<string, unknown>): Promise<boolean> {
  const text = stringToSign(message)
  const url = message.SigningCertURL

  if (text === undefined || typeof url !== 'string' || !certificateUrl(url))
    return false

  const first = await certificateKey(url, false)

  if (first === undefined)
    return false

  if (signatureHolds(message, text, first.key))
    return true

  // A certificate rotated since it was cached.
  const cached = certificates.get(url)

  if (first.fresh || cached === undefined || Date.now() - cached.at < network.refetchAfter)
    return false

  const again = await certificateKey(url, true)

  return again !== undefined && signatureHolds(message, text, again.key)
}

// Visiting the SubscribeURL confirms the subscription; it must be an SNS endpoint too.
export async function confirmSubscription(subscribeUrl: unknown): Promise<boolean> {
  if (typeof subscribeUrl !== 'string' || !subscriptionUrl(subscribeUrl))
    return false

  try {
    const response = await network.fetch(subscribeUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT), redirect: 'error' })

    return response.ok
  }
  catch {
    return false
  }
}

const recipientsOf = (list: unknown): unknown[] => Array.isArray(list) ? list.map(entry => (entry as { emailAddress?: unknown } | null)?.emailAddress) : []

// The `Message` of a notification is SES's own JSON: `notificationType` (or `eventType` with event publishing) `Bounce` with a `Permanent` bounce, or `Complaint`.
export function sesFound(text: unknown): Found[] {
  let event: { notificationType?: unknown, eventType?: unknown, bounce?: { bounceType?: unknown, bouncedRecipients?: unknown }, complaint?: { complainedRecipients?: unknown } } | null

  try {
    event = typeof text === 'string' ? JSON.parse(text) : undefined
  }
  catch {
    return []
  }

  const type = event?.notificationType ?? event?.eventType
  const found: Found[] = []

  if (type === 'Bounce' && event?.bounce?.bounceType === 'Permanent') {
    for (const address of recipientsOf(event.bounce.bouncedRecipients)) {
      const email = normalizeAddress(address)

      if (email !== undefined)
        found.push({ email, reason: 'bounce' })
    }
  }
  else if (type === 'Complaint') {
    for (const address of recipientsOf(event?.complaint?.complainedRecipients)) {
      const email = normalizeAddress(address)

      if (email !== undefined)
        found.push({ email, reason: 'complaint' })
    }
  }

  return found
}
