import type { ProofOfWorkRefusal, RateStore } from '../runtime/action'
import type { Duration } from '../runtime/duration'
import { KayError } from '../compiler/errors'
import { durationSeconds } from '../runtime/duration'
import { prerendering } from '../runtime/html'
import { memoryRates } from './protection'
import { WORK_MARK } from './stamp'
import { challengeRefusal, SCOPED_WORK, signChallenge } from './work'

const DAY = 86_400
const DEFAULT_DIFFICULTY = 100_000

export interface WorkChallengeOptions {
  // The highest number the browser may have to hash up to, 100,000 by default: half of it on average.
  difficulty?: number | undefined
  // How long the challenge stays good, a day by default.
  maxAge?: Duration | undefined
}

export interface VerifyWorkOptions {
  // The least difficulty a challenge must have been signed with, so one handed out before the scope asked for more does not pass.
  difficulty?: number | undefined
  // Where the solutions already used are kept until their challenge expires, this process's memory by default.
  store?: RateStore | undefined
}

// Each scope's solutions already used, when no store is given.
const memories = new Map<string, RateStore>()

function difficultyOf(difficulty: number | undefined): number {
  const value = difficulty ?? DEFAULT_DIFFICULTY

  if (!Number.isInteger(value) || value < 1 || value > 1e9)
    throw new KayError('config-invalid', `kay: a proof of work's difficulty is ${value}; it takes a whole number from 1 to 1,000,000,000`)

  return value
}

// A challenge bound to `scope` rather than to an action, for a library checking it in its own code: a form field carrying it as `data-kay-work` posts its solution, which `verifyWork` checks.
export function workChallenge(scope: string, options: WorkChallengeOptions = {}): string {
  const difficulty = difficultyOf(options.difficulty)
  const maxAge = durationSeconds(options.maxAge ?? DAY, 'workChallenge maxAge') * 1000

  // A prerendered page holds a mark the server signs a fresh challenge into on every visit.
  if (prerendering())
    return `${WORK_MARK}${encodeURIComponent(scope)}:${difficulty}:${maxAge}`

  return signChallenge(SCOPED_WORK, `${scope}\0${difficulty.toString(36)}`, difficulty, maxAge)
}

// Why a solution to a `workChallenge` of `scope` does not pass, or undefined when it does, once: `missing`, `expired` (past its `maxAge`, signed before a restart, for another scope or easier than `difficulty`) or `wrong`.
export async function verifyWork(solution: string | null | undefined, scope: string, options: VerifyWorkOptions = {}): Promise<ProofOfWorkRefusal | undefined> {
  const least = options.difficulty === undefined ? 1 : difficultyOf(options.difficulty)
  let store = options.store ?? memories.get(scope)

  if (!store)
    memories.set(scope, store = memoryRates())

  // One handed out before the scope asked for more is refused as stale, so the page signs a harder one.
  if (Number.parseInt(solution?.split('.')[3] ?? '', 36) < least)
    return 'expired'

  return challengeRefusal(SCOPED_WORK, difficulty => `${scope}\0${difficulty}`, solution, store, `\0${scope}`)
}

// The field a prerendered page is served with, its mark given as `<scope>:<difficulty>:<maxAge in ms>`.
export function freshFieldWork(mark: string): string {
  const [scope = '', difficulty = '', maxAge = ''] = mark.split(':')

  return `data-kay-work="${workChallenge(decodeURIComponent(scope), { difficulty: Number(difficulty), maxAge: `${Number(maxAge)}ms` })}"`
}
