import type { Action, ProofOfWorkRefusal, RateStore } from '../runtime/action'
import { isAction, workOf } from '../runtime/action'
import { WORK_SCRIPT } from '../runtime/swap'
import { nodeCrypto } from './builtins'
import { signedText, signText, WORK_MARK } from './stamp'

const DIGITS = /^\d{1,10}$/

// Each action's `proofOfWork`, read once: `action()` refused one it cannot read.
const works = new WeakMap<object, ReturnType<typeof workOf>>()

export function proofOfWork(action: Action<never, unknown>): ReturnType<typeof workOf> {
  const { protection } = action as { protection?: Parameters<typeof workOf>[0] }

  if (!protection)
    return undefined

  if (!works.has(protection))
    works.set(protection, workOf(protection))

  return works.get(protection)
}

function hashOf(text: string): string {
  return nodeCrypto().createHash('sha256').update(text).digest('hex')
}

function signature(url: string, expires: string, salt: string, hash: string): string {
  return signText('kay-proof-of-work', `${url}\0${expires}\0${salt}\0${hash}`)
}

// A challenge for the action at `url`, good for `maxAge` ms: the hash of a fresh salt and a number up to `difficulty`, which the browser finds by hashing every number from 0 up.
export function signWork(url: string, difficulty: number, maxAge: number): string {
  const expires = (Date.now() + maxAge).toString(36)
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url')
  const hash = hashOf(salt + (crypto.getRandomValues(new Uint32Array(1))[0]! % (difficulty + 1)))

  return `${expires}.${salt}.${hash}.${difficulty.toString(36)}.${signature(url, expires, salt, hash)}`
}

// Why a solution to the action at `url`'s challenge does not pass, or undefined when it does: once, as `store` keeps it until its challenge expires.
export async function workRefusal(url: string, solution: string | null, store: RateStore): Promise<ProofOfWorkRefusal | undefined> {
  if (solution === null || solution === '')
    return 'missing'

  const [expires = '', salt = '', hash = '', , signed = '', number = ''] = solution.split('.')

  // A challenge signed before a restart changed the key is the most likely one to fail here.
  if (!signedText('kay-proof-of-work', `${url}\0${expires}\0${salt}\0${hash}`, signed))
    return 'expired'

  const left = Number.parseInt(expires, 36) - Date.now()

  if (!(left > 0))
    return 'expired'

  if (!DIGITS.test(number) || hashOf(salt + number) !== hash)
    return 'wrong'

  return (await store.hit(`${url}\n${salt}`, left)).count > 1 ? 'wrong' : undefined
}

// The challenges of the actions with `proofOfWork` a page's forms post to, which kay's script solves; a prerendered page holds a mark the server fills in per visit.
export function workScript(forms: Set<Action<never, unknown>>, prerendered: boolean): string {
  const challenges: Record<string, string> = {}

  for (const action of forms) {
    const work = isAction(action) ? proofOfWork(action) : undefined

    if (work)
      challenges[action.url] = prerendered ? `${WORK_MARK}${encodeURIComponent(action.url)}:${work.difficulty}:${work.maxAge}` : signWork(action.url, work.difficulty, work.maxAge)
  }

  return Object.keys(challenges).length === 0 ? '' : `<script type="application/json" ${WORK_SCRIPT}>${JSON.stringify(challenges).replaceAll('<', '\\u003c')}</script>`
}

// A challenge for the mark a prerendered page holds, quoted as the script's JSON holds it.
export function freshWork(mark: string): string {
  const [url = '', difficulty = '', maxAge = ''] = mark.split(':')

  return JSON.stringify(signWork(decodeURIComponent(url), Number(difficulty), Number(maxAge)))
}
