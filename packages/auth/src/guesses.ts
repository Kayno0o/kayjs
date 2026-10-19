import type { RequestState } from './state'
import type { UserRecord } from './store'
import { comparePasswords, hashPassword } from '@kaynooo/utils'
import { afterResponse } from './events'
import { randomToken } from './keys'
import { notify } from './notify'

// The counts one password guess is held to: a hard stop for this client on this account, and a looser ceiling for the account from every client together.
export interface Guess {
  // Forgotten when the password proves right: this client's own failures and the guesses of this burst still in flight.
  keys: string[]
  // The wrong guesses of every client on the account, which a right password does not give back.
  failures: string
  window: number
}

const DAY = 24 * 60 * 60

// Counts a guess at an account's password before the password is checked, so a burst of parallel guesses cannot all pass a count that only a failure would raise; `forgive` takes it back once the password proves right.
// The hard stop is per client, so someone failing at an email cannot keep its holder out from another address. Without a record the count is kept against what was typed, so a missing account runs out the same way.
export async function startGuess(state: RequestState, record: UserRecord | undefined, typed: string): Promise<Guess | 'limited'> {
  const { core, client } = state
  const { attempts } = core.store
  const { max, window } = core.limits.signInAccountAll
  const account = record ? record.id : core.keys.fingerprint(typed.toLowerCase())
  // A record's id and a digest never share a prefix with the other, whatever the app's ids look like.
  const kind = record ? 'id' : 'typed'
  const hard = `sign-in-account:${kind}:${account}\n${client}`
  const pending = `sign-in-ceiling:${kind}:${account}`
  const failures = `sign-in-failures:${kind}:${account}`

  if (await attempts.hit(hard, core.limits.signInAccount.window) > core.limits.signInAccount.max)
    return 'limited'

  // `pending` is every guess since the last right password, so a burst in parallel stops at the ceiling; `failures` is what the ceiling is spent on.
  if (await attempts.hit(pending, window) > max || await attempts.count(failures) >= max) {
    if (record)
      await mailLockout(state, record)

    return 'limited'
  }

  return { keys: [hard, pending], failures, window }
}

// Counts a wrong password against the account's ceiling, which no right password gives back.
export async function failGuess(state: RequestState, guess: Guess): Promise<void> {
  await state.core.store.attempts.hit(guess.failures, guess.window)
}

// A right password costs this client and the burst in flight nothing: the guesses they hold are forgotten, but not the failures of other clients, so signing in does not hand an attacker a fresh ceiling.
export async function forgive(state: RequestState, guess: Guess): Promise<void> {
  for (const key of guess.keys)
    await state.core.store.attempts.reset(key)
}

// Mails the holder that signing in is paused, at most once a day however often the lockout comes back, so guessing cannot flood their inbox.
export async function mailLockout(state: RequestState, record: UserRecord): Promise<void> {
  if (await state.core.store.attempts.hit(`sign-in-locked-mail:${record.id}`, DAY) === 1)
    await afterResponse('reporting a sign-in lockout', async () => notify(state, record, 'sign-in-locked'))
}

let decoy: Promise<string> | undefined

// Spends as long on an account without a password as on a wrong one, so the time taken tells nothing either.
export async function passwordMatches(record: UserRecord | undefined, password: string): Promise<boolean> {
  if (record?.passwordHash != null && record.passwordHash !== '')
    return comparePasswords(password, record.passwordHash)

  decoy ??= hashPassword(randomToken())
  await comparePasswords(password, await decoy)

  return false
}
