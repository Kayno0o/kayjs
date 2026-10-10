import { setStamper } from '../runtime/action'
import { nodeCrypto } from './builtins'

// What signs the stamps `minTime` reads: the preview secret, else a session's, else one of this process, which a restart changes, refusing the forms loaded before it.
let secret: { key: string | Uint8Array, from: 'process' | 'session' | 'preview' } = { key: crypto.getRandomValues(new Uint8Array(32)), from: 'process' }

export function useStampSecret(key: string, from: 'session' | 'preview'): void {
  if (from === 'preview' || secret.from === 'process')
    secret = { key, from }
}

function signature(action: string, at: string): string {
  return nodeCrypto().createHmac('sha256', secret.key).update(`kay-min-time\0${action}\0${at}`).digest('base64url')
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
  const expected = signature(action, time)
  const a = Buffer.from(given)
  const b = Buffer.from(expected)

  if (a.length !== b.length || !nodeCrypto().timingSafeEqual(a, b))
    return undefined

  return Number.parseInt(time, 36)
}

setStamper((action, sent, maxAge) => {
  const time = stampTime(action, sent)

  return time === undefined || Date.now() - time > maxAge ? signStamp(action) : sent!
})
