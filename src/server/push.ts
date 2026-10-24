import type { KayExtension } from '../config'
import type { Duration } from '../runtime/duration'
import type { VapidKeys } from './push-crypto'
import type { PushSubscriptionRecord } from './push-store'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { KayError } from '../compiler/errors'
import { durationSeconds } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { s } from '../runtime/schema'
import { ipVersion, isPublicAddress, resolveHost } from './address'
import { defineEnv } from './env'
import { MAX_TITLE, safeNotificationUrl } from './notifications'
import { encryptPayload, generateVapidKeys, MAX_PAYLOAD_BYTES, validVapidKeys, vapidAuthorization } from './push-crypto'
import { pushSettings, setPushSettings } from './push-settings'
import { pushStore } from './push-store'
import { onReload } from './reload'

export { pushesSettled } from './push-settings'
export type { PushStore, PushSubscriptionRecord } from './push-store'
export { memoryPush, sqlitePush } from './push-store'

export interface PushOptions {
  // The VAPID contact push services reach the site's operator by, a `mailto:` or https address. Defaults to the origin of `SITE_URL` when that is https.
  subject?: string | undefined
}

// What a person is shown: a notification the worker draws.
export interface PushMessage {
  // At most 200 characters, text.
  title: string
  // At most 500 characters, text.
  body?: string | undefined
  // Where a click goes: a path of the site (put under `base` by the worker) or an http(s) URL; any other is dropped with a warning.
  url?: string | undefined
  // A notification with the same tag replaces the one still shown.
  tag?: string | undefined
  // A path of the site or an http(s) URL of an image.
  icon?: string | undefined
}

export interface PushSendOptions {
  // How long a push service holds the message for a device that is offline, `'1d'` by default.
  ttl?: Duration | undefined
  urgency?: 'very-low' | 'low' | 'normal' | 'high' | undefined
  // A message with the same topic replaces one a push service still holds (1 to 32 characters of letters, digits, `-` and `_`).
  topic?: string | undefined
}

// How many devices a push reached (`sent`), how many subscriptions the push services said are gone and kay dropped (`dropped`), and how many failed for a reason that may pass (`failed`).
export interface PushResult {
  sent: number
  dropped: number
  failed: number
}

export const MAX_BODY = 500
const MAX_TAG = 64

export const MOST_DEVICES = 10
const MAX_ENDPOINT = 2000
const SUBJECT = /^(?:mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/
const BASE64URL = /^[\w-]+$/
const TOPIC = /^[\w-]{1,32}$/
const SEND_TIMEOUT_MS = 10_000
const DEFAULT_TTL = '1d'
const URGENCIES = new Set(['very-low', 'low', 'normal', 'high'])
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

const PUSH_ENV = s.Object({
  VAPID_PUBLIC_KEY: s.String({ requiredInProduction: true, description: 'the VAPID public key push services check a push against, a base64url P-256 point; `kay push keys` prints a pair' }),
  VAPID_PRIVATE_KEY: s.Secret({ minLength: 43, description: 'the VAPID private key signing pushes, base64url; `kay push keys` prints a pair' }),
})

// Lets the site push to the devices of the people who opted in: `sendPush` sends, an island's `webPush.subscribe()` opts in, `notify()` pushes beside the inbox, and kay's service worker shows the notification and opens its link on a click.
// The VAPID keys are read from `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (`kay push keys` prints a pair); outside production a pair is generated once into `.kay/vapid.json`.
export function push(options: PushOptions = {}): KayExtension {
  const { subject } = options

  if (subject !== undefined && (typeof subject !== 'string' || !SUBJECT.test(subject)))
    throw new KayError('config-invalid', `kay: push takes a subject such as 'mailto:ops@example.com' or an https address; got ${JSON.stringify(subject)}`)

  setPushSettings({ subject })

  return {
    name: 'kay/push',
    needsServer: true,
    env: PUSH_ENV,
    server: async () => (await import('./push-server')).pushServer(),
    commands: { 'push keys': `${import.meta.dir}/push-keys-command.ts` },
  }
}

let keys: Promise<VapidKeys> | undefined

onReload(() => {
  keys = undefined
})

// The VAPID pair: the environment's, else outside production one generated once into the git-ignored `.kay/vapid.json`. A production server without a valid pair stops.
export async function vapidKeys(): Promise<VapidKeys> {
  keys ??= loadKeys()

  try {
    return await keys
  }
  catch (error) {
    keys = undefined

    throw error
  }
}

// For a test: the pair `vapidKeys` answers, or undefined to read it again.
export function setVapidKeys(pair: VapidKeys | undefined): void {
  keys = pair === undefined ? undefined : Promise.resolve(pair)
}

async function loadKeys(): Promise<VapidKeys> {
  const env = defineEnv(PUSH_ENV)
  const pair = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }

  if (await validVapidKeys(pair))
    return pair

  if (process.env.NODE_ENV === 'production')
    throw new KayError('config-invalid', 'kay: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not a base64url P-256 key pair; `kay push keys` prints one')

  return devKeys()
}

