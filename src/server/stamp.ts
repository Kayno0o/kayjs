import process from 'node:process'
import { KayError } from '../compiler/errors'
import { setStamper, STAMP_FIELD } from '../runtime/action'
import { prerendering } from '../runtime/html'
import { kayLog } from '../runtime/log'
import { WORK_SCRIPT } from '../runtime/swap'
import { nodeCrypto } from './builtins'
import { devSecret } from './dev-secret'
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

// What separates the secrets of a rotation list, in `secret` and in `KAY_SECRET`.
const SECRET_SEPARATOR = /\s*,\s*/
// The app's own secrets as `setupStampSecret` read them: `secret` in the config, else `KAY_SECRET`.
let configuredSecrets: string[] | undefined

function listed(value: string | string[] | undefined): string[] | undefined {
  const secrets = [value ?? []].flat().flatMap(text => text.trim().split(SECRET_SEPARATOR)).filter(text => text !== '')

  return secrets.length === 0 ? undefined : secrets
}

function refuseWeak(secrets: string[], where: string): void {
  const weak = secrets.find(secret => secret.length < MIN_SECRET_LENGTH)

  if (weak !== undefined)
    throw new KayError('config-invalid', `kay: ${where} holds a secret ${weak.length} characters long: the app's secret signs form stamps, links to private files and the flash cookie, and seals sessions, so each is at least ${MIN_SECRET_LENGTH} random characters, commas separating a rotation list; generate one with ${GENERATE_SECRET}`)
}

// The app's own secret: `secret` in the config, else `KAY_SECRET`, an empty one counting as none in both, and a list rotating: the first signs, every one opens. A short one is refused.
export function setupStampSecret(configured: string | string[] | undefined): void {
  const fromConfig = listed(configured)
  const secrets = fromConfig ?? listed(process.env.KAY_SECRET)

  configuredSecrets = secrets

  if (secrets === undefined)
    return

  refuseWeak(secrets, fromConfig === undefined ? 'KAY_SECRET' : '`secret` in kay.config.ts')
  useStampSecret(secrets[0]!, 'config')
}

// The secrets the app has for what it seals and signs: the config's or `KAY_SECRET`, else in development and under test one derived for this checkout, else none. Read anywhere, before the server set up too, as `KAY_SECRET` is in the environment from the start.
export function appSecrets(): string[] | undefined {
  if (configuredSecrets !== undefined)
    return configuredSecrets

  const fromEnv = listed(process.env.KAY_SECRET)

  if (fromEnv !== undefined) {
    refuseWeak(fromEnv, 'KAY_SECRET')

    return fromEnv
  }

  const mode = process.env.NODE_ENV

  return mode === 'development' || mode === 'test' ? [devSecret('KAY_SECRET')] : undefined
}

// What an app without any secret is told: where one goes.
export function noAppSecret(use: string): KayError {
  return new KayError('config-invalid', `kay: ${use} has no secret: set KAY_SECRET (or \`secret\` in kay.config.ts) to at least ${MIN_SECRET_LENGTH} random characters; generate one with ${GENERATE_SECRET}`)
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
  return secret.from === 'process' ? undefined : derivedKey('kay-key', use, secret.key)
}

// Derived once per secret and use, as each is signed or sealed many a request.
const derivedKeys = new Map<string, Buffer>()
let derivedFrom: Uint8Array | undefined

function derivedKey(kind: 'kay-key' | 'kay-seal', use: string, base: Uint8Array): Buffer {
  if (derivedFrom !== base) {
    derivedKeys.clear()
    derivedFrom = base
  }

  const label = `${kind}\0${use}`
  let key = derivedKeys.get(label)

  if (!key)
    derivedKeys.set(label, key = new Bun.CryptoHasher('sha256', base).update(label).digest())

  return key
}

// A digest of `text` for a store to count under, keyed by the shared secret so a copy of the store cannot be checked against a guessed address; a plain digest while none is set.
export function keyedDigest(use: string, text: string): string {
  const key = sharedKey(use)

  return (key === undefined ? new Bun.CryptoHasher('sha256') : new Bun.CryptoHasher('sha256', key)).update(text).digest('base64url').slice(0, 22)
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
  return new Bun.CryptoHasher('sha256', stampKey()).update(`${use}\0${text}`).digest('base64url')
}

export function signedText(use: string, text: string, given: string): boolean {
  return sameText(given, signText(use, text))
}

function sealKey(use: string): Buffer {
  return derivedKey('kay-seal', use, stampKey())
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
