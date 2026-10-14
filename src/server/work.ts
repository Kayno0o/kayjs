import type { Action, ProofOfWorkRefusal, RateStore } from '../runtime/action'
import { isAction, workOf } from '../runtime/action'
import { nodeCrypto } from './builtins'
import { signedText, signText, WORK_MARK, WORK_OPEN } from './stamp'

const DIGITS = /^\d{1,10}$/
const MARK = new RegExp(`"${WORK_MARK}([^:"]*):(\\d+):(\\d+)"`, 'g')

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

// An action's challenge is bound to its URL; one `workChallenge` signs is bound to its scope and its difficulty, under another `use`, so neither passes for the other.
const ACTION_WORK = 'kay-proof-of-work'

export const SCOPED_WORK = 'kay-proof-of-work-scope'

// A challenge for `bound`, good for `maxAge` ms: the hash of a fresh salt and a number up to `difficulty`, which the browser finds by hashing every number from 0 up.
export function signChallenge(use: string, bound: string, difficulty: number, maxAge: number): string {
  const expires = (Date.now() + maxAge).toString(36)
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url')
  const hash = hashOf(salt + (crypto.getRandomValues(new Uint32Array(1))[0]! % (difficulty + 1)))

  return `${expires}.${salt}.${hash}.${difficulty.toString(36)}.${signText(use, `${bound}\0${expires}\0${salt}\0${hash}`)}`
}

// The challenge the forms posting to the action at `url` carry.
export function signWork(url: string, difficulty: number, maxAge: number): string {
  return signChallenge(ACTION_WORK, url, difficulty, maxAge)
}

// Why a solution to `bound`'s challenge does not pass, or undefined when it does: once, as `store` keeps it under `key` until its challenge expires. `boundTo` reads the challenge's difficulty, for a scope binding it too.
export async function challengeRefusal(use: string, boundTo: (difficulty: string) => string, solution: string | null | undefined, store: RateStore, key: string): Promise<ProofOfWorkRefusal | undefined> {
  if (solution === null || solution === undefined || solution === '')
    return 'missing'

  const [expires = '', salt = '', hash = '', difficulty = '', signed = '', number = ''] = solution.split('.')

  // A challenge signed before a restart changed the key is the most likely one to fail here.
  if (!signedText(use, `${boundTo(difficulty)}\0${expires}\0${salt}\0${hash}`, signed))
    return 'expired'

  const left = Number.parseInt(expires, 36) - Date.now()

  if (!(left > 0))
    return 'expired'

  if (!DIGITS.test(number) || hashOf(salt + number) !== hash)
    return 'wrong'

  return (await store.hit(`${key}\n${salt}`, left)).count > 1 ? 'wrong' : undefined
}

export async function workRefusal(url: string, solution: string | null, store: RateStore): Promise<ProofOfWorkRefusal | undefined> {
  return challengeRefusal(ACTION_WORK, () => url, solution, store, url)
}

// The challenges of the actions with `proofOfWork` a page's forms post to, which kay's script solves; a prerendered page holds a mark the server fills in per visit.
export function workScript(forms: Set<Action<never, unknown>>, prerendered: boolean): string {
  const challenges: Record<string, string> = {}

  for (const action of forms) {
    const work = isAction(action) ? proofOfWork(action) : undefined

    if (work)
      challenges[action.url] = prerendered ? `${WORK_MARK}${encodeURIComponent(action.url)}:${work.difficulty}:${work.maxAge}` : signWork(action.url, work.difficulty, work.maxAge)
  }

  return Object.keys(challenges).length === 0 ? '' : `${WORK_OPEN}${JSON.stringify(challenges).replaceAll('<', '\\u003c')}</script>`
}

// The challenges script of a prerendered page, given its JSON, with a fresh challenge for each mark it holds.
export function freshWork(challenges: string): string {
  return `${WORK_OPEN}${challenges.replace(MARK, (_, url: string, difficulty: string, maxAge: string) => JSON.stringify(signWork(decodeURIComponent(url), Number(difficulty), Number(maxAge))))}</script>`
}