async function devKeys(): Promise<VapidKeys> {
  const folder = join(process.cwd(), '.kay')
  const file = join(folder, 'vapid.json')

  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as VapidKeys

    if (await validVapidKeys(stored))
      return stored
  }
  catch {}

  const fresh = await generateVapidKeys()

  try {
    mkdirSync(folder, { recursive: true })
    writeFileSync(file, JSON.stringify(fresh), { mode: 0o600 })
  }
  catch {}

  return fresh
}

function subjectOf(): string {
  const configured = pushSettings()?.subject

  if (configured !== undefined)
    return configured

  const site = URL.parse(process.env.SITE_URL ?? '')

  if (site?.protocol === 'https:')
    return site.origin

  if (process.env.NODE_ENV === 'production')
    kayLog('warn', 'push() has no subject and SITE_URL is not an https address: pass push({ subject: \'mailto:you@example.com\' }) so push services can reach you')

  return site?.origin ?? 'mailto:push@localhost'
}

// The endpoint when it is somewhere a push service can be: https at a public address, or outside production an http(s) loopback one, which is how a test plays the push service. The browser chose it, so it must not lead the server into a private network.
export async function checkedEndpoint(endpoint: unknown, production = process.env.NODE_ENV === 'production'): Promise<string | undefined> {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT)
    return undefined

  const url = URL.parse(endpoint)

  if (url === null || url.username !== '' || url.password !== '' || url.hash !== '')
    return undefined

  if (!production && LOOPBACK.has(url.hostname) && (url.protocol === 'http:' || url.protocol === 'https:'))
    return endpoint

  if (url.protocol !== 'https:')
    return undefined

  const host = url.hostname.replace(/^\[|\]$/g, '')

  try {
    if (ipVersion(host) !== 0)
      return isPublicAddress(host) ? endpoint : undefined

    const answers = await resolveHost(host)

    return answers.length > 0 && answers.every(({ address }) => isPublicAddress(address)) ? endpoint : undefined
  }
  catch {
    return undefined
  }
}

function text(value: unknown, most: number, what: string): string | undefined {
  if (value === undefined)
    return undefined

  const trimmed = typeof value === 'string' ? value.replaceAll('\0', '').trim() : ''

  if (trimmed === '' || trimmed.length > most)
    throw new RangeError(`kay: a push ${what} is 1 to ${most} characters; got ${typeof value === 'string' ? `${trimmed.length} characters` : typeof value}`)

  return trimmed
}

function linked(value: unknown, what: string): string | undefined {
  if (value === undefined)
    return undefined

  const link = safeNotificationUrl(value)

  if (link === undefined)
    kayLog('warn', `sendPush() dropped the ${what} of a push: only a path of the site or an http(s) URL is linked`)

  return link
}

// The JSON the worker's `push` handler reads.
function payloadOf(message: PushMessage): Uint8Array<ArrayBuffer> {
  const title = text(message.title, MAX_TITLE, 'title')

  if (title === undefined)
    throw new RangeError('kay: a push needs a title')

  const body = text(message.body, MAX_BODY, 'body')
  const tag = text(message.tag, MAX_TAG, 'tag')
  const url = linked(message.url, 'url')
  const icon = linked(message.icon, 'icon')
  const bytes = new TextEncoder().encode(JSON.stringify({ title, ...body === undefined ? {} : { body }, ...url === undefined ? {} : { url }, ...tag === undefined ? {} : { tag }, ...icon === undefined ? {} : { icon } }))

  if (bytes.length > MAX_PAYLOAD_BYTES)
    throw new RangeError(`kay: a push payload is at most ${MAX_PAYLOAD_BYTES} bytes; got ${bytes.length}`)

  return bytes
}

