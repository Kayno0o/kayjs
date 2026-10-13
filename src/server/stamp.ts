import { setStamper, STAMP_FIELD } from '../runtime/action'
import { prerendering } from '../runtime/html'
import { WORK_SCRIPT } from '../runtime/swap'
import { nodeCrypto } from './builtins'

// What signs the stamps `minTime` reads and the links to private stored files, and seals the flash cookie: the preview secret, else a session's, else one of this process, which a restart changes, refusing what was signed before it.
let secret: { key: string | Uint8Array, from: 'process' | 'session' | 'preview' } = { key: crypto.getRandomValues(new Uint8Array(32)), from: 'process' }

export function useStampSecret(key: string, from: 'session' | 'preview'): void {
  if (from === 'preview' || secret.from === 'process')
    secret = { key, from }
}

// The value a prerendered page holds in place of a stamp, with the action it is for: the server signs one each time it serves the page.
const STAMP_MARK = 'kay-stamp:'

// The same for a `proofOfWork` challenge, in the page's data script: the action, its difficulty and its `maxAge`.
export const WORK_MARK = 'kay-work:'
export const WORK_OPEN = `<script type="application/json" ${WORK_SCRIPT}>`

// A stamp's hole holds its action in the first group, the challenges script its JSON in the second, which holds no `<`: a page's own text cannot pass for either.
export const STAMP_HOLE = new RegExp(`name="${STAMP_FIELD}" value="${STAMP_MARK}([^"]*)"|${WORK_OPEN}([^<]*)</script>`, 'g')

// `use` keeps what one feature signs from passing for another's.
export function signText(use: string, text: string): string {
  return nodeCrypto().createHmac('sha256', secret.key).update(`${use}\0${text}`).digest('base64url')
}

export function signedText(use: string, text: string, given: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(signText(use, text))

  return a.length === b.length && nodeCrypto().timingSafeEqual(a, b)
}

const IV_BYTES = 12
const TAG_BYTES = 16

function sealKey(use: string): Buffer {
  return nodeCrypto().createHmac('sha256', secret.key).update(`kay-seal\0${use}`).digest()
}

// AES-256-GCM under a key of its own per `use`: what it seals can be neither read nor altered without the secret.
export function sealText(use: string, text: string): string {
  const { createCipheriv, randomBytes } = nodeCrypto()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', sealKey(use), iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])

  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url')
}

// The text `sealText` sealed for that `use`, or undefined for anything else, such as a value sealed before a restart changed the process's secret.
export function openText(use: string, sealed: string): string | undefined {
  const bytes = Buffer.from(sealed, 'base64url')

  if (bytes.length <= IV_BYTES + TAG_BYTES)
    return undefined

  try {
    const decipher = nodeCrypto().createDecipheriv('aes-256-gcm', sealKey(use), bytes.subarray(0, IV_BYTES))

    decipher.setAuthTag(bytes.subarray(-TAG_BYTES))

    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES, -TAG_BYTES)), decipher.final()]).toString('utf8')
  }
  catch {
    return undefined
  }
}

function signature(action: string, at: string): string {
  return signText('kay-min-time', `${action}\0${at}`)
}

// `<rendered at, base 36>.<signature>`, bound to the action so one form's stamp is no good for another.
export function signStamp(action: string, at = Date.now()): string {
  const time = at.toString(36)

  return `${time}.${signature(action, time)}`
}

// When the stamp says its form rendered, or undefined for one missing or forged.
export function stampTime(action: string, stamp: unknown): number | undefined {
  if (typeof stamp !== 'string')
    return undefined

  const [time = '', given = ''] = stamp.split('.')

  if (!signedText('kay-min-time', `${action}\0${time}`, given))
    return undefined

  return Number.parseInt(time, 36)
}

// The stamp field a prerendered page is served with, signed for this request.
export function freshStamp(action: string): string {
  return `name="${STAMP_FIELD}" value="${signStamp(action)}"`
}

setStamper((action, sent, maxAge) => {
  if (prerendering())
    return STAMP_MARK + encodeURIComponent(action)

  const time = stampTime(action, sent)

  return time === undefined || Date.now() - time > maxAge ? signStamp(action) : sent!
})
