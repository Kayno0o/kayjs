import process from 'node:process'
import { KayError } from '../compiler/errors'
import { setStamper, STAMP_FIELD } from '../runtime/action'
import { prerendering } from '../runtime/html'
import { kayLog } from '../runtime/log'
import { WORK_SCRIPT } from '../runtime/swap'
import { nodeCrypto } from './builtins'
import { GENERATE_SECRET, MIN_SECRET_LENGTH, openWith, sameText, sealWith } from './seal'

const KEY_BYTES = 32

// What signs the stamps `minTime` reads and the links to private stored files, and seals the flash cookie: a key derived from the session's secret, else `secret` in the config or `KAY_SECRET`, else the preview one, which a CMS may also hold, else one of this process, which a restart changes, refusing what was signed before it.
// Derived, so it is neither the key of preview links nor that of the session cookie: what one signs never passes for the other's.
type StampSource = 'process' | 'preview' | 'config' | 'session'
// Each source takes over from the ones before it.
const SOURCES: StampSource[] = ['process', 'preview', 'config', 'session']
let secret: { key: Uint8Array, from: StampSource } = { key: crypto.getRandomValues(new Uint8Array(KEY_BYTES)), from: 'process' }
let warnOnProcessKey = false

export function useStampSecret(value: string, from: Exclude<StampSource, 'process'>): void {
  if (SOURCES.indexOf(from) >= SOURCES.indexOf(secret.from))
    secret = { key: new Uint8Array(nodeCrypto().hkdfSync('sha256', value, '', 'kay stamps', KEY_BYTES)), from }
}

// The app's own secret: `secret` in the config, else `KAY_SECRET`, an empty one counting as none in both. A short one is refused, as the session's is.
export function setupStampSecret(configured: string | undefined): void {
  const value = configured === undefined || configured === '' ? process.env.KAY_SECRET : configured

  if (value === undefined || value === '')
    return

  if (value.length < MIN_SECRET_LENGTH)
    throw new KayError('config-invalid', `kay: ${configured === undefined ? 'KAY_SECRET' : '`secret` in kay.config.ts'} is ${value.length} characters long: it signs form stamps, links to private files and the flash cookie, so it is at least ${MIN_SECRET_LENGTH} random characters; generate one with ${GENERATE_SECRET}`)

  useStampSecret(value, 'config')
}

// A production server says so the first time it signs with the process's own key, which no restart and no other replica shares.
export function warnOnStampKey(production: boolean): void {
  warnOnProcessKey = production
}

function stampKey(): Uint8Array {
  if (warnOnProcessKey && secret.from === 'process') {
    warnOnProcessKey = false
    kayLog('warn', 'links to private files, form stamps and the flash cookie are signed with a key of this process, as no secret is set: a restart refuses what was signed before it, and other replicas refuse it too; set KAY_SECRET (or `secret` in kay.config.ts), or give session() a secret')
  }

  return secret.key
}

// A key for `use` derived from the session's, the app's or the preview's secret, which every replica shares, or undefined while none is set.
export function sharedKey(use: string): Buffer | undefined {
  return secret.from === 'process' ? undefined : nodeCrypto().createHmac('sha256', secret.key).update(`kay-key\0${use}`).digest()
}

// The value a prerendered page holds in place of a stamp, with the action it is for: the server signs one each time it serves the page.
const STAMP_MARK = 'kay-stamp:'

// The same for a `proofOfWork` challenge, in the page's data script: the action, its difficulty and its `maxAge`.
export const WORK_MARK = 'kay-work:'
export const WORK_OPEN = `<script type="application/json" ${WORK_SCRIPT}>`

// A stamp's hole holds its action in the first group, the challenges script its JSON in the second, which holds no `<`, and a `workChallenge` field its mark in the third.
export const STAMP_HOLE = new RegExp(`name="${STAMP_FIELD}" value="${STAMP_MARK}([^"]*)"|${WORK_OPEN}([^<]*)</script>|data-kay-work="${WORK_MARK}([^"]*)"`, 'g')

// `use` keeps what one feature signs from passing for another's.
export function signText(use: string, text: string): string {
  return nodeCrypto().createHmac('sha256', stampKey()).update(`${use}\0${text}`).digest('base64url')
}

export function signedText(use: string, text: string, given: string): boolean {
  return sameText(given, signText(use, text))
}

function sealKey(use: string): Buffer {
  return nodeCrypto().createHmac('sha256', stampKey()).update(`kay-seal\0${use}`).digest()
}

// AES-256-GCM under a key of its own per `use`: what it seals can be neither read nor altered without the secret.
export function sealText(use: string, text: string): string {
  return sealWith(sealKey(use), text)
}

// The text `sealText` sealed for that `use`, or undefined for anything else, such as a value sealed before a restart changed the process's secret.
export function openText(use: string, sealed: string): string | undefined {
  return openWith([sealKey(use)], sealed)?.text
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

  return !signedText('kay-min-time', `${action}\0${time}`, given) ? undefined : Number.parseInt(time, 36)
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