type Outcome = 'sent' | 'dropped' | 'failed'

async function deliver(subscription: PushSubscriptionRecord, payload: Uint8Array<ArrayBuffer>, headers: Record<string, string>, pair: VapidKeys, subject: string): Promise<Outcome> {
  const endpoint = await checkedEndpoint(subscription.endpoint)

  if (endpoint === undefined) {
    await pushStore().remove(subscription.endpoint)

    return 'dropped'
  }

  try {
    const body = await encryptPayload(payload, subscription)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'authorization': await vapidAuthorization(endpoint, subject, pair), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })

    await response.body?.cancel()

    if (response.ok)
      return 'sent'

    if (response.status === 404 || response.status === 410) {
      await pushStore().remove(subscription.endpoint)

      return 'dropped'
    }

    kayLog('warn', `a push service (${new URL(endpoint).host}) answered ${response.status}`)

    return 'failed'
  }
  catch (error) {
    kayLog('warn', `a push to ${new URL(endpoint).host} failed`, error)

    return 'failed'
  }
}

// Sends a push to every device a person subscribed, encrypted for each, and answers how many it reached. A subscription its push service says is gone (404 or 410) is deleted. The person is whatever `userId` of `notify` names; one who never subscribed gets nothing and no error.
// Needs `push()` in the config's extensions. The message is a notification the worker draws; keep `url` a path of the site.
export async function sendPush(user: string, message: PushMessage, options: PushSendOptions = {}): Promise<PushResult> {
  if (pushSettings() === undefined)
    throw new KayError('config-invalid', 'kay: sendPush needs push() in the config\'s extensions')

  if (typeof user !== 'string' || user === '' || user.length > 200)
    throw new RangeError('kay: a push goes to a user id of 1 to 200 characters')

  const { ttl = DEFAULT_TTL, urgency, topic } = options

  if (urgency !== undefined && !URGENCIES.has(urgency))
    throw new RangeError(`kay: a push's urgency is very-low, low, normal or high; got ${JSON.stringify(urgency)}`)

  if (topic !== undefined && !TOPIC.test(topic))
    throw new RangeError('kay: a push topic is 1 to 32 characters of letters, digits, - and _')

  const payload = payloadOf(message)
  const subscriptions = await pushStore().list(user)
  const result: PushResult = { sent: 0, dropped: 0, failed: 0 }

  if (subscriptions.length === 0)
    return result

  const pair = await vapidKeys()
  const subject = subjectOf()
  const headers = { ttl: String(Math.round(durationSeconds(ttl, 'sendPush\'s ttl'))), ...urgency === undefined ? {} : { urgency }, ...topic === undefined ? {} : { topic } }

  for (const outcome of await Promise.all(subscriptions.map(async subscription => deliver(subscription, payload, headers, pair, subject))))
    result[outcome]++

  return result
}

// Checks a subscription a browser sent: its endpoint, public key and auth secret in the shapes Web Push defines.
export async function readSubscription(body: unknown): Promise<PushSubscriptionRecord | undefined> {
  if (typeof body !== 'object' || body === null)
    return undefined

  const { endpoint, keys: sent } = body as { endpoint?: unknown, keys?: { p256dh?: unknown, auth?: unknown } | null }
  const { p256dh, auth } = sent ?? {}
  const checked = await checkedEndpoint(endpoint)

  if (checked === undefined || typeof p256dh !== 'string' || typeof auth !== 'string' || !BASE64URL.test(p256dh) || !BASE64URL.test(auth))
    return undefined

  if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16)
    return undefined

  return { endpoint: checked, p256dh, auth, at: Date.now() }
}

// A person's push subscriptions, read and erased from the server: the function that erases a person on request ([Privacy](privacy.md)) calls `erase`.
export const pushSubscriptions = {
  async list(user: string): Promise<{ endpoint: string, at: number }[]> {
    return (await pushStore().list(user)).map(({ endpoint, at }) => ({ endpoint, at }))
  },
  async erase(user: string): Promise<number> {
    return pushStore().erase(user)
  },
}
